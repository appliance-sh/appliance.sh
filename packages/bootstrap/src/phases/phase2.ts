import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createApplianceClient,
  DeploymentStatus,
  VERSION,
  type ApplianceBaseConfig,
  type Deployment,
} from '@appliance.sh/sdk';
import type { BootstrapEvent, BootstrapInput } from '../types';
import { findFreePort, runDetached, type ContainerHandle } from '../runtime/container';
import { mirrorImageToEcr } from '../runtime/ecr-mirror';
import { sleep } from './helpers';

// Default api-server image. Pinned to the SDK's VERSION so bootstrap
// installs an image that matches the Pulumi program + client shapes
// it's being deployed with. The caller can override via
// BootstrapInput.apiServerImageUri (e.g. a self-hosted mirror or a
// feature-branch build).
const DEFAULT_API_SERVER_IMAGE = `ghcr.io/appliance-sh/api-server:${VERSION.replace(/^v/, '')}`;

// System project + env names. Must match
// deployment-executor.service.ts's SYSTEM_PROJECT / SYSTEM_API_SERVER_ENV
// / SYSTEM_API_WORKER_ENV — the executor uses those constants to
// decide when to bind the Lambda to the base-pre-created system roles.
const SYSTEM_PROJECT = 'api';
const API_SERVER_ENV = 'server';
const WORKER_ENV = 'worker';

// Lambda runtime params for the system api-server + worker. Mirrors
// packages/api-server/appliance.ts — the worker gets a long timeout
// because it executes Pulumi runs end-to-end; the server only needs
// it for short HTTP requests. The remote-image build flow doesn't
// carry manifest memory/timeout/storage, so we set them per-deploy.
const API_SERVER_MEMORY_MB = 2048;
const API_SERVER_STORAGE_MB = 4096;
const API_SERVER_TIMEOUT_S = 30;
const WORKER_MEMORY_MB = 2048;
const WORKER_STORAGE_MB = 4096;
const WORKER_TIMEOUT_S = 900;

const LOCAL_HEALTH_TIMEOUT_MS = 180_000;
const LOCAL_HEALTH_POLL_MS = 2_000;
const CLOUD_HEALTH_TIMEOUT_MS = 600_000;
const CLOUD_HEALTH_POLL_MS = 5_000;
const DEPLOY_POLL_MS = 5_000;
const DEPLOY_TIMEOUT_MS = 900_000;

export interface Phase2Options {
  cacheDir: string;
  baseConfig: ApplianceBaseConfig;
  emit: (event: BootstrapEvent) => void;
}

export interface Phase2Output {
  apiServerUrl: string;
  apiKey: { id: string; secret: string };
}

/**
 * Phase 2: dogfooded api-server bootstrap.
 *
 * Spawns the api-server image as a local container with the cluster's
 * S3 state bucket as its Pulumi backend, mints a first API key, then
 * uses the public deploy API to ship api-server + worker as ordinary
 * appliances on the cluster. Once both are reachable, the local
 * container is torn down. From this point, the cloud api-server runs
 * the data plane; further updates to it go through the same deploy
 * path users hit for any appliance (no "special" IaC for the control
 * plane).
 */
export async function runPhase2(input: BootstrapInput, opts: Phase2Options): Promise<Phase2Output> {
  const { baseConfig, emit } = opts;

  if (!baseConfig.aws.systemRoleArns) {
    throw new Error(
      'phase 2 requires base config with systemRoleArns. Re-run phase 1 against this branch ' +
        'to provision the pre-created system api-server / worker roles.'
    );
  }
  if (!baseConfig.aws.ecrRepositoryUrl) {
    throw new Error('phase 2 requires base config with ecrRepositoryUrl');
  }
  if (!baseConfig.domainName) {
    throw new Error('phase 2 requires base config with domainName');
  }

  const region = baseConfig.aws.region;
  const sourceImage = input.apiServerImageUri ?? DEFAULT_API_SERVER_IMAGE;
  const versionTag = VERSION.replace(/^v/, '');

  // The ECR mirror runs in the bootstrap process itself, so the AWS
  // SDK in this process needs the wizard-selected profile. Setting
  // process.env up front is the cheapest way; it also covers any
  // other AWS SDK calls phase 2 might make later (none today).
  if (input.aws?.profile) {
    process.env.AWS_PROFILE = input.aws.profile;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_SESSION_TOKEN;
  }

  emit({ type: 'log', level: 'info', message: `mirroring ${sourceImage} → cluster ECR…` });
  const ecrImageUri = await mirrorImageToEcr({
    sourceImage,
    ecrRepositoryUrl: baseConfig.aws.ecrRepositoryUrl,
    tag: `api-server-${versionTag}`,
    region,
    emit,
  });
  emit({ type: 'log', level: 'info', message: `ECR image: ${ecrImageUri}` });

  // Spawn the local api-server container. It uses the same image as
  // the cloud Lambdas — single artifact, one source of truth — but
  // talks to localhost rather than CloudFront. The Lambda Web Adapter
  // lets us run the Express app outside Lambda transparently.
  const localPort = await findFreePort();
  const bootstrapToken = crypto.randomBytes(32).toString('base64url');

  emit({ type: 'log', level: 'info', message: `starting local api-server on 127.0.0.1:${localPort}…` });

  // AWS auth into the container. With a wizard-supplied profile, we
  // mount the operator's ~/.aws read-only and force HOME=/root so the
  // SDK inside the container resolves the named profile + SSO token
  // cache the same way the host does. Without a profile we fall back
  // to forwarding access-key env vars from the operator's shell.
  const awsEnv: Record<string, string | undefined> = input.aws?.profile
    ? { AWS_PROFILE: input.aws.profile, HOME: '/root' }
    : {
        AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
        AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
        AWS_PROFILE: process.env.AWS_PROFILE,
      };
  const awsConfigDir = path.join(os.homedir(), '.aws');
  const volumes = input.aws?.profile ? [{ host: awsConfigDir, container: '/root/.aws', readOnly: true }] : undefined;

  const container = runDetached({
    image: sourceImage,
    // The api-server listens on PORT=3000 inside the image (set in
    // both the Dockerfile and main.ts's default). The Lambda Web
    // Adapter is inert outside Lambda — it only intercepts when
    // AWS_LAMBDA_RUNTIME_API is set — so we connect directly to the
    // Express server on 3000, not the LWA's typical 8080.
    port: { hostPort: localPort, containerPort: 3000 },
    volumes,
    env: {
      APPLIANCE_MODE: 'server',
      APPLIANCE_BASE_CONFIG: JSON.stringify(baseConfig),
      BOOTSTRAP_TOKEN: bootstrapToken,
      PULUMI_BACKEND_URL: baseConfig.stateBackendUrl,
      // New stacks initialise with an awskms:// secrets provider
      // (configured per-deploy by ApplianceDeploymentService). This
      // empty passphrase is a safety net for any code path that
      // momentarily defaults to the passphrase provider before the
      // KMS provider is read.
      PULUMI_CONFIG_PASSPHRASE: '',
      AWS_REGION: region,
      AWS_DEFAULT_REGION: region,
      ...awsEnv,
      // The local api-server runs Pulumi inline (no separate worker
      // container). Subsequent deploys after the cloud comes up use
      // the cloud worker via the WORKER_URL env we set below.
    },
  });
  const logsHandle = container.attachLogs(emit);

  try {
    const localBaseUrl = `http://127.0.0.1:${localPort}`;
    await waitForBootstrapStatus(localBaseUrl, LOCAL_HEALTH_TIMEOUT_MS, LOCAL_HEALTH_POLL_MS, emit);

    emit({ type: 'log', level: 'info', message: 'minting operator API key on local api-server…' });
    const operatorKey = await createFirstApiKey(localBaseUrl, bootstrapToken);

    const localClient = createApplianceClient({
      baseUrl: localBaseUrl,
      credentials: { keyId: operatorKey.id, secret: operatorKey.secret },
    });

    // Compute the cloud URLs up front. ApplianceStack creates a
    // CNAME at `<dnsLabel>.<domain>` per stack, where stack name is
    // `${projectName}-${envName}`. The api-server's CloudFront-fronted
    // URL is the api-server appliance's record; the worker's URL is
    // the matching worker record.
    const apiServerUrl = `https://${SYSTEM_PROJECT}-${API_SERVER_ENV}.${baseConfig.domainName}`;
    const workerUrl = `https://${SYSTEM_PROJECT}-${WORKER_ENV}.${baseConfig.domainName}`;

    emit({
      type: 'log',
      level: 'info',
      message: `creating ${SYSTEM_PROJECT} project + ${API_SERVER_ENV}/${WORKER_ENV} envs…`,
    });
    const project = await ensureSuccess(localClient.createProject({ name: SYSTEM_PROJECT }), 'createProject');
    const apiServerEnv = await ensureSuccess(
      localClient.createEnvironment({ projectId: project.id, name: API_SERVER_ENV }),
      'createEnvironment(api-server)'
    );
    const workerEnv = await ensureSuccess(
      localClient.createEnvironment({ projectId: project.id, name: WORKER_ENV }),
      'createEnvironment(worker)'
    );

    emit({ type: 'log', level: 'info', message: 'registering remote-image build for api-server appliances…' });
    const imageBuild = await ensureSuccess(
      localClient.createBuild({ uploadUrl: ecrImageUri }),
      'createBuild(remote-image)'
    );

    // Trust-proxy is required on the api-server appliance because
    // CloudFront's edge router rewrites Host to the Function URL's
    // hostname; the api-server reconstructs @authority for HTTP
    // Message Signature verification from X-Forwarded-Host. The
    // worker only sees server-to-server calls (no edge rewrite), so
    // it doesn't need it.
    const apiServerEnvVars: Record<string, string> = {
      APPLIANCE_MODE: 'server',
      APPLIANCE_TRUST_PROXY: 'true',
      WORKER_URL: workerUrl,
    };
    const workerEnvVars: Record<string, string> = {
      APPLIANCE_MODE: 'worker',
    };

    emit({ type: 'log', level: 'info', message: `deploying ${SYSTEM_PROJECT}/${API_SERVER_ENV}…` });
    const apiServerDeployment = await ensureSuccess(
      localClient.deploy(apiServerEnv.id, {
        buildId: imageBuild.buildId,
        environment: apiServerEnvVars,
        memory: API_SERVER_MEMORY_MB,
        timeout: API_SERVER_TIMEOUT_S,
        storage: API_SERVER_STORAGE_MB,
      }),
      'deploy(api-server)'
    );

    emit({ type: 'log', level: 'info', message: `deploying ${SYSTEM_PROJECT}/${WORKER_ENV}…` });
    const workerDeployment = await ensureSuccess(
      localClient.deploy(workerEnv.id, {
        buildId: imageBuild.buildId,
        environment: workerEnvVars,
        memory: WORKER_MEMORY_MB,
        timeout: WORKER_TIMEOUT_S,
        storage: WORKER_STORAGE_MB,
      }),
      'deploy(worker)'
    );

    emit({
      type: 'log',
      level: 'info',
      message: `waiting for ${SYSTEM_PROJECT}/${API_SERVER_ENV} deployment to settle…`,
    });
    await pollDeploymentToTerminal(localClient, apiServerDeployment.id, emit);

    emit({ type: 'log', level: 'info', message: `waiting for ${SYSTEM_PROJECT}/${WORKER_ENV} deployment to settle…` });
    await pollDeploymentToTerminal(localClient, workerDeployment.id, emit);

    emit({ type: 'log', level: 'info', message: `waiting for ${apiServerUrl} to come up…` });
    await waitForBootstrapStatus(apiServerUrl, CLOUD_HEALTH_TIMEOUT_MS, CLOUD_HEALTH_POLL_MS, emit);

    return { apiServerUrl, apiKey: operatorKey };
  } finally {
    logsHandle.stop();
    container.stop();
  }
}

async function waitForBootstrapStatus(
  baseUrl: string,
  timeoutMs: number,
  pollMs: number,
  emit: (e: BootstrapEvent) => void,
  containerOnFailure?: ContainerHandle
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | null = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/bootstrap/status`);
      if (r.ok) {
        const body = (await r.json().catch(() => null)) as { initialized?: boolean } | null;
        if (body && typeof body.initialized === 'boolean') return;
        lastError = 'unexpected response shape from /bootstrap/status';
      } else {
        lastError = `HTTP ${r.status}`;
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    await sleep(pollMs);
  }
  emit({ type: 'log', level: 'error', message: `health poll failed: ${lastError ?? 'timeout'}` });
  containerOnFailure?.stop();
  throw new Error(`${baseUrl} did not become healthy within ${timeoutMs / 1000}s`);
}

async function createFirstApiKey(baseUrl: string, token: string): Promise<{ id: string; secret: string }> {
  const r = await fetch(`${baseUrl}/bootstrap/create-key`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-bootstrap-token': token,
    },
    body: JSON.stringify({ name: 'bootstrap' }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`/bootstrap/create-key returned ${r.status}: ${body}`);
  }
  const body = (await r.json()) as { id?: string; secret?: string };
  if (!body.id || !body.secret) {
    throw new Error('/bootstrap/create-key returned unexpected shape (missing id/secret)');
  }
  return { id: body.id, secret: body.secret };
}

async function pollDeploymentToTerminal(
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

async function ensureSuccess<T>(
  promise: Promise<{ success: true; data: T } | { success: false; error: Error }>,
  op: string
): Promise<T> {
  const r = await promise;
  if (!r.success) {
    throw new Error(`${op} failed: ${r.error.message}`);
  }
  return r.data;
}
