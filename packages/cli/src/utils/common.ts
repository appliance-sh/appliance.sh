import { Command } from 'commander';
import path from 'path';
import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { confirm } from '@inquirer/prompts';
import { Appliance, applianceFullInput, ApplianceFullInput, ManifestContext, Result } from '@appliance.sh/sdk';
import chalk from 'chalk';
import { addTrustedProject, isTrustedProject, settingsFilePath } from './settings.js';

// Ordered by precedence. First hit wins when the user passes neither
// --file nor --directory (or --directory without --file).
const DEFAULT_FILENAMES = [
  'appliance.ts',
  'appliance.mts',
  'appliance.cts',
  'appliance.js',
  'appliance.mjs',
  'appliance.cjs',
  'appliance.json',
];

const CODE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);

// Per-process de-dup so a single CLI invocation loading multiple
// manifests doesn't spam the same warnings.
const warnedLoads = new Set<string>();

export interface ExtractOptions {
  /** Project name forwarded into ManifestContext (deploy time only). */
  project?: string;
  /** Environment name forwarded into ManifestContext (deploy time only). */
  environment?: string;
}

export async function extractApplianceFile(
  cmd: Command,
  opts: ExtractOptions = {}
): Promise<Result<ApplianceFullInput>> {
  const filePath = resolveManifestPath(cmd);
  if (!filePath) {
    return {
      success: false,
      error: { name: 'File Not Found', message: 'No appliance file found.' } as Error,
    };
  }

  const ext = path.extname(filePath).toLowerCase();
  const isCode = CODE_EXTENSIONS.has(ext);

  if (isCode) {
    const trustCheck = await checkManifestTrust(filePath);
    if (!trustCheck.trusted) {
      return { success: false, error: new Error(trustCheck.reason) };
    }
    warnOnFirstCodeLoad(filePath);
  }

  const ctx: ManifestContext = {
    cwd: process.cwd(),
    variant: (cmd.getOptionValue('variant') as string | undefined) || undefined,
    project: opts.project,
    environment: opts.environment,
    env: { ...process.env },
  };

  try {
    const raw = await loadManifest(filePath, ext, ctx);
    // Parse against the combined build+runtime schema so callers can
    // pull either half: `appliance build` archives only the build
    // fields; `appliance deploy` forwards env / memory / timeout /
    // storage on the deploy payload.
    const parsed = applianceFullInput.safeParse(raw);
    if (!parsed.success) return parsed;

    if (!isCode) {
      const entropyErr = rejectHighEntropyEnv(parsed.data.env);
      if (entropyErr) return { success: false, error: entropyErr };
    }
    return parsed;
  } catch (err) {
    return { success: false, error: err as Error };
  }
}

// Standard manifest options every command that loads a manifest
// should accept. Centralised so the variant/file/directory triplet
// stays consistent across `appliance build`, `appliance configure`,
// etc., and so the loader can read each option uniformly.
export function registerManifestOptions(program: Command): Command {
  return program
    .option('-f, --file <file>', 'appliance manifest file', 'appliance.json')
    .option('-d, --directory <directory>', 'appliance directory')
    .option('--variant <name>', 'variant to load from a programmatic (.ts/.js) manifest');
}

function resolveManifestPath(cmd: Command): string | null {
  const fileOpt = cmd.getOptionValue('file') as string | undefined;
  const dirOpt = cmd.getOptionValue('directory') as string | undefined;

  // An explicit --file (anything other than the default sentinel
  // 'appliance.json') is taken verbatim — even if the file doesn't
  // exist, we return its path so the caller reports a clear error
  // against what the user asked for.
  if (fileOpt && fileOpt !== 'appliance.json') {
    return path.resolve(process.cwd(), fileOpt);
  }

  const dir = dirOpt ? path.resolve(process.cwd(), dirOpt) : process.cwd();
  const matches = DEFAULT_FILENAMES.map((name) => path.join(dir, name)).filter((p) => fs.existsSync(p));
  if (matches.length === 0) return null;

  const picked = matches[0];
  const pickedIsCode = CODE_EXTENSIONS.has(path.extname(picked).toLowerCase());
  const shadowedJson = matches.find((p) => path.extname(p).toLowerCase() === '.json');

  if (matches.length > 1) {
    if (pickedIsCode && shadowedJson) {
      console.warn(
        chalk.yellow(
          `⚠  Code manifest ${path.basename(picked)} is shadowing ${path.basename(shadowedJson)}. ` +
            `The code manifest will be executed to load the appliance definition. ` +
            `Delete one of the two, or pass --file explicitly, to silence this warning.`
        )
      );
    } else {
      const others = matches
        .slice(1)
        .map((p) => path.basename(p))
        .join(', ');
      console.warn(
        chalk.yellow(
          `Multiple appliance manifests found (${path.basename(picked)}, ${others}). Using ${path.basename(picked)}.`
        )
      );
    }
  }
  return picked;
}

// Trust check: code manifests execute arbitrary code. Three ways
// in, in priority order:
//   1. APPLIANCE_TRUST_MANIFEST=1 env var (CI / one-off bypass)
//   2. trustedProjects entry in ~/.appliance/settings.json (auto-
//      managed by this CLI; persists across runs)
//   3. interactive y/N prompt on a TTY — yes appends the directory
//      to trustedProjects so it's silent next time
// Non-TTY without env or settings entry → hard error with both
// remediations.
interface TrustResult {
  trusted: boolean;
  reason: string;
}

async function checkManifestTrust(filePath: string): Promise<TrustResult> {
  if (process.env.APPLIANCE_TRUST_MANIFEST === '1') {
    return { trusted: true, reason: 'env var' };
  }

  const manifestDir = path.dirname(path.resolve(filePath));
  if (isTrustedProject(manifestDir)) {
    return { trusted: true, reason: 'settings.trustedProjects' };
  }

  const rel = path.basename(filePath);

  if (process.stdin.isTTY && process.stdout.isTTY) {
    console.warn(
      chalk.yellow(
        `\n⚠  ${rel} executes arbitrary code from ${manifestDir}.\n` +
          `   Only trust projects you would also run \`pnpm install && pnpm build\` for.`
      )
    );
    let answer: boolean;
    try {
      answer = await confirm({
        message: 'Trust this directory and remember the choice?',
        default: false,
      });
    } catch {
      return {
        trusted: false,
        reason: `Refusing to load ${rel}: trust prompt cancelled.`,
      };
    }
    if (answer) {
      addTrustedProject(manifestDir);
      console.log(chalk.dim(`Added to trustedProjects in ${settingsFilePath()}`));
      return { trusted: true, reason: 'TTY prompt' };
    }
    return {
      trusted: false,
      reason: `Refusing to load ${rel}: declined at trust prompt.`,
    };
  }

  return {
    trusted: false,
    reason:
      `Refusing to load ${rel}: TypeScript/JavaScript manifests execute arbitrary code, ` +
      `and this directory is not in trustedProjects. Trust it by either:\n` +
      `  • setting APPLIANCE_TRUST_MANIFEST=1 (CI / one-off runs), or\n` +
      `  • running this command interactively (the CLI will prompt and persist your choice), or\n` +
      `  • adding "${manifestDir}" to trustedProjects in ${settingsFilePath()}`,
  };
}

function warnOnFirstCodeLoad(filePath: string) {
  if (warnedLoads.has(filePath)) return;
  warnedLoads.add(filePath);
  console.warn(
    chalk.yellow(
      `⚠  Loading code manifest ${path.basename(filePath)} — arbitrary code from this file will execute in the CLI.`
    )
  );
}

// Reject high-entropy hardcoded env values in JSON manifests. The
// intent: if you want an environment variable that looks like a
// secret (API key, connection string with password), you must
// compute it at load time from an appliance.ts — not bake it into
// the repo as a string. TS manifests bypass this check because
// they can read from process.env, Secrets Manager, etc.
function rejectHighEntropyEnv(env?: Record<string, string>): Error | null {
  if (!env) return null;
  const flagged: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (looksLikeSecret(value)) flagged.push(key);
  }
  if (flagged.length === 0) return null;
  return new Error(
    `Manifest env contains high-entropy value(s) that look like secrets: ${flagged.join(', ')}. ` +
      `Hardcoded secrets in JSON manifests are rejected. ` +
      `Use a TypeScript manifest (appliance.ts) that reads the value at load time, or resolve the secret at deploy time via --env-file.`
  );
}

// Shannon entropy per character. A length floor avoids flagging
// short random-looking strings; the entropy floor avoids flagging
// ordinary config values (URLs, mode names, port numbers).
function looksLikeSecret(value: string): boolean {
  if (value.length < 20) return false;
  const entropy = shannonEntropy(value);
  return entropy >= 4.0;
}

function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

async function loadManifest(filePath: string, ext: string, ctx: ManifestContext): Promise<unknown> {
  if (ext === '.json') {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
  if (CODE_EXTENSIONS.has(ext)) {
    const mod = await importManifestModule(filePath);
    let raw: unknown = (mod as { default?: unknown }).default ?? mod;
    if (typeof raw === 'function') raw = await (raw as (ctx: ManifestContext) => unknown)(ctx);
    return raw;
  }
  throw new Error(`Unsupported manifest extension: ${ext}`);
}

async function importManifestModule(filePath: string): Promise<unknown> {
  const url = pathToFileURL(filePath).href;
  const isTs = /\.[cm]?ts$/i.test(filePath);
  if (!isTs) return import(url);

  // Node 22.18+ strips types natively via --experimental-strip-types
  // (on by default). `process.features.typescript` is the canonical
  // capability flag — when it's truthy, plain `import()` handles TS.
  if ((process.features as unknown as { typescript?: boolean }).typescript) {
    return import(url);
  }

  try {
    const { register } = await import('node:module');
    register('tsx/esm', pathToFileURL('./').href);
    return import(url);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Cannot load TypeScript manifest ${filePath}: install tsx in the CLI's runtime dependencies, or run Node 22.18+ with native strip-types. (${reason})`
    );
  }
}

export function saveApplianceFile(filePath: string, appliance: Appliance): Result<void> {
  const ext = path.extname(filePath).toLowerCase();
  if (CODE_EXTENSIONS.has(ext)) {
    console.warn(
      `Refusing to overwrite ${path.basename(filePath)}: TypeScript/JavaScript manifests contain code, not data. ` +
        `Apply the following changes by hand:`
    );
    console.log(JSON.stringify(appliance, null, 2));
    return { success: true, data: undefined };
  }
  try {
    fs.writeFileSync(filePath, JSON.stringify(appliance, null, 2));
    return { success: true, data: undefined };
  } catch (err) {
    return { success: false, error: err as Error };
  }
}
