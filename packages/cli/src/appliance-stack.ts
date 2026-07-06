import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { confirm } from '@inquirer/prompts';
import { createApplianceClient, DeploymentStatus, dnsName } from '@appliance.sh/sdk';
import type { Deployment } from '@appliance.sh/sdk';
import chalk from 'chalk';
import { loadCredentials } from './utils/credentials.js';
import { attachProfileOption } from './utils/profile-flag.js';
import { extractApplianceFile, MANIFEST_FILENAMES, registerManifestOptions } from './utils/common.js';
import { DEFAULT_BUILD_OUTPUT, isPrintedError, runDeploy } from './utils/deploy-core.js';
import { loadStack, resolveStackApps, STACK_FILENAME, type ResolvedStackApp } from './utils/stack.js';
import { pollDeploymentUntilDone, urlsByEnvironment } from './utils/deploy-poll.js';
import { startProgressLine, BRAND } from './utils/progress.js';
import { printCliError } from './utils/errors.js';

// `appliance stack` — operate on a collection of appliances as a unit.
// A stack is a plain `appliance.stack.json` naming member app
// directories; every member still deploys as an ordinary project +
// environment on whichever api-server the active profile points at,
// so the same stack file drives the local microVM runtime and a cloud
// installation (switch with --profile / APPLIANCE_PROFILE).

function requireClient() {
  const credentials = loadCredentials();
  if (!credentials) {
    console.error(chalk.red('Not logged in — no credentials for the active profile.'));
    console.error(
      chalk.dim('Run `appliance login`, or start the local runtime with `appliance init` (which saves a profile).')
    );
    process.exit(1);
  }
  return {
    client: createApplianceClient({
      baseUrl: credentials.apiUrl,
      credentials: { keyId: credentials.keyId, secret: credentials.secret },
    }),
    apiUrl: credentials.apiUrl,
  };
}

// A fresh Command carrying only the -f/-d/--variant manifest options at
// their defaults, so per-app manifest resolution behaves exactly as if
// `appliance deploy` had been run inside the member directory.
function manifestCommand(): Command {
  const cmd = new Command();
  registerManifestOptions(cmd);
  return cmd;
}

// Resolve a member's project name: the stack entry's `project` pin,
// else the member manifest's `name`. Must run with cwd inside the
// member directory (see withDir) so manifest detection and any
// programmatic-manifest evaluation see the right folder.
async function resolveProjectName(app: ResolvedStackApp): Promise<string> {
  if (app.project) return app.project;
  const manifest = await extractApplianceFile(manifestCommand());
  if (!manifest.success) {
    throw new Error(
      `Cannot resolve a project name for "${app.relDir}": ${manifest.error.message} ` +
        `Set "project" on the stack entry, or add a manifest with a \`name\`.`
    );
  }
  return manifest.data.name;
}

// Run fn with cwd temporarily switched to the member directory. The
// deploy engine (manifest detection, link.json, .env.<env> lookup,
// docker build context) is cwd-relative by design — switching cwd makes
// a stack member behave identically to a hand-run `appliance deploy`
// in that folder. Members run sequentially, so the global cwd swap is
// safe.
async function withDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
}

function exitWith(message: string): never {
  console.error(chalk.red(message));
  process.exit(1);
}

function validateEnvironmentArg(env: string | undefined): void {
  if (env !== undefined && !dnsName.safeParse(env).success) {
    exitWith(`Invalid environment name "${env}" — lowercase alphanumeric with hyphens, DNS-safe.`);
  }
}

interface StackRow {
  app: string;
  target: string;
  status: string;
  url?: string;
  /** true → green check, false → red cross, null → neutral dot. */
  ok: boolean | null;
}

function printSummary(rows: StackRow[]): void {
  if (rows.length === 0) return;
  const appW = Math.max(...rows.map((r) => r.app.length), 3);
  const targetW = Math.max(...rows.map((r) => r.target.length), 6);
  const statusW = Math.max(...rows.map((r) => r.status.length), 6);
  console.log();
  for (const r of rows) {
    const glyph = r.ok === true ? chalk.green('✓') : r.ok === false ? chalk.red('✗') : chalk.yellow('•');
    const url = r.url ? `  ${chalk.cyan(r.url)}` : '';
    console.log(
      `  ${glyph} ${r.app.padEnd(appW)}  ${chalk.dim(r.target.padEnd(targetW))}  ${r.status.padEnd(statusW)}${url}`
    );
  }
}

function formatDeploymentStatus(d: Deployment): string {
  const base = chalk.dim(d.status);
  return d.message ? `${base} ${chalk.dim('—')} ${d.message}` : base;
}

const program = new Command();

attachProfileOption(program);

program.description('deploy, inspect, and destroy a collection of appliances as a unit');

// --- appliance stack init ---
program
  .command('init')
  .description(`scan subdirectories for appliance manifests and write ${STACK_FILENAME}`)
  .option('--name <name>', 'stack name (defaults to this folder name)')
  .option('--force', `overwrite an existing ${STACK_FILENAME}`, false)
  .action((cmdOpts: { name?: string; force: boolean }) => {
    const cwd = process.cwd();
    const target = path.join(cwd, STACK_FILENAME);
    if (fs.existsSync(target) && !cmdOpts.force) {
      exitWith(`${STACK_FILENAME} already exists. Pass --force to overwrite it.`);
    }

    const members = fs
      .readdirSync(cwd, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .filter((d) => MANIFEST_FILENAMES.some((name) => fs.existsSync(path.join(cwd, d.name, name))))
      .map((d) => d.name)
      .sort();

    if (members.length === 0) {
      exitWith(
        `No subdirectories with an appliance manifest found in ${cwd}.\n` +
          'A stack member is a folder containing an appliance.json (or appliance.ts/js) — see `appliance configure`.'
      );
    }

    const fallbackName =
      path
        .basename(cwd)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'stack';
    const name = cmdOpts.name ?? fallbackName;
    if (!dnsName.safeParse(name).success) {
      exitWith(`Invalid stack name "${name}" — lowercase alphanumeric with hyphens, DNS-safe.`);
    }

    const stack = {
      manifest: 'v1',
      type: 'stack',
      name,
      apps: members.map((dir) => ({ dir })),
    };
    fs.writeFileSync(target, JSON.stringify(stack, null, 2) + '\n');

    console.log(chalk.green(`Created ${STACK_FILENAME}`) + chalk.dim(` (${members.length} apps)`));
    for (const m of members) console.log(`  ${chalk.dim('•')} ${m}`);
    console.log();
    console.log(`Deploy the whole stack with ${chalk.bold('appliance stack deploy')}.`);
  });

// --- appliance stack deploy ---
program
  .command('deploy')
  .description('deploy every app in the stack, in file order')
  .argument('[environment]', "environment for every app (overrides stack + per-app defaults; default 'dev')")
  .option('-f, --file <path>', `stack file (default: ./${STACK_FILENAME})`)
  .action(async (environmentArg: string | undefined, cmdOpts: { file?: string }) => {
    validateEnvironmentArg(environmentArg);
    const { client, apiUrl } = requireClient();

    let stackName: string;
    let apps: ResolvedStackApp[];
    try {
      const loaded = loadStack(cmdOpts.file);
      stackName = loaded.stack.name;
      apps = resolveStackApps(loaded, environmentArg);
    } catch (err) {
      exitWith(err instanceof Error ? err.message : String(err));
    }

    console.log(
      `${chalk.cyan(BRAND)} ${chalk.bold(stackName)} — deploying ${apps.length} app${apps.length === 1 ? '' : 's'}`
    );

    const rows: StackRow[] = [];
    let failed = false;

    for (const [i, app] of apps.entries()) {
      console.log();
      console.log(chalk.bold(`[${i + 1}/${apps.length}] ${app.relDir}`) + chalk.dim(` → ${app.environment}`));
      try {
        const outcome = await withDir(app.dir, async () => {
          const projectName = await resolveProjectName(app);
          return runDeploy({
            client,
            apiUrl,
            program: manifestCommand(),
            cliProject: projectName,
            cliEnvironment: app.environment,
            opts: { build: DEFAULT_BUILD_OUTPUT, yes: true },
          });
        });
        const ok = outcome.deployment.status === DeploymentStatus.Succeeded;
        rows.push({
          app: app.relDir,
          target: `${outcome.projectName}/${outcome.environmentName}`,
          status: outcome.deployment.status,
          url: outcome.url,
          ok,
        });
        if (!ok) {
          failed = true;
          break; // Fail fast: later members may depend on this one.
        }
      } catch (error) {
        if (!isPrintedError(error)) printCliError(error, { apiUrl });
        rows.push({ app: app.relDir, target: `${app.project ?? '?'}/${app.environment}`, status: 'error', ok: false });
        failed = true;
        break;
      }
    }

    printSummary(rows);
    const remaining = apps.length - rows.length;
    if (remaining > 0) {
      console.log(chalk.dim(`  (${remaining} app${remaining === 1 ? '' : 's'} not attempted after the failure)`));
    }
    process.exit(failed ? 1 : 0);
  });

// --- appliance stack status ---
program
  .command('status')
  .description("show every stack app's environment status and URL")
  .argument('[environment]', "environment to inspect (same cascade as deploy; default 'dev')")
  .option('-f, --file <path>', `stack file (default: ./${STACK_FILENAME})`)
  .action(async (environmentArg: string | undefined, cmdOpts: { file?: string }) => {
    validateEnvironmentArg(environmentArg);
    const { client } = requireClient();

    let stackName: string;
    let apps: ResolvedStackApp[];
    try {
      const loaded = loadStack(cmdOpts.file);
      stackName = loaded.stack.name;
      apps = resolveStackApps(loaded, environmentArg);
    } catch (err) {
      exitWith(err instanceof Error ? err.message : String(err));
    }

    const projectsResult = await client.listProjects();
    if (!projectsResult.success) {
      exitWith(`Failed to list projects: ${projectsResult.error.message}`);
    }

    console.log(chalk.bold(stackName));
    const rows: StackRow[] = [];
    for (const app of apps) {
      let projectName: string;
      try {
        projectName = await withDir(app.dir, () => resolveProjectName(app));
      } catch (err) {
        rows.push({
          app: app.relDir,
          target: `?/${app.environment}`,
          status: err instanceof Error ? err.message : String(err),
          ok: false,
        });
        continue;
      }
      const target = `${projectName}/${app.environment}`;

      const project = projectsResult.data.find((p) => p.name === projectName);
      if (!project) {
        rows.push({ app: app.relDir, target, status: 'not deployed', ok: null });
        continue;
      }

      const envsResult = await client.listEnvironments(project.id);
      if (!envsResult.success) {
        rows.push({ app: app.relDir, target, status: `error: ${envsResult.error.message}`, ok: false });
        continue;
      }
      const env = envsResult.data.find((e) => e.name === app.environment);
      if (!env) {
        rows.push({ app: app.relDir, target, status: 'not deployed', ok: null });
        continue;
      }

      // env.url is canonical; fall back to a deployment scan for
      // environments that predate the field (mirrors `appliance list`).
      let url = env.url ?? undefined;
      if (!url) {
        const deployments = await client.listDeployments({ projectId: project.id, limit: 50 });
        if (deployments.success) url = urlsByEnvironment(deployments.data).get(env.id);
      }

      rows.push({
        app: app.relDir,
        target,
        status: env.status,
        url,
        ok: env.status === 'deployed' ? true : env.status === 'failed' ? false : null,
      });
    }

    printSummary(rows);
  });

// --- appliance stack destroy ---
program
  .command('destroy')
  .description("destroy every stack app's environment (asks once for the whole set)")
  .argument('[environment]', "environment to destroy (same cascade as deploy; default 'dev')")
  .option('-f, --file <path>', `stack file (default: ./${STACK_FILENAME})`)
  .option('-y, --yes', 'skip confirmation prompt', false)
  .action(async (environmentArg: string | undefined, cmdOpts: { file?: string; yes: boolean }) => {
    validateEnvironmentArg(environmentArg);
    const { client, apiUrl } = requireClient();

    let stackName: string;
    let apps: ResolvedStackApp[];
    try {
      const loaded = loadStack(cmdOpts.file);
      stackName = loaded.stack.name;
      apps = resolveStackApps(loaded, environmentArg);
    } catch (err) {
      exitWith(err instanceof Error ? err.message : String(err));
    }

    // Resolve every target up front so the confirmation lists exactly
    // what will be torn down.
    const targets: Array<{ app: ResolvedStackApp; projectName: string }> = [];
    for (const app of apps) {
      try {
        targets.push({ app, projectName: await withDir(app.dir, () => resolveProjectName(app)) });
      } catch (err) {
        exitWith(err instanceof Error ? err.message : String(err));
      }
    }

    console.log(
      `${chalk.bold(stackName)} — destroying ${targets.length} environment${targets.length === 1 ? '' : 's'}:`
    );
    for (const t of targets) {
      console.log(`  ${chalk.dim('•')} ${t.projectName}/${t.app.environment}  ${chalk.dim(`(${t.app.relDir})`)}`);
    }

    const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!cmdOpts.yes) {
      if (!isTTY) {
        // Mirrors `appliance destroy`: never tear stacks down from a
        // piped or CI invocation without an explicit opt-in.
        console.error(chalk.red('Refusing to destroy without confirmation in a non-interactive session.'));
        console.error(chalk.dim('Pass --yes to confirm.'));
        process.exit(1);
      }
      const ok = await confirm({
        message: `Destroy all ${targets.length} environments above? This tears down their stacks.`,
        default: false,
      });
      if (!ok) {
        console.log(chalk.dim('Cancelled.'));
        return;
      }
    }

    const projectsResult = await client.listProjects();
    if (!projectsResult.success) {
      exitWith(`Failed to list projects: ${projectsResult.error.message}`);
    }

    const rows: StackRow[] = [];
    let failed = false;

    for (const { app, projectName } of targets) {
      const target = `${projectName}/${app.environment}`;

      const project = projectsResult.data.find((p) => p.name === projectName);
      if (!project) {
        rows.push({ app: app.relDir, target, status: 'not found (skipped)', ok: null });
        continue;
      }
      const envsResult = await client.listEnvironments(project.id);
      const env = envsResult.success ? envsResult.data.find((e) => e.name === app.environment) : undefined;
      if (!env) {
        rows.push({ app: app.relDir, target, status: 'not found (skipped)', ok: null });
        continue;
      }

      try {
        const result = await client.destroy(env.id);
        if (!result.success) throw new Error(`Destroy failed: ${result.error.message}`);

        const progress = startProgressLine(`Destroying ${target} — pending`);
        try {
          const { deployment } = await pollDeploymentUntilDone(client, result.data.id, {
            onProgress: (d) => progress.update(`Destroying ${target} — ${formatDeploymentStatus(d)}`),
          });
          progress.clear();
          const ok = deployment.status === DeploymentStatus.Succeeded;
          rows.push({ app: app.relDir, target, status: ok ? 'destroyed' : deployment.status, ok });
          if (!ok) failed = true;
        } catch (err) {
          progress.fail(chalk.red(err instanceof Error ? err.message : String(err)));
          rows.push({ app: app.relDir, target, status: 'error', ok: false });
          failed = true;
        }
      } catch (error) {
        // Destroy is best-effort across the set — report and continue
        // so one wedged environment doesn't strand the rest.
        printCliError(error, { apiUrl });
        rows.push({ app: app.relDir, target, status: 'error', ok: false });
        failed = true;
      }
    }

    printSummary(rows);
    process.exit(failed ? 1 : 0);
  });

program.parse(process.argv);
