import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { dnsName } from '@appliance.sh/sdk';
import { attachProfileOption } from './utils/profile-flag.js';
import { getActiveProfileOverride, setActiveProfileOverride } from './utils/credentials.js';
import { extractApplianceFile } from './utils/common.js';
import {
  DEFAULT_STACK_ENVIRONMENT,
  loadStack,
  resolveStackApps,
  STACK_FILENAME,
  type ResolvedStackApp,
} from './utils/stack.js';
import {
  deployStackApps,
  deployStackMember,
  manifestCommand,
  printSummary,
  requireClient,
  type StackDeployResult,
} from './utils/stack-deploy.js';
import { ensureServerRunning, SERVER_PROFILE, type ServerRuntime } from './utils/local-server.js';
import { createRebuildQueue, watchMember } from './utils/dev-watch.js';
import { LogMux } from './utils/log-mux.js';
import { BRAND } from './utils/progress.js';
import { isPrintedError } from './utils/deploy-core.js';
import { printCliError } from './utils/errors.js';

// `appliance dev` — the local dev loop, docker-compose-up feel with no
// Docker: bring the local server (and its microVM runtime) up, deploy
// the current app or stack, stream every member's logs merged and
// color-prefixed, and rebuild + redeploy a member when its files
// change. BuildKit's persistent cache makes a save-to-rollout loop a
// few seconds; an unchanged rebuild short-circuits as a no-op.
// Ctrl+C ends the session but leaves the apps running.

function exitWith(message: string): never {
  console.error(chalk.red(message));
  process.exit(1);
}

interface DevOptions {
  file?: string;
  runtime?: string;
  /** commander --no-logs / --no-watch land as logs/watch = false. */
  logs: boolean;
  watch: boolean;
}

function parseRuntime(value: string | undefined): ServerRuntime | undefined {
  if (value === undefined) return undefined;
  if (value !== 'vm' && value !== 'docker') {
    exitWith(`Invalid --runtime: ${value} (expected 'vm' or 'docker')`);
  }
  return value;
}

/** The stack members to run: the stack file when present, else the
 *  current directory's manifest as a synthetic one-member stack. */
async function resolveDevApps(
  environmentArg: string | undefined,
  fileOpt: string | undefined
): Promise<{ name: string; apps: ResolvedStackApp[]; isStack: boolean }> {
  const stackPath = fileOpt ? path.resolve(fileOpt) : path.join(process.cwd(), STACK_FILENAME);
  if (fs.existsSync(stackPath)) {
    const loaded = loadStack(fileOpt);
    return { name: loaded.stack.name, apps: resolveStackApps(loaded, environmentArg), isStack: true };
  }
  const manifest = await extractApplianceFile(manifestCommand());
  if (!manifest.success) {
    exitWith(
      `Nothing to run here: no ${STACK_FILENAME} and no appliance manifest (${manifest.error.message}).\n` +
        'Scaffold an app with `appliance configure`, or a stack with `appliance stack init`.'
    );
  }
  return {
    name: manifest.data.name,
    apps: [
      {
        dir: process.cwd(),
        relDir: manifest.data.name,
        environment: environmentArg ?? DEFAULT_STACK_ENVIRONMENT,
      },
    ],
    isStack: false,
  };
}

function printSessionFooter(result: StackDeployResult, teardownHint: string): void {
  console.log();
  console.log(`${chalk.cyan(BRAND)} dev session ended — apps are still running:`);
  for (const row of result.rows) {
    if (row.ok && row.url)
      console.log(`  ${chalk.green('✓')} ${row.app}  ${chalk.cyan(result.urls.get(row.app) ?? row.url)}`);
  }
  console.log(chalk.dim(`Tear down with \`${teardownHint}\`.`));
}

async function runDev(environmentArg: string | undefined, opts: DevOptions): Promise<void> {
  if (environmentArg !== undefined && !dnsName.safeParse(environmentArg).success) {
    exitWith(`Invalid environment name "${environmentArg}" — lowercase alphanumeric with hyphens, DNS-safe.`);
  }
  const runtime = parseRuntime(opts.runtime);
  const { name, apps, isStack } = await resolveDevApps(environmentArg, opts.file);

  console.log(
    `${chalk.cyan(BRAND)} ${chalk.bold('appliance dev')} — ${name} (${apps.length} app${apps.length === 1 ? '' : 's'})`
  );

  // Profile: `dev` owns the local server unless the caller pinned a
  // different profile — dev against the microvm or a cloud profile is
  // legitimate (any k8s base streams logs the same way); the server
  // auto-start only applies to the `local` one.
  const pinnedProfile = getActiveProfileOverride() ?? process.env.APPLIANCE_PROFILE;
  if (!pinnedProfile || pinnedProfile === SERVER_PROFILE) {
    await ensureServerRunning({ runtime, quiet: true });
    setActiveProfileOverride(SERVER_PROFILE);
  } else if (runtime) {
    console.log(chalk.dim(`--runtime is ignored with --profile ${pinnedProfile} (no local server to manage).`));
  }
  const { client, apiUrl } = requireClient();

  // Initial deploy — the exact `appliance stack deploy` engine.
  const result = await deployStackApps({ client, apiUrl, apps });
  printSummary(result.rows);
  if (result.failed) {
    const remaining = apps.length - result.rows.length;
    if (remaining > 0) {
      console.log(chalk.dim(`  (${remaining} app${remaining === 1 ? '' : 's'} not attempted after the failure)`));
    }
    process.exit(1);
  }

  const teardownHint = isStack
    ? `appliance stack destroy${environmentArg ? ` ${environmentArg}` : ''} --yes`
    : `appliance destroy`;

  if (!opts.logs && !opts.watch) {
    console.log(chalk.dim('(--no-logs and --no-watch — nothing to keep the session open; apps keep running)'));
    console.log(chalk.dim(`Tear down with \`${teardownHint}\`.`));
    return;
  }

  console.log();
  const activities = [opts.logs ? 'streaming logs' : null, opts.watch ? 'watching for changes' : null]
    .filter(Boolean)
    .join(' + ');
  console.log(chalk.dim(`${activities} — Ctrl+C ends the session (apps keep running)`));
  console.log();

  // Merged log streaming: every member's pods, color-prefixed.
  let mux: LogMux | null = null;
  if (opts.logs) {
    const padTo = Math.max(...apps.map((a) => a.relDir.length + 2), 5);
    mux = new LogMux(client, { padTo });
    for (const app of apps) {
      const outcome = result.outcomes.get(app.relDir);
      if (outcome) mux.add(app.relDir, outcome.environmentId);
    }
  }

  // Watch + rebuild: a member's save re-runs its exact stack deploy
  // (BuildKit cache → seconds; unchanged digest → idempotent no-op).
  const watchers: Array<{ close(): void }> = [];
  const queue = createRebuildQueue(async (relDir) => {
    const app = apps.find((a) => a.relDir === relDir);
    if (!app) return;
    console.log();
    console.log(chalk.bold(`${BRAND} rebuilding ${relDir}`) + chalk.dim(' (file change)'));
    try {
      const outcome = await deployStackMember({
        client,
        apiUrl,
        app,
        memberInfo: result.memberInfo,
        deployedUrls: result.urls,
      });
      if (outcome.url) result.urls.set(relDir, outcome.url);
    } catch (error) {
      if (!isPrintedError(error)) printCliError(error, { apiUrl });
      console.log(chalk.dim(`${relDir} redeploy failed — still watching; save again to retry.`));
    }
  });
  if (opts.watch) {
    for (const app of apps) {
      watchers.push(watchMember(app.dir, () => queue.notify(app.relDir)));
    }
  }

  let interrupted = false;
  process.on('SIGINT', () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    queue.close();
    for (const w of watchers) w.close();
    mux?.stop();
    printSessionFooter(result, teardownHint);
    process.exit(0);
  });
}

const program = new Command();

attachProfileOption(program);

program
  .name('appliance dev')
  .description('dev loop: deploy, stream logs, and rebuild on save (Ctrl+C leaves apps running)')
  .argument('[environment]', "environment for every app (default 'dev')")
  .option('-f, --file <path>', `stack file (default: ./${STACK_FILENAME}; falls back to the current app)`)
  .option('--runtime <runtime>', "local server runtime: 'vm' (microVM + BuildKit, no Docker; default) or 'docker'")
  .option('--no-logs', 'skip merged log streaming')
  .option('--no-watch', 'skip file watching / rebuild on save')
  .action(runDev);

program.parse(process.argv);
