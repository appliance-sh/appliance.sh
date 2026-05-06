import { createApplianceClient, DeploymentStatus, type Deployment } from '@appliance.sh/sdk';
import { mirrorImageToEcr } from './runtime/ecr-mirror';
import { inspectImageArch } from './runtime/container';
import { sleep } from './phases/helpers';
import type { BootstrapEvent } from './types';

// Mirrors phase 2's system-project layout — the api-server / api-worker
// system appliances live under `api/server` and `api/worker`. These
// constants must stay in lockstep with packages/bootstrap/src/phases/phase2.ts
// and api-server's deployment-executor.service.ts.
const SYSTEM_PROJECT = 'api';
const API_SERVER_ENV = 'server';
const WORKER_ENV = 'worker';

// Same Lambda runtime params phase 2 uses for the system appliances.
// Worker gets a long timeout because it executes Pulumi runs end-to-end;
// server only needs ~30s for HTTP requests.
const API_SERVER_MEMORY_MB = 2048;
const API_SERVER_STORAGE_MB = 4096;
const API_SERVER_TIMEOUT_S = 30;
const WORKER_MEMORY_MB = 2048;
const WORKER_STORAGE_MB = 4096;
const WORKER_TIMEOUT_S = 900;

const DEPLOY_POLL_MS = 5_000;
const DEPLOY_TIMEOUT_MS = 900_000;

const DEFAULT_IMAGE_BASE = 'ghcr.io/appliance-sh/api-server';

export interface ApiServerUpdateInput {
  apiServerUrl: string;
  apiKey: { id: string; secret: string };
  /** Target version, e.g. `"1.37.0"`. Combined with the image base to form the full image URI. */
  targetVersion: string;
  /**
   * Image base. Defaults to `ghcr.io/appliance-sh/api-server`. Override
   * to deploy from a fork or a self-hosted mirror — must speak the
   * Docker Registry v2 API and contain a tag matching `targetVersion`.
   */
  imageBase?: string;
  /** AWS profile to use for the ECR mirror. Same shape as bootstrap. */
  awsProfile?: string;
}

export interface ApiServerUpdateOptions {
  onEvent?: (event: BootstrapEvent) => void;
}

/**
 * Update the system api-server + api-worker Lambdas to a new image
 * version. Runs from the operator's machine because the mirror step
 * needs docker — the api-server itself can't pull/push images from
 * inside Lambda.
 *
 * Steps:
 *   1. Fetch cluster info (baseConfig + ECR repository URL).
 *   2. Mirror `<imageBase>:<targetVersion>` to the cluster ECR.
 *   3. Detect the image's architecture so the Lambda deploys with a
 *      matching `architectures` value.
 *   4. Create a remote-image Build pointing at the ECR digest.
 *   5. Refresh + deploy `api/worker` first (the order matters for
 *      the same reason phase 2 does — see phase2.ts).
 *   6. Refresh + deploy `api/server`.
 *
 * The api-server deployment endpoint dispatches the actual Pulumi run
 * to the worker, which calls UpdateFunctionCode against itself /
 * the server Lambda. AWS Lambda keeps the in-flight invocation alive
 * during code updates, so the worker finishes its own update cleanly;
 * the new image takes effect on the next invocation.
 */
export async function runApiServerUpdate(
  input: ApiServerUpdateInput,
  options: ApiServerUpdateOptions = {}
): Promise<void> {
  const emit = options.onEvent ?? (() => {});
  const imageBase = input.imageBase ?? DEFAULT_IMAGE_BASE;
  const sourceImage = `${imageBase}:${input.targetVersion}`;

  if (input.awsProfile) {
    process.env.AWS_PROFILE = input.awsProfile;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_SESSION_TOKEN;
  }

  const client = createApplianceClient({
    baseUrl: input.apiServerUrl,
    credentials: { keyId: input.apiKey.id, secret: input.apiKey.secret },
  });

  emit({ type: 'log', level: 'info', message: 'fetching cluster info…' });
  const infoResult = await client.getClusterInfo();
  if (!infoResult.success) {
    throw new Error(`getClusterInfo failed: ${infoResult.error.message}`);
  }
  const baseConfig = infoResult.data.baseConfig;
  if (!baseConfig.aws.ecrRepositoryUrl) {
    throw new Error('cluster baseConfig is missing ecrRepositoryUrl — cannot mirror new image');
  }
  if (!baseConfig.domainName) {
    throw new Error('cluster baseConfig is missing domainName — cannot derive WORKER_URL');
  }

  emit({ type: 'log', level: 'info', message: `mirroring ${sourceImage} → cluster ECR…` });
  const ecrImageUri = await mirrorImageToEcr({
    sourceImage,
    ecrRepositoryUrl: baseConfig.aws.ecrRepositoryUrl,
    tag: `api-server-${input.targetVersion}`,
    region: baseConfig.aws.region,
    emit,
  });
  emit({ type: 'log', level: 'info', message: `ECR image: ${ecrImageUri}` });

  // Inspect the locally-cached source image (mirrored above) to pin
  // the Lambda to a matching architecture. An arm64-only image deployed
  // to a default-x86_64 Lambda fails on first invoke with `exec
  // format error`.
  const imageArch = inspectImageArch(sourceImage);
  const lambdaArchitectures: Array<'x86_64' | 'arm64'> | undefined =
    imageArch === 'arm64' ? ['arm64'] : imageArch === 'amd64' ? ['x86_64'] : undefined;
  emit({
    type: 'log',
    level: 'info',
    message: `image arch: ${imageArch ?? 'unknown'} → Lambda architectures: ${lambdaArchitectures?.[0] ?? '(default)'}`,
  });

  emit({ type: 'log', level: 'info', message: 'registering build for new api-server image…' });
  const buildResult = await client.createBuild({ uploadUrl: ecrImageUri });
  if (!buildResult.success) {
    throw new Error(`createBuild failed: ${buildResult.error.message}`);
  }
  const buildId = buildResult.data.buildId;

  // Resolve api/worker and api/server env IDs by name. They were
  // created in phase 2; if they're missing we can't self-update —
  // bail with a clear error rather than guessing.
  const { workerEnvId, serverEnvId } = await resolveSystemEnvIds(client);

  // Same env-var layout phase 2 deploys with. Recomputed each update
  // to pick up any baseConfig changes (e.g. cluster ops added a new
  // optional field that the new api-server expects).
  const sharedEnv: Record<string, string> = {
    APPLIANCE_BASE_CONFIG: JSON.stringify(baseConfig),
    PULUMI_BACKEND_URL: baseConfig.stateBackendUrl,
  };
  const workerUrl = `https://${SYSTEM_PROJECT}-${WORKER_ENV}.${baseConfig.domainName}`;
  const serverEnvVars: Record<string, string> = {
    ...sharedEnv,
    APPLIANCE_MODE: 'server',
    APPLIANCE_TRUST_PROXY: 'true',
    WORKER_URL: workerUrl,
  };
  const workerEnvVars: Record<string, string> = {
    ...sharedEnv,
    APPLIANCE_MODE: 'worker',
  };

  // Worker first: the api-server dispatches deploys to the worker,
  // so a worker-incompatible api-server update would break us mid-run.
  // Refresh-then-deploy reconciles state with reality first — same
  // mitigation phase 2 added for the pulumi-aws@7.23 TagResource race.
  await refreshAndPoll(client, workerEnvId, `${SYSTEM_PROJECT}/${WORKER_ENV}`, emit);
  await deployAndPoll(
    client,
    workerEnvId,
    `${SYSTEM_PROJECT}/${WORKER_ENV}`,
    {
      buildId,
      environment: workerEnvVars,
      memory: WORKER_MEMORY_MB,
      timeout: WORKER_TIMEOUT_S,
      storage: WORKER_STORAGE_MB,
      architectures: lambdaArchitectures,
    },
    emit
  );

  await refreshAndPoll(client, serverEnvId, `${SYSTEM_PROJECT}/${API_SERVER_ENV}`, emit);
  await deployAndPoll(
    client,
    serverEnvId,
    `${SYSTEM_PROJECT}/${API_SERVER_ENV}`,
    {
      buildId,
      environment: serverEnvVars,
      memory: API_SERVER_MEMORY_MB,
      timeout: API_SERVER_TIMEOUT_S,
      storage: API_SERVER_STORAGE_MB,
      architectures: lambdaArchitectures,
    },
    emit
  );

  emit({ type: 'log', level: 'info', message: `update complete — running ${input.targetVersion}` });
}

async function resolveSystemEnvIds(
  client: ReturnType<typeof createApplianceClient>
): Promise<{ workerEnvId: string; serverEnvId: string }> {
  const projects = await client.listProjects();
  if (!projects.success) {
    throw new Error(`listProjects failed: ${projects.error.message}`);
  }
  const apiProject = projects.data.find((p) => p.name === SYSTEM_PROJECT);
  if (!apiProject) {
    throw new Error(
      `system project "${SYSTEM_PROJECT}" not found on this cluster. ` +
        `Was the cluster bootstrapped with phase 2? Self-update only works against clusters with deployed system appliances.`
    );
  }
  const envs = await client.listEnvironments(apiProject.id);
  if (!envs.success) {
    throw new Error(`listEnvironments failed: ${envs.error.message}`);
  }
  const worker = envs.data.find((e) => e.name === WORKER_ENV);
  const server = envs.data.find((e) => e.name === API_SERVER_ENV);
  if (!worker || !server) {
    throw new Error(`system envs missing on cluster: worker=${Boolean(worker)} server=${Boolean(server)}`);
  }
  return { workerEnvId: worker.id, serverEnvId: server.id };
}

async function refreshAndPoll(
  client: ReturnType<typeof createApplianceClient>,
  envId: string,
  label: string,
  emit: (e: BootstrapEvent) => void
): Promise<void> {
  emit({ type: 'log', level: 'info', message: `refreshing ${label} state…` });
  const result = await client.refresh(envId);
  if (!result.success) {
    throw new Error(`refresh(${label}) failed: ${result.error.message}`);
  }
  await pollDeployment(client, result.data.id, emit);
}

async function deployAndPoll(
  client: ReturnType<typeof createApplianceClient>,
  envId: string,
  label: string,
  opts: {
    buildId: string;
    environment: Record<string, string>;
    memory: number;
    timeout: number;
    storage: number;
    architectures?: Array<'x86_64' | 'arm64'>;
  },
  emit: (e: BootstrapEvent) => void
): Promise<void> {
  emit({ type: 'log', level: 'info', message: `deploying ${label}…` });
  const result = await client.deploy(envId, opts);
  if (!result.success) {
    throw new Error(`deploy(${label}) failed: ${result.error.message}`);
  }
  emit({ type: 'log', level: 'info', message: `waiting for ${label} deployment to settle…` });
  await pollDeployment(client, result.data.id, emit);
}

async function pollDeployment(
  client: ReturnType<typeof createApplianceClient>,
  deploymentId: string,
  emit: (e: BootstrapEvent) => void
): Promise<Deployment> {
  const deadline = Date.now() + DEPLOY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const r = await client.getDeployment(deploymentId);
    if (!r.success) {
      throw new Error(`getDeployment(${deploymentId}) failed: ${r.error.message}`);
    }
    if (isTerminal(r.data.status)) {
      if (r.data.status === DeploymentStatus.Succeeded) {
        emit({
          type: 'log',
          level: 'info',
          message: `deployment ${deploymentId} succeeded${r.data.idempotentNoop ? ' (no-op)' : ''}`,
        });
        return r.data;
      }
      throw new Error(`deployment ${deploymentId} ${r.data.status}: ${r.data.message ?? '<no message>'}`);
    }
    await sleep(DEPLOY_POLL_MS);
  }
  throw new Error(`deployment ${deploymentId} did not settle within ${DEPLOY_TIMEOUT_MS / 1000}s`);
}

function isTerminal(s: DeploymentStatus): boolean {
  return s === DeploymentStatus.Succeeded || s === DeploymentStatus.Failed || s === DeploymentStatus.Cancelled;
}

// Unused alias — left in place so the export shape mirrors
// runStatePromotion / runStateDemotion for consumers that import
// "Input"/"Options" generically.
export type RunApiServerUpdateInput = ApiServerUpdateInput;
export type RunApiServerUpdateOptions = ApiServerUpdateOptions;
