import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as auto from '@pulumi/pulumi/automation';
import { applianceInfra, ApplianceBaseAwsPublic } from '@appliance.sh/infra';
import { VERSION } from '@appliance.sh/sdk';
import type { BootstrapEvent, BootstrapInput } from '../types';
import { awsCredsFromEnv, forwardPulumiEvent, homeEnv, sleep } from './helpers';

// Published by .github/workflows/release-api-server-image.yml on every
// version tag. Pinned to the SDK's VERSION so bootstrap installs a
// Lambda image that matches the Pulumi program + client shapes it's
// being deployed with. The caller can override via
// BootstrapInput.apiServerImageUri (e.g. a self-hosted ECR mirror or
// a feature-branch build).
const DEFAULT_API_SERVER_IMAGE = `ghcr.io/appliance-sh/api-server:${VERSION.replace(/^v/, '')}`;

export interface Phase2Options {
  cacheDir: string;
  stateBackendUrl: string;
  emit: (event: BootstrapEvent) => void;
}

export interface Phase2Output {
  apiServerUrl: string;
  apiKey: { id: string; secret: string };
}

const PROJECT_NAME = 'appliance-installer';
const STACK_NAME = 'bootstrap';
const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 2_000;

/**
 * Phase 2: hoist api-server into the installer stack.
 *
 * Runs `pulumi up` against the same `appliance-installer/bootstrap`
 * stack from phase 1, this time with `enableApiServer: true` so
 * applianceInfra() instantiates the ApplianceApiServer component
 * alongside the base. The state backend remains the local file
 * backend (phase 3 migrates to S3 later).
 *
 * After the stack update finishes it polls the api-server's
 * `/bootstrap/status` endpoint until the Lambda's cold start
 * completes, then POSTs `/bootstrap/create-key` with the freshly
 * generated bootstrap token to mint the installation's first API
 * key. The secret is returned to the driver for keychain storage.
 */
export async function runPhase2(input: BootstrapInput, opts: Phase2Options): Promise<Phase2Output> {
  const imageUri = input.apiServerImageUri ?? DEFAULT_API_SERVER_IMAGE;
  opts.emit({ type: 'log', level: 'info', message: `api-server image: ${imageUri}` });

  const bootstrapToken = crypto.randomBytes(32).toString('base64url');
  const workDir = path.join(opts.cacheDir, 'pulumi-workdir');
  const stateDir = path.join(opts.cacheDir, 'pulumi-state');
  const pulumiHome = path.join(opts.cacheDir, 'pulumi-home');
  fs.mkdirSync(workDir, { recursive: true });

  const region = input.base.config.region ?? 'us-east-1';

  const program = async () => {
    const out = await applianceInfra({
      bases: { [input.base.name]: input.base.config },
      enableApiServer: true,
      apiServerImageUri: imageUri,
      bootstrapToken,
    });
    const base = out.applianceBases[0];
    if (!(base instanceof ApplianceBaseAwsPublic)) {
      throw new Error('phase 2 only supports aws-public bases in v1');
    }
    const apiServer = out.apiServers[0];
    if (!apiServer) {
      throw new Error('phase 2 expected an api-server component to be instantiated');
    }
    return {
      stateBackendUrl: base.config.stateBackendUrl,
      apiServerUrl: apiServer.functionUrl,
    };
  };

  const stack = await auto.LocalWorkspace.createOrSelectStack(
    { projectName: PROJECT_NAME, stackName: STACK_NAME, program },
    {
      workDir,
      envVars: {
        PULUMI_BACKEND_URL: `file://${stateDir}`,
        PULUMI_HOME: pulumiHome,
        PULUMI_CONFIG_PASSPHRASE: process.env.PULUMI_CONFIG_PASSPHRASE ?? '',
        AWS_REGION: region,
        ...awsCredsFromEnv(),
        ...homeEnv(),
      },
    }
  );

  await stack.setConfig('aws:region', { value: region });

  const result = await stack.up({
    onEvent: (e) => forwardPulumiEvent(e, opts.emit),
    onOutput: (line) => opts.emit({ type: 'log', level: 'info', message: line.trimEnd() }),
  });

  if (result.summary.result !== 'succeeded') {
    throw new Error(`pulumi up failed: ${result.summary.result}`);
  }

  const outputs = await stack.outputs();
  const apiServerUrl = String(outputs.apiServerUrl?.value ?? '').replace(/\/$/, '');
  if (!apiServerUrl) {
    throw new Error('phase 2 succeeded but apiServerUrl output is missing');
  }

  opts.emit({ type: 'log', level: 'info', message: `waiting for ${apiServerUrl} to become healthy…` });
  await waitForApiServer(apiServerUrl, opts.emit);

  opts.emit({ type: 'log', level: 'info', message: 'creating first API key…' });
  const apiKey = await createFirstApiKey(apiServerUrl, bootstrapToken);

  return { apiServerUrl, apiKey };
}

/**
 * Poll /bootstrap/status until it responds with a parseable
 * `{ initialized: boolean }`. The api-server is a Lambda behind a
 * Function URL, so the first request after deploy can trigger a
 * cold start; 60s covers that plus container image pulls.
 */
async function waitForApiServer(baseUrl: string, emit: (e: BootstrapEvent) => void): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError: string | null = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/bootstrap/status`);
      if (r.ok) {
        const body = (await r.json().catch(() => null)) as { initialized?: boolean } | null;
        if (body && typeof body.initialized === 'boolean') return;
        lastError = `unexpected response shape from /bootstrap/status`;
      } else {
        lastError = `HTTP ${r.status}`;
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    await sleep(HEALTH_POLL_MS);
  }
  emit({ type: 'log', level: 'error', message: `health poll failed: ${lastError ?? 'timeout'}` });
  throw new Error(`api-server did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s`);
}

/**
 * Mint the first API key. Bootstrap-token auth is a single-use path
 * in spirit — after the first key exists, `/bootstrap/status` will
 * start reporting `initialized: true`, and subsequent API-key
 * creation goes through the authenticated `POST /api/v1/api-keys`
 * path (not yet implemented client-side).
 */
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
