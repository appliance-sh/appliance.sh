import * as fs from 'node:fs';
import * as path from 'node:path';
import * as auto from '@pulumi/pulumi/automation';
import type { BootstrapEvent } from '../types';
import { awsCredsFromEnv, homeEnv } from './helpers';

export interface Phase3Options {
  cacheDir: string;
  stateBackendUrl: string;
  emit: (event: BootstrapEvent) => void;
}

const PROJECT_NAME = 'appliance-installer';
const STACK_NAME = 'bootstrap';
// `exportStack` / `importStack` are state-only operations — the
// program passed to LocalWorkspace isn't invoked. A no-op keeps
// phase 3 independent of applianceInfra's required inputs (which
// would otherwise force us to carry `apiServerImageUri` + the
// bootstrap token across phases just to open the stack).
const trivialProgram = async () => ({});

/**
 * Phase 3: migrate the installer stack's state from the local file
 * backend (created in phase 1) to the S3 state bucket the base
 * provisioned. After this the installation is no longer tied to
 * the laptop that bootstrapped it — any machine with the right
 * AWS creds + pinned `@appliance.sh/bootstrap` version can resume
 * operating on the stack.
 *
 * Steps:
 *   1. exportStack from the local-backend workspace → Deployment
 *      (an opaque JSON blob Pulumi produces; contains resources,
 *      config refs, secrets).
 *   2. createOrSelect the same project+stack on a fresh workspace
 *      pointed at `PULUMI_BACKEND_URL=<stateBackendUrl>`.
 *   3. importStack the exported Deployment.
 *   4. exportStack the S3-backed workspace and compare resource
 *      counts for parity.
 *   5. Rename local state dir with a `.bak-<ts>` suffix — archived,
 *      not deleted, so the operation is reversible.
 *   6. Write `<cacheDir>/config.json` with the promoted backend
 *      URL + timestamp so future runs target S3 by default.
 *
 * Safety rails:
 *   - Local state is preserved until step 5, which runs only after
 *     the S3 import + parity check succeed. Any earlier failure
 *     leaves the original installation reachable via phase 1's
 *     local workspace — retry is idempotent.
 *   - The base's state bucket is created with `protect: true` and
 *     `forceDestroy: false` in ApplianceBaseAwsPublic, so a
 *     subsequent `pulumi destroy` of the installer stack cannot
 *     accidentally nuke the backing store the stack now lives on.
 */
export async function runPhase3(opts: Phase3Options): Promise<void> {
  const { cacheDir, stateBackendUrl, emit } = opts;

  if (!stateBackendUrl.startsWith('s3://')) {
    throw new Error(
      `phase 3 expects an s3:// state backend URL but got: ${stateBackendUrl || '<empty>'}. ` +
        `Has phase 1 run in this invocation? The URL comes from the base's stateBackendUrl output.`
    );
  }

  const localStateDir = path.join(cacheDir, 'pulumi-state');
  const localWorkDir = path.join(cacheDir, 'pulumi-workdir');
  const s3WorkDir = path.join(cacheDir, 'pulumi-workdir-s3');
  const pulumiHome = path.join(cacheDir, 'pulumi-home');

  if (!fs.existsSync(localStateDir)) {
    throw new Error(
      `phase 3 expects a local Pulumi state at ${localStateDir}; not found. ` +
        `Either phase 1 hasn't run, or state has already been promoted.`
    );
  }

  fs.mkdirSync(s3WorkDir, { recursive: true });

  // 1. Export from the local-backend workspace.
  emit({ type: 'log', level: 'info', message: 'exporting installer stack from local backend…' });
  const localStack = await auto.LocalWorkspace.createOrSelectStack(
    { projectName: PROJECT_NAME, stackName: STACK_NAME, program: trivialProgram },
    {
      workDir: localWorkDir,
      envVars: {
        PULUMI_BACKEND_URL: `file://${localStateDir}`,
        PULUMI_HOME: pulumiHome,
        PULUMI_CONFIG_PASSPHRASE: process.env.PULUMI_CONFIG_PASSPHRASE ?? '',
        ...awsCredsFromEnv(),
        ...homeEnv(),
      },
    }
  );
  const deployment = await localStack.exportStack();
  const localResources = countResources(deployment);
  emit({
    type: 'log',
    level: 'info',
    message: `exported ${localResources} resources from ${localStateDir}`,
  });

  // 2 + 3. Create or select the same stack against the S3 backend
  //        and import the deployment into it.
  emit({ type: 'log', level: 'info', message: `importing into ${stateBackendUrl}…` });
  const s3Stack = await auto.LocalWorkspace.createOrSelectStack(
    { projectName: PROJECT_NAME, stackName: STACK_NAME, program: trivialProgram },
    {
      workDir: s3WorkDir,
      envVars: {
        PULUMI_BACKEND_URL: stateBackendUrl,
        PULUMI_HOME: pulumiHome,
        PULUMI_CONFIG_PASSPHRASE: process.env.PULUMI_CONFIG_PASSPHRASE ?? '',
        ...awsCredsFromEnv(),
        ...homeEnv(),
      },
    }
  );
  await s3Stack.importStack(deployment);

  // 4. Verify by re-exporting from S3 and comparing resource counts.
  const verify = await s3Stack.exportStack();
  const remoteResources = countResources(verify);
  if (remoteResources !== localResources) {
    throw new Error(
      `state migration verification failed: local=${localResources} remote=${remoteResources}. ` +
        `Local state preserved at ${localStateDir}; retry phase 3 to diagnose.`
    );
  }
  emit({
    type: 'log',
    level: 'info',
    message: `verified — ${remoteResources} resources in ${stateBackendUrl}`,
  });

  // 5. Archive local state (don't delete — migration is reversible).
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archive = `${localStateDir}.bak-${timestamp}`;
  fs.renameSync(localStateDir, archive);
  emit({ type: 'log', level: 'info', message: `archived local state → ${archive}` });

  // 6. Drop a config marker so future runs know state lives in S3.
  const configPath = path.join(cacheDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        backend: stateBackendUrl,
        promotedAt: new Date().toISOString(),
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
  emit({ type: 'log', level: 'info', message: `wrote ${configPath}` });
}

function countResources(d: auto.Deployment): number {
  // Pulumi deployment shape: { version: number, deployment: { resources: [...] } }
  // `deployment` field is typed as `any` upstream; cast for property access.
  const inner = (d as unknown as { deployment?: { resources?: unknown[] } }).deployment;
  return inner?.resources?.length ?? 0;
}
