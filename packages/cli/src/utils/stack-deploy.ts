import { Command } from 'commander';
import chalk from 'chalk';
import { createApplianceClient, DeploymentStatus } from '@appliance.sh/sdk';
import { loadCredentials } from './credentials.js';
import { extractApplianceFile, registerManifestOptions } from './common.js';
import { DEFAULT_BUILD_OUTPUT, isPrintedError, runDeploy, type DeployOutcome } from './deploy-core.js';
import { resolveStackAppEnv, type ResolvedStackApp, type StackMemberInfo } from './stack.js';
import { printCliError } from './errors.js';

// Shared stack-deploy engine: the sequential fail-fast member loop
// `appliance stack deploy` runs, extracted so `appliance dev` drives
// the exact same deploys (env wiring, cwd semantics, summary rows)
// before layering logs + watch on top.

export function requireClient() {
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
      product: 'cli',
    }),
    apiUrl: credentials.apiUrl,
  };
}

// A fresh Command carrying only the -f/-d/--variant manifest options at
// their defaults, so per-app manifest resolution behaves exactly as if
// `appliance deploy` had been run inside the member directory.
export function manifestCommand(): Command {
  const cmd = new Command();
  registerManifestOptions(cmd);
  return cmd;
}

// Resolve a member's project name: the stack entry's `project` pin,
// else the member manifest's `name`. Must run with cwd inside the
// member directory (see withDir) so manifest detection and any
// programmatic-manifest evaluation see the right folder.
export async function resolveProjectName(app: ResolvedStackApp): Promise<string> {
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
export async function withDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
}

export interface StackRow {
  app: string;
  target: string;
  status: string;
  url?: string;
  /** true → green check, false → red cross, null → neutral dot. */
  ok: boolean | null;
}

export function printSummary(rows: StackRow[]): void {
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

/**
 * Env wiring inputs: when any entry declares `env`, gather what the
 * placeholders can reference — each member's project name and port
 * from its manifest. Returns an empty map otherwise, so stacks without
 * wiring don't pay an extra manifest evaluation per member.
 */
export async function gatherMemberInfo(apps: ResolvedStackApp[]): Promise<Map<string, StackMemberInfo>> {
  const memberInfo = new Map<string, StackMemberInfo>();
  if (apps.some((a) => a.env && Object.keys(a.env).length > 0)) {
    for (const app of apps) {
      const manifest = await withDir(app.dir, () => extractApplianceFile(manifestCommand()));
      memberInfo.set(app.relDir, {
        projectName: app.project ?? (manifest.success ? manifest.data.name : undefined),
        environment: app.environment,
        port: (manifest.success && 'port' in manifest.data && manifest.data.port) || 8080,
      });
    }
  }
  return memberInfo;
}

/** Deploy one member exactly as `appliance deploy` would inside its
 *  directory, with the stack's wired env. Reused verbatim by the dev
 *  loop's rebuild-on-save path. */
export async function deployStackMember(params: {
  client: ReturnType<typeof createApplianceClient>;
  apiUrl: string;
  app: ResolvedStackApp;
  memberInfo: Map<string, StackMemberInfo>;
  deployedUrls: Map<string, string>;
}): Promise<DeployOutcome> {
  const { client, apiUrl, app, memberInfo, deployedUrls } = params;
  const extraEnv = resolveStackAppEnv(app, memberInfo, deployedUrls);
  if (extraEnv) {
    console.log(chalk.dim(`Stack env: ${Object.keys(extraEnv).join(', ')}`));
  }
  return withDir(app.dir, async () => {
    const projectName = await resolveProjectName(app);
    return runDeploy({
      client,
      apiUrl,
      program: manifestCommand(),
      cliProject: projectName,
      cliEnvironment: app.environment,
      opts: { build: DEFAULT_BUILD_OUTPUT, yes: true, extraEnv },
    });
  });
}

export interface StackDeployResult {
  rows: StackRow[];
  /** relDir → host-facing URL, in deploy order ({{url:…}} inputs). */
  urls: Map<string, string>;
  /** relDir → full deploy outcome (ids for log streaming etc.). */
  outcomes: Map<string, DeployOutcome>;
  memberInfo: Map<string, StackMemberInfo>;
  failed: boolean;
}

/**
 * Deploy every member in file order, fail-fast — the engine behind
 * `appliance stack deploy`. Prints the per-member headers and deploy
 * progress; the caller renders the summary and decides the exit code.
 */
export async function deployStackApps(params: {
  client: ReturnType<typeof createApplianceClient>;
  apiUrl: string;
  apps: ResolvedStackApp[];
}): Promise<StackDeployResult> {
  const { client, apiUrl, apps } = params;
  const memberInfo = await gatherMemberInfo(apps);

  const rows: StackRow[] = [];
  const deployedUrls = new Map<string, string>();
  const outcomes = new Map<string, DeployOutcome>();
  let failed = false;

  for (const [i, app] of apps.entries()) {
    console.log();
    console.log(chalk.bold(`[${i + 1}/${apps.length}] ${app.relDir}`) + chalk.dim(` → ${app.environment}`));
    try {
      const outcome = await deployStackMember({ client, apiUrl, app, memberInfo, deployedUrls });
      outcomes.set(app.relDir, outcome);
      if (outcome.url) deployedUrls.set(app.relDir, outcome.url);
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

  return { rows, urls: deployedUrls, outcomes, memberInfo, failed };
}
