import { Command } from 'commander';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import {
  apiServerUrlForHostPort,
  defaultLocalRuntimeDir,
  defaultProviders,
  deleteLocalCluster,
  ensureDockerRunning,
  ensureHelperBinOnPath,
  helperBinDir,
  localClusterStatus,
  runInstall,
  runStatus,
  startLocalCluster,
  stopLocalCluster,
  waitForApiServerUrl,
  bootstrapInClusterApiServer,
  DEFAULT_LOCAL_HOST_PORT,
} from '@appliance.sh/helper';
import type { LocalClusterStatus, ProgressEvent, StatusEntry } from '@appliance.sh/helper';
import { createApplianceClient } from '@appliance.sh/sdk';
import { saveCredentials } from './utils/credentials.js';
import { readProfiles } from './utils/profile-store.js';

ensureHelperBinOnPath();

// `appliance local` umbrella command. Diagnostics, first-run setup,
// and full lifecycle for the local k3d-backed runtime — what the
// desktop's Local Runtime page does in the GUI, exposed for CI /
// headless / power-user flows.

// Profile the local runtime's credentials are stored under. Matches
// the desktop's LOCAL_RUNTIME_CLUSTER_ID so both surfaces share one
// entry in ~/.appliance/profiles.json.
const LOCAL_RUNTIME_PROFILE = 'local-runtime';

const program = new Command();
program.description('manage the local k3d-backed runtime');

interface ClusterFlagOptions {
  clusterName?: string;
  hostPort?: number;
  registryPort?: number;
  dataDir?: string;
}

function attachClusterFlags(cmd: Command): Command {
  return cmd
    .option('--cluster-name <name>', 'k3d cluster name (default: appliance-local)')
    .option('--host-port <port>', 'host port the cluster LoadBalancer publishes (default: 8081)', parsePort)
    .option('--registry-port <port>', 'host port for the cluster-attached registry (default: 5050)', parsePort);
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${value}`);
  }
  return port;
}

// ---- status -----------------------------------------------------------

program
  .command('status')
  .alias('doctor')
  .description('check tools, the container runtime daemon, and the local cluster')
  .option('--cluster-name <name>', 'k3d cluster name (default: appliance-local)')
  .action(async (opts: { clusterName?: string }) => {
    const entries = await runStatus();
    printStatus(entries);

    const dockerEntry = entries.find((e) => e.provider.name === 'docker');
    const toolsReady = entries.every((e) => e.check.installed);
    const daemonDown = dockerEntry?.check.installed === true && dockerEntry.check.daemonRunning === false;

    // Cluster state only makes sense once k3d + a reachable daemon
    // exist; otherwise localClusterStatus would just repeat the same
    // error in a less actionable spot.
    console.log();
    if (toolsReady && !daemonDown) {
      const cluster = await localClusterStatus({ clusterName: opts.clusterName });
      printClusterStatus(cluster);
      if (cluster.running) {
        const apiUrl = apiServerUrlForHostPort(DEFAULT_LOCAL_HOST_PORT);
        const reachable = await probeApiServer(apiUrl);
        const marker = reachable ? chalk.green('●') : chalk.yellow('●');
        const note = reachable ? apiUrl : `not reachable at ${apiUrl} — run \`appliance local up\` to bootstrap it`;
        console.log(`${marker} ${chalk.bold('api-server')} ${chalk.dim(`— ${note}`)}`);
      }
      if (cluster.running) return;
      console.log();
      console.log(chalk.yellow('Run `appliance local up` to start the local runtime.'));
      process.exit(1);
    }

    const missing = entries.filter((e) => !e.check.installed);
    const autoCount = missing.filter((m) => m.provider.autoInstallable).length;
    if (autoCount > 0) {
      console.log(
        chalk.yellow(
          `${missing.length} of ${entries.length} tools missing. Run \`appliance local install\` to install ${autoCount} of them automatically.`
        )
      );
    } else if (missing.length > 0) {
      console.log(chalk.yellow(`${missing.length} of ${entries.length} tools missing. See the install hints above.`));
    } else if (daemonDown) {
      console.log(
        dockerEntry?.check.daemonStartable
          ? chalk.yellow('Docker daemon is not running. `appliance local up` will start colima automatically.')
          : chalk.yellow('Docker daemon is not running. Start your container runtime, then re-run this check.')
      );
    }
    process.exit(1);
  });

// ---- up ---------------------------------------------------------------

attachClusterFlags(
  program
    .command('up')
    .description('start the full local runtime: container runtime → k3d cluster → in-cluster api-server → login')
)
  .option(
    '--data-dir <path>',
    `host directory backing the runtime's persistent data (default: ${defaultLocalRuntimeDir()})`
  )
  .option('--image <ref>', 'override the in-cluster api-server image (forces a manifest re-apply)')
  .option('--no-install', 'fail instead of auto-installing missing tools (k3d, kubectl)')
  .action(async (opts: ClusterFlagOptions & { image?: string; install: boolean }) => {
    try {
      await runUp(opts);
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

async function runUp(opts: ClusterFlagOptions & { image?: string; install: boolean }): Promise<void> {
  // 1. Tooling preflight. docker can't be auto-installed — surface
  //    guidance and stop. k3d/kubectl install into ~/.appliance/bin.
  const entries = await runStatus();
  const docker = entries.find((e) => e.provider.name === 'docker');
  if (docker && !docker.check.installed) {
    printStatus([docker]);
    throw new Error('A container runtime is required. Install one (see above), then re-run `appliance local up`.');
  }
  const missingAuto = entries.filter((e) => !e.check.installed && e.provider.autoInstallable);
  if (missingAuto.length > 0) {
    const names = missingAuto.map((e) => e.provider.name);
    if (!opts.install) {
      throw new Error(`Missing tools: ${names.join(', ')}. Run \`appliance local install\` or drop --no-install.`);
    }
    console.log(chalk.cyan(`Installing missing tools: ${names.join(', ')}`));
    const outcomes = await runInstall({ tools: names, onProgress: printProgress });
    const failed = outcomes.filter((o) => o.status === 'failed');
    if (failed.length > 0) {
      throw new Error(`Install failed for ${failed.map((o) => o.provider.name).join(', ')}: ${failed[0].message}`);
    }
  }

  // 2. Cluster. Bring the runtime daemon up before reading cluster
  //    state — `k3d cluster list` can't see an existing cluster while
  //    the daemon is down, and a false "doesn't exist" here would
  //    skip the keep-existing-credentials path below.
  await ensureDockerRunning({ onProgress: printProgress });
  const dataDir = opts.dataDir ?? defaultLocalRuntimeDir();
  const preStatus = await localClusterStatus({ clusterName: opts.clusterName });
  const cluster = await startLocalCluster({
    clusterName: opts.clusterName,
    hostPort: opts.hostPort,
    registryPort: opts.registryPort,
    dataDir,
    onProgress: printProgress,
  });
  if (!cluster.running) {
    throw new Error(
      `cluster ${cluster.clusterName} did not reach running state${cluster.message ? `: ${cluster.message}` : ''}`
    );
  }
  console.log(`${chalk.green('✓')} cluster ${chalk.bold(cluster.clusterName)} running`);

  const hostPort = opts.hostPort ?? DEFAULT_LOCAL_HOST_PORT;
  const apiServerUrl = apiServerUrlForHostPort(hostPort);

  // 3. In-cluster api-server. When the cluster already existed and the
  //    stored profile still authenticates, skip the bootstrap — no new
  //    key, no manifest churn. An --image override always re-applies
  //    (that's the local-iteration path).
  if (preStatus.exists && !opts.image) {
    const verified = await verifyExistingProfile(apiServerUrl);
    if (verified) {
      console.log(`${chalk.green('✓')} api-server reachable at ${chalk.bold(apiServerUrl)}`);
      console.log(`${chalk.green('✓')} profile ${chalk.bold(LOCAL_RUNTIME_PROFILE)} already authenticated`);
      printUpSummary(apiServerUrl);
      return;
    }
  }
  const result = await bootstrapInClusterApiServer({
    runtime: {
      clusterName: opts.clusterName,
      hostPort: opts.hostPort,
      registryPort: opts.registryPort,
      dataDir,
    },
    image: opts.image,
    keyName: 'Local Runtime (cli)',
    onProgress: printProgress,
  });
  saveCredentials(
    { apiUrl: result.apiServerUrl, keyId: result.apiKey.id, secret: result.apiKey.secret },
    LOCAL_RUNTIME_PROFILE
  );
  console.log(`${chalk.green('✓')} api-server bootstrapped at ${chalk.bold(result.apiServerUrl)}`);
  console.log(`${chalk.green('✓')} credentials saved to profile ${chalk.bold(LOCAL_RUNTIME_PROFILE)}`);
  printUpSummary(result.apiServerUrl);
}

/**
 * True when a `local-runtime` profile exists and its key still
 * authenticates against the (already-reachable) api-server. A short
 * reachability wait covers the window where the cluster just
 * restarted and the api-server pod is still coming up.
 */
async function verifyExistingProfile(apiServerUrl: string): Promise<boolean> {
  const profile = readProfiles().profiles[LOCAL_RUNTIME_PROFILE];
  if (!profile) return false;
  try {
    await waitForApiServerUrl(apiServerUrl, 30_000);
  } catch {
    return false;
  }
  const client = createApplianceClient({
    baseUrl: apiServerUrl,
    credentials: { keyId: profile.keyId, secret: profile.secret },
  });
  const result = await client.listProjects();
  return result.success;
}

function printUpSummary(apiServerUrl: string): void {
  console.log();
  console.log(chalk.green('Local runtime is up.'));
  console.log(`  API server:  ${apiServerUrl}`);
  console.log(
    `  Profile:     ${LOCAL_RUNTIME_PROFILE}  (use \`--profile ${LOCAL_RUNTIME_PROFILE}\` or APPLIANCE_PROFILE)`
  );
  console.log(`  Deploy:      appliance deploy <project> <environment> --profile ${LOCAL_RUNTIME_PROFILE}`);
}

// ---- stop / delete ----------------------------------------------------

attachClusterFlags(program.command('stop').description('stop the local cluster without deleting its state')).action(
  async (opts: ClusterFlagOptions) => {
    try {
      const status = await stopLocalCluster({ clusterName: opts.clusterName });
      printClusterStatus(status);
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  }
);

program
  .command('delete')
  .description('permanently delete the local cluster and its registry (host data dir is preserved)')
  .option('--cluster-name <name>', 'k3d cluster name (default: appliance-local)')
  .option('--force', 'skip the confirmation prompt', false)
  .action(async (opts: { clusterName?: string; force: boolean }) => {
    try {
      if (!opts.force) {
        const ok = await confirm({
          message: 'Delete the local cluster? In-cluster state is destroyed (the host data dir is preserved).',
          default: false,
        });
        if (!ok) return;
      }
      const status = await deleteLocalCluster({ clusterName: opts.clusterName });
      console.log(`${chalk.green('✓')} cluster ${chalk.bold(status.clusterName)} deleted`);
      console.log(
        chalk.dim(
          'Persistent data under the data dir is preserved; `appliance local up` recreates the cluster around it.'
        )
      );
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

// ---- runtime ----------------------------------------------------------

const runtime = program.command('runtime').description('manage the container runtime daemon (colima auto-start)');

runtime
  .command('start')
  .description('start the container runtime if appliance can do so safely (colima only)')
  .action(async () => {
    try {
      await ensureDockerRunning({ onProgress: printProgress });
      console.log(chalk.green('Docker daemon is running.'));
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

// ---- install ----------------------------------------------------------

program
  .command('install')
  .description(`install missing prerequisites under ${helperBinDir()}`)
  .argument(
    '[tools...]',
    `tools to install (defaults to all required: ${defaultProviders
      .filter((p) => p.required)
      .map((p) => p.name)
      .join(', ')})`
  )
  .option('--force', 're-install even when already present', false)
  .option('--json', 'emit NDJSON progress + final result (one event per line) for tooling/IPC', false)
  .action(async (tools: string[], opts: { force: boolean; json: boolean }) => {
    try {
      await runWithLiveProgress(tools, opts);
    } catch (err) {
      reportError(err, opts.json);
    }
  });

// ---- update -----------------------------------------------------------

program
  .command('update')
  .description('re-install the latest helper-managed binaries (forces auto-installable tools)')
  .argument('[tools...]', 'tools to update (defaults to every auto-installable tool)')
  .option('--json', 'emit NDJSON progress + final result (one event per line) for tooling/IPC', false)
  .action(async (tools: string[], opts: { json: boolean }) => {
    const targets = tools.length > 0 ? tools : defaultProviders.filter((p) => p.autoInstallable).map((p) => p.name);
    try {
      await runWithLiveProgress(targets, { force: true, json: opts.json });
    } catch (err) {
      reportError(err, opts.json);
    }
  });

program.parse(process.argv);

// ---- helpers ----------------------------------------------------------

function printProgress(event: ProgressEvent): void {
  const prefix = event.type === 'error' ? chalk.red('✗') : event.type === 'done' ? chalk.green('✓') : chalk.cyan('»');
  console.log(`${prefix} ${chalk.dim(event.tool)} ${event.message}`);
}

function printClusterStatus(cluster: LocalClusterStatus): void {
  const marker = cluster.running ? chalk.green('●') : cluster.exists ? chalk.yellow('●') : chalk.red('●');
  const state = cluster.running ? 'running' : cluster.exists ? 'stopped' : 'not created';
  console.log(`${marker} ${chalk.bold(`cluster ${cluster.clusterName}`)} ${chalk.dim(`— ${state}`)}`);
  if (cluster.message) console.log(`    ${chalk.dim(cluster.message)}`);
}

async function probeApiServer(apiServerUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiServerUrl}/bootstrap/status`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

function printStatus(entries: StatusEntry[]): void {
  for (const { provider, check } of entries) {
    const daemonDown = check.installed && check.daemonRunning === false;
    const marker = !check.installed ? chalk.red('●') : daemonDown ? chalk.yellow('●') : chalk.green('●');
    const versionTail = check.version ? chalk.dim(` — ${check.version}`) : '';
    console.log(`${marker} ${chalk.bold(provider.name)}${versionTail}`);
    console.log(`    ${chalk.dim(provider.description)}`);
    if (daemonDown) {
      if (check.error) console.log(`    ${chalk.yellow(check.error)}`);
      if (check.daemonStartable) {
        console.log(`    ${chalk.bold('Start:')} ${chalk.cyan('appliance local runtime start')}`);
      }
      continue;
    }
    if (!check.installed) {
      if (check.error) console.log(`    ${chalk.dim(check.error)}`);
      if (provider.autoInstallable) {
        console.log(`    ${chalk.bold('Install:')} ${chalk.cyan(`appliance local install ${provider.name}`)}`);
      } else {
        // Detect-only providers (docker). Surface the upstream
        // install path so users have a copy-paste line for their
        // platform.
        const manual = provider.manualInstall({
          binDir: '',
          platform: process.platform as 'darwin' | 'linux' | 'win32',
          arch: (process.arch === 'arm64' ? 'arm64' : 'x64') as 'arm64' | 'x64',
        });
        for (const line of manual.instructions.split('\n')) {
          console.log(`    ${chalk.bold('Install:')} ${chalk.cyan(line)}`);
        }
        if (manual.url) console.log(`    ${chalk.dim(manual.url)}`);
      }
    }
  }
}

async function runWithLiveProgress(tools: string[], opts: { force: boolean; json: boolean }): Promise<void> {
  const targets = tools.length > 0 ? tools : undefined;
  const onProgress = (event: ProgressEvent) => {
    if (opts.json) {
      // Match the shape the desktop sidecar emits so the Rust-side
      // event channel can consume CLI-driven installs and sidecar-
      // driven installs interchangeably. `stage` carries the tool
      // name; `message` is the human-readable progress line.
      emitJson({ type: 'progress', stage: event.tool, message: event.message });
      return;
    }
    printProgress(event);
  };
  const outcomes = await runInstall({ tools: targets, force: opts.force, onProgress });

  if (opts.json) {
    emitJson({
      type: 'result',
      result: {
        outcomes: outcomes.map((o) => ({
          tool: o.provider.name,
          description: o.provider.description,
          autoInstallable: o.provider.autoInstallable,
          required: o.provider.required,
          status: o.status,
          message: o.message,
        })),
      },
    });
    if (outcomes.some((o) => o.status === 'failed')) process.exit(1);
    return;
  }

  console.log();
  let anyFailed = false;
  let anyGuidance = false;
  for (const o of outcomes) {
    const tag =
      o.status === 'installed'
        ? chalk.green('installed  ')
        : o.status === 'already'
          ? chalk.dim('already    ')
          : o.status === 'failed'
            ? chalk.red('failed     ')
            : chalk.yellow('manual     ');
    console.log(`${tag} ${chalk.bold(o.provider.name)}`);
    if (o.status !== 'already') {
      for (const line of o.message.split('\n')) {
        console.log(`    ${chalk.dim(line)}`);
      }
    }
    if (o.status === 'failed') anyFailed = true;
    if (o.status === 'guidance') anyGuidance = true;
  }

  if (anyGuidance) {
    console.log();
    console.log(
      chalk.yellow(
        'Some tools require a manual install (typically Docker). Follow the link above, then re-run `appliance local status`.'
      )
    );
  }
  if (anyFailed) {
    console.log();
    console.log(chalk.red('One or more installs failed. See the error above.'));
    process.exit(1);
  }
}

/** NDJSON emitter: one JSON object per line on stdout. */
function emitJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** Report a thrown error in the form matching `--json` (or plain text). */
function reportError(err: unknown, json: boolean): void {
  const message = err instanceof Error ? err.message : String(err);
  if (json) {
    emitJson({ type: 'error', error: message });
  } else {
    console.error(chalk.red(message));
  }
  process.exit(1);
}
