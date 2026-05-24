import {
  applianceBaseConfig,
  ApplianceBaseType,
  Deployment,
  DeploymentStatus,
  DeploymentAction,
  EnvironmentStatus,
  deploymentInput,
  z,
} from '@appliance.sh/sdk';
import {
  createApplianceDeploymentService,
  LocalContainerDeploymentService,
  type ApplianceStackMetadata,
  type PulumiStackHandle,
} from '@appliance.sh/infra';
import { getStorageService } from './storage.service';
import { environmentService } from './environment.service';
import { buildService, type ResolvedBuild } from './build.service';
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
    const baseConfigRaw = process.env.APPLIANCE_BASE_CONFIG;
    const baseConfig = baseConfigRaw ? applianceBaseConfig.parse(JSON.parse(baseConfigRaw)) : undefined;
    const onStack = (s: PulumiStackHandle) => {
      activeStack = s;
    };

    let result;
    if (baseConfig?.type === ApplianceBaseType.ApplianceLocal) {
      // Local k8s runtime — no Pulumi, no cancel-aware stack handle.
      // Build resolution still flows through buildService so the
      // upstream upload/remote-image distinction is preserved, but
      // the executor maps the resolved bits into LocalResolvedBuild
      // instead of the AWS-shaped ResolvedBuild.
      const local = new LocalContainerDeploymentService(baseConfig);
      result = await executeLocalAction(local, input, metadata, deployment.id);
    } else {
      const infraService = createApplianceDeploymentService();
      result = await executeCloudAction(infraService, input, metadata, deployment.id, onStack);
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
  const roles = parsed.aws?.systemRoleArns;
  if (!roles) return undefined;
  if (metadata.environmentName === SYSTEM_API_SERVER_ENV) return roles.apiServer;
  if (metadata.environmentName === SYSTEM_API_WORKER_ENV) return roles.worker;
  return undefined;
}

interface ExecutionResult {
  message: string;
  idempotentNoop: boolean;
}

async function executeCloudAction(
  infraService: ReturnType<typeof createApplianceDeploymentService>,
  input: WorkerEvent['input'],
  metadata: ApplianceStackMetadata,
  deploymentId: string,
  onStack: (s: PulumiStackHandle) => void
): Promise<ExecutionResult> {
  switch (input.action) {
    case DeploymentAction.Deploy: {
      const build = input.buildId
        ? await buildService.resolve(input.buildId, `${metadata.stackName}-${deploymentId}`)
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

      const result = await infraService.deploy(metadata.stackName, metadata, build, {
        onStack,
        refresh: input.refresh,
      });
      return { message: result.message, idempotentNoop: result.idempotentNoop };
    }
    case DeploymentAction.Destroy: {
      const result = await infraService.destroy(metadata.stackName, metadata.projectId, { onStack });
      return { message: result.message, idempotentNoop: result.idempotentNoop };
    }
    case DeploymentAction.Refresh: {
      const result = await infraService.refresh(metadata.stackName, metadata.projectId, { onStack });
      return { message: result.message, idempotentNoop: result.idempotentNoop };
    }
    default: {
      const _exhaustive: never = input.action;
      throw new Error(`Unknown deployment action: ${String(_exhaustive)}`);
    }
  }
}

async function executeLocalAction(
  local: LocalContainerDeploymentService,
  input: WorkerEvent['input'],
  metadata: ApplianceStackMetadata,
  deploymentId: string
): Promise<ExecutionResult> {
  switch (input.action) {
    case DeploymentAction.Deploy: {
      const build: ResolvedBuild | undefined = input.buildId
        ? await buildService.resolve(input.buildId, `${metadata.stackName}-${deploymentId}`)
        : undefined;
      if (!build?.imageUri) {
        throw new Error('Local deploys require a build with an imageUri (remote-image flow)');
      }
      const env = {
        ...(input.environment ?? {}),
        ...(build.environment ?? {}),
      };
      // Port precedence:
      //   1. Resolved build (set by the manifest path when the
      //      upload-zip flow lands locally — not the current
      //      remote-image short-circuit, but kept here for parity).
      //   2. `env.PORT` — by convention, container apps that read PORT
      //      from the environment also bind it as their listening port,
      //      so we lift it into the Service/containerPort so the
      //      NodePort exposes the right target.
      //   3. The Service falls back to 8080 inside renderManifest if
      //      nothing else is supplied.
      const envPort = env.PORT ? Number.parseInt(env.PORT, 10) : undefined;
      const port = build.localPort ?? (Number.isFinite(envPort) ? envPort : undefined);
      const result = await local.deploy(metadata.stackName, metadata, {
        imageUri: build.imageUri,
        port,
        environment: env,
      });
      return { message: result.message, idempotentNoop: result.idempotentNoop };
    }
    case DeploymentAction.Destroy: {
      const result = await local.destroy(metadata.stackName);
      return { message: result.message, idempotentNoop: result.idempotentNoop };
    }
    case DeploymentAction.Refresh: {
      const result = await local.refresh(metadata.stackName);
      return { message: result.message, idempotentNoop: result.idempotentNoop };
    }
    default: {
      const _exhaustive: never = input.action;
      throw new Error(`Unknown deployment action: ${String(_exhaustive)}`);
    }
  }
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
