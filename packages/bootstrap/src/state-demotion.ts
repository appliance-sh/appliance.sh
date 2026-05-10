import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as auto from '@pulumi/pulumi/automation';
import { awsCredsFromEnv, homeEnv } from './phases/helpers';
import { verifyStateBackendUrl, type ClusterRef } from './cluster-verify';
import type { BootstrapEvent } from './types';

export interface StateDemotionInput {
  /**
   * S3 state backend URL the installer state currently lives in
   * (e.g. `s3://us-east-1-state-38038a5`). The user supplies this
   * in the Settings UI; we export the installer stack from it and
   * import into the local file backend at `<cacheDir>/pulumi-state`.
   */
  stateBackendUrl: string;
  /** AWS profile to use for the S3 read. Same shape as phase 3. */
  awsProfile?: string;
  /**
   * When provided, fetch the cluster's `/api/v1/cluster-info` and
   * assert that `stateBackendUrl` matches what the cluster reports
   * as canonical. Refuses to import state from a bucket the cluster
   * doesn't own — important here because demoting from an attacker-
   * controlled bucket would let them rewrite the operator's local
   * Pulumi state. Skipped silently if cluster-info is unreachable
   * (older api-server).
   */
  cluster?: ClusterRef;
}

export interface StateDemotionOptions {
  /**
   * Root cache directory the local file backend should land in.
   * Defaults to `~/.appliance` to match the bootstrap's default.
   */
  cacheDir?: string;
  onEvent?: (event: BootstrapEvent) => void;
}

const PROJECT_NAME = 'appliance-installer';
const STACK_NAME = 'bootstrap';
// `exportStack` / `importStack` are state-only operations — the
// program isn't invoked. A no-op program keeps demotion independent
// of applianceInfra's required inputs.
const trivialProgram = async () => ({});

/**
 * Inverse of phase 3: pull the installer stack's state out of the
 * cluster's S3 backend and back into a local file backend on this
 * device. After demotion the operator can run installer-stack
 * destroy / refresh / import operations from this machine without
 * needing the cluster's S3 creds for state access.
 *
 * Steps:
 *   1. exportStack from the S3-backed workspace → opaque Deployment.
 *   2. createOrSelect the same project+stack on a fresh local-backend
 *      workspace (`PULUMI_BACKEND_URL=file://<cacheDir>/pulumi-state`).
 *   3. importStack the deployment.
 *   4. exportStack from local and compare resource counts for parity.
 *   5. Remove `<cacheDir>/config.json` so future tooling treats
 *      local as the source of truth again.
 *
 * Safety rails:
 *   - Refuse to overwrite an existing `<cacheDir>/pulumi-state`. The
 *     operator must archive or remove it first; we don't want to
 *     silently merge two unrelated installations.
 *   - The S3 stack is left in place — demotion is reversible by
 *     re-running phase 3 (which uses `importStack`, overwriting the
 *     S3 stack with whatever local has). Operators who want to nuke
 *     the S3 copy outright can `pulumi stack rm` against it.
 */
export async function runStateDemotion(input: StateDemotionInput, options: StateDemotionOptions = {}): Promise<void> {
  const { stateBackendUrl, awsProfile } = input;
  const cacheDir = options.cacheDir ?? path.join(os.homedir(), '.appliance');
  const emit = options.onEvent ?? (() => {});

  if (!stateBackendUrl.startsWith('s3://')) {
    throw new Error(
      `state demotion expects an s3:// state backend URL but got: ${stateBackendUrl || '<empty>'}. ` +
        `Pass the cluster's stateBackendUrl as written by phase 1 (look for the bucket name in S3).`
    );
  }

  // Verify against the cluster's authoritative URL before touching
  // any filesystem state. Importing from a bucket the cluster doesn't
  // own would let an attacker overwrite the operator's local Pulumi
  // state; we'd rather fail loud than silently demote the wrong
  // installer.
  await verifyStateBackendUrl(stateBackendUrl, input.cluster, (level, message) =>
    emit({ type: 'log', level, message })
  );

  const localStateDir = path.join(cacheDir, 'pulumi-state');
  const localWorkDir = path.join(cacheDir, 'pulumi-workdir');
  const s3WorkDir = path.join(cacheDir, 'pulumi-workdir-s3');
  const pulumiHome = path.join(cacheDir, 'pulumi-home');

  if (fs.existsSync(localStateDir)) {
    throw new Error(
      `local state already exists at ${localStateDir}. Archive or remove it first ` +
        `(e.g. \`mv ${localStateDir} ${localStateDir}.bak\`) before demoting; we won't overwrite it.`
    );
  }

  fs.mkdirSync(localWorkDir, { recursive: true });
  // The Pulumi file backend at `file://<localStateDir>` requires the
  // directory to exist before `stack select` will open it. Phase 1
  // creates this on bootstrap; for demotion we have to mint it here
  // (the existence check above guarantees we're not clobbering an
  // unrelated install).
  fs.mkdirSync(localStateDir, { recursive: true });
  fs.mkdirSync(s3WorkDir, { recursive: true });
  fs.mkdirSync(pulumiHome, { recursive: true });

  // Common env vars for both workspaces.
  const baseEnv: Record<string, string> = {
    PULUMI_HOME: pulumiHome,
    PULUMI_CONFIG_PASSPHRASE: process.env.PULUMI_CONFIG_PASSPHRASE ?? '',
    ...awsCredsFromEnv(awsProfile),
    ...homeEnv(),
  };

  emit({ type: 'log', level: 'info', message: `exporting installer stack from ${stateBackendUrl}…` });
  const s3Stack = await auto.LocalWorkspace.createOrSelectStack(
    { projectName: PROJECT_NAME, stackName: STACK_NAME, program: trivialProgram },
    {
      workDir: s3WorkDir,
      envVars: { ...baseEnv, PULUMI_BACKEND_URL: stateBackendUrl },
    }
  );
  const deployment = await s3Stack.exportStack();
  const remoteResources = countResources(deployment);
  emit({
    type: 'log',
    level: 'info',
    message: `exported ${remoteResources} resources from ${stateBackendUrl}`,
  });

  emit({ type: 'log', level: 'info', message: `importing into ${localStateDir}…` });
  const localStack = await auto.LocalWorkspace.createOrSelectStack(
    { projectName: PROJECT_NAME, stackName: STACK_NAME, program: trivialProgram },
    {
      workDir: localWorkDir,
      envVars: { ...baseEnv, PULUMI_BACKEND_URL: `file://${localStateDir}` },
    }
  );
  await localStack.importStack(deployment);

  const verify = await localStack.exportStack();
  const localResources = countResources(verify);
  if (localResources !== remoteResources) {
    throw new Error(
      `state migration verification failed: remote=${remoteResources} local=${localResources}. ` +
        `S3 state is unchanged; remove the partial local state at ${localStateDir} and retry.`
    );
  }
  emit({
    type: 'log',
    level: 'info',
    message: `verified — ${localResources} resources in ${localStateDir}`,
  });

  // Drop the phase-3 marker so future bootstrap tooling treats
  // local as the source of truth.
  const configPath = path.join(cacheDir, 'config.json');
  if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath);
    emit({ type: 'log', level: 'info', message: `removed ${configPath}` });
  }

  emit({
    type: 'log',
    level: 'info',
    message:
      `note: S3 stack at ${stateBackendUrl} is retained as a backup. ` +
      `Re-run phase 3 (Detach state) to overwrite it, or remove with \`pulumi stack rm\` if you're done.`,
  });
}

function countResources(d: auto.Deployment): number {
  const inner = (d as unknown as { deployment?: { resources?: unknown[] } }).deployment;
  return inner?.resources?.length ?? 0;
}
