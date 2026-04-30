import {
  applianceBaseConfig,
  Deployment,
  DeploymentStatus,
  DeploymentAction,
  EnvironmentStatus,
  deploymentInput,
  z,
} from '@appliance.sh/sdk';
import {
  createApplianceDeploymentService,
  type ApplianceStackMetadata,
  type PulumiStackHandle,
} from '@appliance.sh/infra';
import { getStorageService } from './storage.service';
import { environmentService } from './environment.service';
import { buildService } from './build.service';
import { logger } from '../logger';

// Project + env name pair that triggers the dogfood role override.
// The cluster's base provisions two pre-existing Lambda roles
// (systemRoleArns.apiServer / systemRoleArns.worker) carrying broader
// IAM than ApplianceStack's per-appliance role grants. When a deploy
// targets one of these well-known names, the executor binds the
// resulting Lambda to the pre-existing role.
const SYSTEM_PROJECT = 'api';
const SYSTEM_API_SERVER_ENV = 'server';
const SYSTEM_API_WORKER_ENV = 'worker';

const COLLECTION = 'deployments';

// How often the executor checks storage for a Cancelling flag while
// a Pulumi op is running. 3s strikes a balance between cancellation
// latency and storage churn (S3 GET per tick).
const CANCEL_POLL_INTERVAL_MS = 3000;

// Annotated with z.ZodType<ApplianceStackMetadata> so the compiler flags
// drift if the infra-side interface changes shape.
const applianceStackMetadataSchema: z.ZodType<ApplianceStackMetadata> = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  environmentId: z.string().min(1),
  environmentName: z.string().min(1),
  deploymentId: z.string().min(1),
  stackName: z.string().min(1),
});

export const workerEventSchema = z.object({
  deploymentId: z.string().min(1),
  input: deploymentInput,
  metadata: applianceStackMetadataSchema,
  // Optional: env status to restore after a successful Refresh
  // action. Captured at dispatch time before the env is flipped to
  // Refreshing; absent for Deploy/Destroy actions which compute
  // their own terminal env status.
  priorEnvStatus: z.nativeEnum(EnvironmentStatus).optional(),
});

export type WorkerEvent = z.infer<typeof workerEventSchema>;

/**
 * Execute a deployment job: resolve build, run Pulumi, update status.
 * Idempotent: skips work if the deployment is not in Pending state.
 */
export async function executeDeployment(event: WorkerEvent): Promise<void> {
  const { deploymentId, input, metadata, priorEnvStatus } = event;
  const storage = getStorageService();

  const deployment = await storage.get<Deployment>(COLLECTION, deploymentId);
  if (!deployment) {
    throw new Error(`Deployment not found: ${deploymentId}`);
  }

  // Idempotency guard: only process pending deployments (handles retries)
  if (deployment.status !== DeploymentStatus.Pending) {
    logger.info('skipping non-pending deployment', { deploymentId, status: deployment.status });
    return;
  }

  deployment.status = DeploymentStatus.InProgress;
  await storage.set(COLLECTION, deployment.id, deployment);

  // Capture the live Pulumi Stack so the cancel poller can call
  // stack.cancel() out of band. Pulumi's stack.up()/destroy() reject
  // with a "canceled" error once cancel takes effect.
  let activeStack: PulumiStackHandle | null = null;
  let cancelObserved = false;
  const stopPolling = startCancelPoller(deploymentId, () => {
    cancelObserved = true;
    if (activeStack) {
      activeStack.cancel().catch((err) => {
        logger.error('stack.cancel failed', err, { deploymentId });
      });
    }
  });

  try {
    const infraService = createApplianceDeploymentService();
    const onStack = (s: PulumiStackHandle) => {
      activeStack = s;
    };

    let result;
    switch (input.action) {
      case DeploymentAction.Deploy: {
        const build = input.buildId
          ? await buildService.resolve(input.buildId, `${metadata.stackName}-${deployment.id}`)
          : undefined;

        if (build) {
          // Precedence: resolver env (build.environment — system
          // correctness, e.g. AWS_LWA_PORT) > deploy-time env
          // (input.environment, which the CLI populates from
          // manifest render + --env-file). Manifest env no longer
          // travels through the build artifact.
          build.environment = {
            ...(input.environment ?? {}),
            ...(build.environment ?? {}),
          };

          // Lambda runtime overrides flow the OPPOSITE way: deploy
          // input wins over the build resolver's default. The
          // remote-image flow doesn't carry manifest memory/timeout/
          // storage at all, so callers need a way to set them
          // per-deploy; the dogfooded bootstrap relies on this to
          // give the worker its 900s Pulumi-friendly timeout.
          if (input.memory !== undefined) build.memory = input.memory;
          if (input.timeout !== undefined) build.timeout = input.timeout;
          if (input.storage !== undefined) build.storage = input.storage;
          if (input.architectures !== undefined) build.architectures = input.architectures;

          const systemRoleArn = resolveSystemRoleArn(metadata);
          if (systemRoleArn) build.lambdaRoleArn = systemRoleArn;

          logger.info('resolved deploy params', {
            deploymentId,
            stackName: metadata.stackName,
            memory: build.memory,
            timeout: build.timeout,
            storage: build.storage,
            lambdaRoleArn: build.lambdaRoleArn,
            inputMemory: input.memory,
            inputTimeout: input.timeout,
            inputStorage: input.storage,
          });
        } else if (input.environment) {
          throw new Error('Environment variables require a build');
        }

        result = await infraService.deploy(metadata.stackName, metadata, build, { onStack });
        break;
      }
      case DeploymentAction.Destroy: {
        result = await infraService.destroy(metadata.stackName, metadata.projectId, { onStack });
        break;
      }
      case DeploymentAction.Refresh: {
        result = await infraService.refresh(metadata.stackName, metadata.projectId, { onStack });
        break;
      }
      default: {
        // Exhaustiveness check — unreachable if DeploymentAction is exhaustive.
        const _exhaustive: never = input.action;
        throw new Error(`Unknown deployment action: ${String(_exhaustive)}`);
      }
    }

    stopPolling();

    deployment.status = DeploymentStatus.Succeeded;
    deployment.completedAt = new Date().toISOString();
    deployment.message = result.message;
    deployment.idempotentNoop = result.idempotentNoop;
    await storage.set(COLLECTION, deployment.id, deployment);

    // Refresh restores whatever the env was before. Deploy/Destroy
    // settle to their canonical terminal status. Refresh fallback to
    // Deployed (when priorEnvStatus is missing — older worker events).
    const finalEnvStatus =
      input.action === DeploymentAction.Deploy
        ? EnvironmentStatus.Deployed
        : input.action === DeploymentAction.Destroy
          ? EnvironmentStatus.Destroyed
          : (priorEnvStatus ?? EnvironmentStatus.Deployed);
    await environmentService.updateStatus(metadata.environmentId, finalEnvStatus);

    logger.info('deployment succeeded', { deploymentId, action: input.action });
  } catch (error) {
    stopPolling();

    if (cancelObserved) {
      // Cancellation path: stack.up/destroy threw because we
      // called stack.cancel(). State is likely divergent from
      // reality (some resources changed, others didn't), so refresh
      // to pull live AWS state back into the Pulumi state file
      // before reporting the cancel as terminal.
      const refreshNote = await refreshAfterCancel(activeStack, deploymentId);
      deployment.status = DeploymentStatus.Cancelled;
      deployment.completedAt = new Date().toISOString();
      deployment.message = `Deployment cancelled. ${refreshNote}`;
      await storage.set(COLLECTION, deployment.id, deployment);
      // Environment status: Failed reflects "deploy didn't reach a
      // clean Deployed state" honestly. Operators reconcile from
      // there (re-deploy or destroy).
      await environmentService.updateStatus(metadata.environmentId, EnvironmentStatus.Failed);

      logger.info('deployment cancelled', { deploymentId, action: input.action });
      return;
    }

    deployment.status = DeploymentStatus.Failed;
    deployment.completedAt = new Date().toISOString();
    deployment.message = error instanceof Error ? error.message : String(error);
    await storage.set(COLLECTION, deployment.id, deployment);
    await environmentService.updateStatus(metadata.environmentId, EnvironmentStatus.Failed);

    logger.error('deployment failed', error, { deploymentId, action: input.action });
    throw error;
  }
}

/**
 * Start a background poller that flips a flag (and notifies the
 * caller) as soon as storage shows the deployment in Cancelling
 * state. Returns a stop function that the caller invokes once the
 * Pulumi op has settled (success, failure, or cancellation).
 */
function startCancelPoller(deploymentId: string, onCancelObserved: () => void): () => void {
  const storage = getStorageService();
  let stopped = false;
  let firedOnce = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const d = await storage.get<Deployment>(COLLECTION, deploymentId);
      if (!stopped && d?.status === DeploymentStatus.Cancelling && !firedOnce) {
        firedOnce = true;
        onCancelObserved();
      }
    } catch (err) {
      logger.warn('cancel poller read failed', { deploymentId, err: String(err) });
    }
  };

  const interval = setInterval(tick, CANCEL_POLL_INTERVAL_MS);
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

function resolveSystemRoleArn(metadata: ApplianceStackMetadata): string | undefined {
  if (metadata.projectName !== SYSTEM_PROJECT) return undefined;
  const raw = process.env.APPLIANCE_BASE_CONFIG;
  if (!raw) return undefined;
  let parsed;
  try {
    parsed = applianceBaseConfig.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
  const roles = parsed.aws.systemRoleArns;
  if (!roles) return undefined;
  if (metadata.environmentName === SYSTEM_API_SERVER_ENV) return roles.apiServer;
  if (metadata.environmentName === SYSTEM_API_WORKER_ENV) return roles.worker;
  return undefined;
}

async function refreshAfterCancel(stack: PulumiStackHandle | null, deploymentId: string): Promise<string> {
  if (!stack) return 'No live stack to refresh.';
  try {
    await stack.refresh({ onOutput: (m) => console.log(m) });
    return 'State refreshed.';
  } catch (err) {
    logger.error('post-cancel refresh failed', err, { deploymentId });
    return `Refresh failed: ${err instanceof Error ? err.message : String(err)}.`;
  }
}
