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
  type ContainerDeploymentBackend,
  type ApplianceStackMetadata,
  type PulumiStackHandle,
} from '@appliance.sh/infra';
import { getStorageService } from './storage.service';
import { environmentService } from './environment.service';
import { buildService, type ResolvedBuild } from './build.service';
import { readBaseConfig, resolveContainerBackend } from './deployment-backend';
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
    const baseConfig = readBaseConfig();
    const onStack = (s: PulumiStackHandle) => {
      activeStack = s;
    };

    // THE base fork, resolved in one place (deployment-backend.ts):
    // container-runtime bases get the cluster client (no Pulumi, no
    // cancel-aware stack handle — build resolution still flows through
    // buildService so the upload/remote-image distinction is
    // preserved); cloud bases run Pulumi.
    let result;
    const backend = resolveContainerBackend(baseConfig);
    if (backend) {
      result = await executeLocalAction(backend, input, metadata, deployment.id);
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
    // URL bookkeeping: Deploy sets it (when the executor knew one —
    // local always, cloud not yet); Destroy clears it; Refresh leaves
    // whatever was there.
    const urlUpdate =
      input.action === DeploymentAction.Deploy
        ? result.url
          ? { url: result.url }
          : undefined
        : input.action === DeploymentAction.Destroy
          ? { url: null }
          : undefined;
    await environmentService.updateStatus(metadata.environmentId, finalEnvStatus, urlUpdate);

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
  /**
   * URL where the appliance is reachable, when known. The executor
   * writes it onto the Environment record so consumers don't have to
   * scrape it out of `deployment.message`. Always undefined for
   * destroy/refresh; may be undefined for cloud deploys (no stack-
   * outputs plumbing yet).
   */
  url?: string;
}

/**
 * Surface build/deploy progress on the Deployment record — server-side
 * image builds can take minutes on a cold builder, and this message is
 * what the CLI's poll line and the console's status chip show.
 */
async function noteProgress(deploymentId: string, message: string): Promise<void> {
  const storage = getStorageService();
  try {
    const d = await storage.get<Deployment>(COLLECTION, deploymentId);
    if (d && d.status === DeploymentStatus.InProgress) {
      d.message = message;
      await storage.set(COLLECTION, d.id, d);
    }
  } catch (err) {
    logger.warn('progress note failed', { deploymentId, err: String(err) });
  }
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
      if (input.buildId) await noteProgress(deploymentId, 'Resolving build (building the image server-side)…');
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
      return { message: result.message, idempotentNoop: result.idempotentNoop, url: result.url };
    }
    case DeploymentAction.Destroy: {
      const result = await infraService.destroy(metadata.stackName, metadata.projectId, { onStack });
      return { message: result.message, idempotentNoop: result.idempotentNoop, url: result.url };
    }
    case DeploymentAction.Refresh: {
      const result = await infraService.refresh(metadata.stackName, metadata.projectId, { onStack });
      return { message: result.message, idempotentNoop: result.idempotentNoop, url: result.url };
    }
    default: {
      const _exhaustive: never = input.action;
      throw new Error(`Unknown deployment action: ${String(_exhaustive)}`);
    }
  }
}

async function executeLocalAction(
  local: ContainerDeploymentBackend,
  input: WorkerEvent['input'],
  metadata: ApplianceStackMetadata,
  deploymentId: string
): Promise<ExecutionResult> {
  switch (input.action) {
    case DeploymentAction.Deploy: {
      if (input.buildId) await noteProgress(deploymentId, 'Resolving build (building the image server-side)…');
      const build: ResolvedBuild | undefined = input.buildId
        ? await buildService.resolve(input.buildId, `${metadata.stackName}-${deploymentId}`)
        : undefined;

      // Resolve the image and env. Symmetry with the cloud path:
      //   * If buildId was supplied, the resolved build wins.
      //   * If not, fall back to the live Deployment's image so the
      //     bare "Deploy" button (Environment detail page, with no
      //     build attached) acts as a redeploy instead of erroring.
      //   * Likewise, when no env override is given, preserve the
      //     existing env so a redeploy doesn't strip PORT/etc.
      let imageUri = build?.imageUri;
      let env: Record<string, string> = {
        ...(input.environment ?? {}),
        ...(build?.environment ?? {}),
      };

      if (!imageUri) {
        imageUri = await local.getDeploymentImage(metadata.stackName);
        if (!imageUri) {
          throw new Error(
            "No image available for this environment. First-time deploys must specify a build — use the desktop's Deploy wizard, or `appliance deploy --image-uri <image>` from the CLI."
          );
        }
        if (Object.keys(env).length === 0) {
          env = (await local.getDeploymentEnv(metadata.stackName)) ?? {};
        }
      }

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
      const port = build?.localPort ?? (Number.isFinite(envPort) ? envPort : undefined);
      const result = await local.deploy(metadata.stackName, metadata, {
        imageUri,
        port,
        environment: env,
        // Omitted → the service preserves the live Deployment's scale,
        // so a bare redeploy doesn't reset a scaled environment to 1.
        replicas: input.replicas,
      });
      return { message: result.message, idempotentNoop: result.idempotentNoop, url: result.url };
    }
    case DeploymentAction.Destroy: {
      const result = await local.destroy(metadata.stackName);
      return { message: result.message, idempotentNoop: result.idempotentNoop, url: result.url };
    }
    case DeploymentAction.Refresh: {
      const result = await local.refresh(metadata.stackName);
      return { message: result.message, idempotentNoop: result.idempotentNoop, url: result.url };
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
