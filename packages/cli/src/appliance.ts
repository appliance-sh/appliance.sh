#!/usr/bin/env node

import { ensureHelperBinOnPath } from '@appliance.sh/helper';
import * as sdk from '@appliance.sh/sdk';

// Prepend ~/.appliance/bin to PATH so any downstream spawns (docker,
// k3d, kubectl) resolve helper-installed binaries when the system
// PATH lacks them. Idempotent; safe to also call from a subcommand
// entry directly.
ensureHelperBinOnPath();

// Dynamic-import dispatcher for the `appliance` umbrella command.
//
// We previously relied on commander's "executable subcommands" mode,
// which dispatches by spawning sibling `appliance-<name>.js` files.
// That breaks under `bun build --compile` (single-binary builds have
// no sibling files to spawn). The fix: enumerate subcommands here and
// route via dynamic `import()`, which Bun's bundler statically picks
// up and includes in the binary. The same code path also works under
// Node (each subcommand file still calls `program.parse(process.argv)`
// when imported, exactly as it did before).
//
// Adding a new subcommand:
//   1. Drop a new `appliance-<name>.ts` in this folder that self-
//      executes via `program.parse(process.argv)`.
//   2. Append an entry to `SUBCOMMANDS` below.

interface SubcommandDef {
  description: string;
  aliases?: string[];
  load: () => Promise<unknown>;
}

const SUBCOMMANDS: Record<string, SubcommandDef> = {
  app: {
    description: 'manage applications (setup, status, list)',
    aliases: ['application'],
    load: () => import('./appliance-app.js'),
  },
  bootstrap: {
    description: 'provision a new Appliance installation on AWS',
    load: () => import('./appliance-bootstrap.js'),
  },
  build: {
    description: 'builds the appliance in the current working directory',
    load: () => import('./appliance-build.js'),
  },
  configure: {
    description: 'configures the appliance in the current working directory',
    load: () => import('./appliance-configure.js'),
  },
  deploy: {
    description: 'deploy the linked (or named) project/environment',
    aliases: ['install'],
    load: () => import('./appliance-deploy.js'),
  },
  deployment: {
    description: 'manage deployments',
    load: () => import('./appliance-deployment.js'),
  },
  destroy: {
    description: 'destroy the linked (or named) project/environment',
    aliases: ['remove'],
    load: () => import('./appliance-destroy.js'),
  },
  doctor: {
    description: 'run first-run preflight checks (use --fix to auto-resolve the safe ones)',
    load: () => import('./appliance-doctor.js'),
  },
  env: {
    description: 'manage per-environment variables (set/list/unset)',
    load: () => import('./appliance-env.js'),
  },
  init: {
    description: 'initialise the CLI with the appliance server',
    load: () => import('./appliance-init.js'),
  },
  keys: {
    description: 'manage the cluster API key lifecycle (rotate)',
    load: () => import('./appliance-keys.js'),
  },
  link: {
    description: 'link this folder to a project/environment',
    load: () => import('./appliance-link.js'),
  },
  local: {
    description: 'manage the local k3d-backed runtime',
    load: () => import('./appliance-local.js'),
  },
  logs: {
    description: "stream a deployment's container logs (local engines)",
    load: () => import('./appliance-logs.js'),
  },
  vm: {
    description: 'manage the microVM runtime (isolated VM engine)',
    load: () => import('./appliance-vm.js'),
  },
  login: {
    description: 'authenticate with the appliance API',
    load: () => import('./appliance-login.js'),
  },
  manifest: {
    description: 'evaluate a programmatic appliance manifest in a sandbox',
    load: () => import('./appliance-manifest.js'),
  },
  open: {
    description: 'open the latest deployment URL in a browser',
    load: () => import('./appliance-open.js'),
  },
  profile: {
    description: 'manage credential profiles (shared with the desktop app)',
    load: () => import('./appliance-profile.js'),
  },
  teardown: {
    description: 'destroy a bootstrap installation (reverses `appliance bootstrap`)',
    load: () => import('./appliance-teardown.js'),
  },
  test: {
    description: 'run connection and signing diagnostics',
    load: () => import('./appliance-test.js'),
  },
  unlink: {
    description: 'remove the local project/environment link',
    load: () => import('./appliance-unlink.js'),
  },
  up: {
    description: 'build + run this project (Dockerfile, compose, or devcontainer) in the shared sandbox microVM',
    load: () => import('./appliance-up.js'),
  },
  down: {
    description: "stop and remove this project's sandbox container",
    load: () => import('./appliance-down.js'),
  },
  shell: {
    description: "enter this project's sandbox (devcontainer exec, or the VM host shell)",
    load: () => import('./appliance-shell.js'),
  },
  whoami: {
    description: 'show active profile, server URL, and linked project',
    load: () => import('./appliance-whoami.js'),
  },
};

// Top-level shortcuts that expand to `<target> <prefix> [args]`. Keeps
// the muscle memory of `appliance status` / `appliance list` /
// `appliance setup` working without per-shortcut alias files.
const SHORTCUTS: Record<string, { target: string; prefix: string[] }> = {
  list: { target: 'app', prefix: ['list'] },
  setup: { target: 'app', prefix: ['setup'] },
  status: { target: 'app', prefix: ['status'] },
};

// Resolve aliases (e.g. `application` -> `app`) to their canonical
// subcommand name. Filled once at module load.
const ALIAS_MAP: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [name, def] of Object.entries(SUBCOMMANDS)) {
    m[name] = name;
    for (const alias of def.aliases ?? []) m[alias] = name;
  }
  return m;
})();

/**
 * The "user-supplied" tail of argv. Two invocation shapes to handle:
 *
 *   Node / Bun-as-interpreter: [interpreter, /path/to/script.js, ...userArgs]
 *   Bun-compiled binary:       [binary, /$bunfs/root/appliance, ...userArgs]
 *
 * In both cases argv[1] is a "script-like" path that isn't part of
 * what the user typed. We detect it via the `/$bunfs/` prefix (Bun's
 * embedded-fs convention) or a JS-source extension and slice from
 * argv[2..]. Falls back to `argv[1..]` for unusual cases (e.g. a
 * harness that strips the script slot entirely).
 */
function userArgs(): string[] {
  const first = process.argv[1];
  if (first) {
    if (first.startsWith('/$bunfs/')) return process.argv.slice(2);
    if (/\.(?:js|cjs|mjs|ts)$/.test(first)) return process.argv.slice(2);
  }
  return process.argv.slice(1);
}

function showHelp(): void {
  console.log('Usage: appliance <command> [options]');
  console.log();
  console.log('Commands:');
  const names = Object.keys(SUBCOMMANDS).sort();
  const width = Math.max(...names.map((n) => n.length));
  for (const name of names) {
    const def = SUBCOMMANDS[name];
    const aliasTail = def.aliases && def.aliases.length > 0 ? ` (alias: ${def.aliases.join(', ')})` : '';
    console.log(`  ${name.padEnd(width)}  ${def.description}${aliasTail}`);
  }
  console.log();
  console.log('Shortcuts:');
  for (const [name, sc] of Object.entries(SHORTCUTS)) {
    console.log(`  ${name.padEnd(width)}  alias for \`appliance ${sc.target} ${sc.prefix.join(' ')}\``);
  }
  console.log();
  console.log('Getting started:');
  console.log('  appliance login                 authenticate against an api-server');
  console.log('  appliance setup                 link this folder to a project/environment');
  console.log('  appliance deploy                build and ship the linked appliance');
  console.log('  appliance open                  open the deployed URL in a browser');
  console.log();
  console.log('Environment variables:');
  console.log('  APPLIANCE_PROFILE               credential profile to use (overrides the active profile)');
  console.log('  APPLIANCE_API_URL               override the api-server URL from the profile');
  console.log('  APPLIANCE_TRUST_MANIFEST=1      skip the programmatic-manifest trust prompt (CI)');
  console.log();
  console.log('Run `appliance <command> --help` for command-specific options.');
}

async function main(): Promise<void> {
  const args = userArgs();

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    showHelp();
    return;
  }

  if (args[0] === '--version' || args[0] === '-V') {
    // SDK.VERSION is a `v`-prefixed semver string emitted by the build
    // (e.g. `v1.41.0`); don't add another prefix.
    console.log(sdk.VERSION);
    return;
  }

  const sub = args[0];

  // `appliance status` routes by link.json: a `sandbox` link (an
  // `appliance up` folder) shows the sandbox container + URL; otherwise
  // it falls through to the `app status` shortcut below (docs/up.md §2).
  if (sub === 'status') {
    const { readSandboxLink } = await import('./utils/link.js');
    if (readSandboxLink()) {
      const { runSandboxStatus } = await import('./utils/sandbox.js');
      const json = args.slice(1).includes('--json');
      process.exit(await runSandboxStatus({ json }));
    }
  }

  // Shortcut: rewrite argv so the target subcommand sees its own
  // sub-name as the first positional. Falls through to the regular
  // load below.
  const shortcut = SHORTCUTS[sub];
  if (shortcut) {
    process.argv = [process.argv[0], `appliance-${shortcut.target}`, ...shortcut.prefix, ...args.slice(1)];
    await SUBCOMMANDS[shortcut.target].load();
    return;
  }

  const canonical = ALIAS_MAP[sub];
  if (!canonical) {
    console.error(`Unknown command: ${sub}`);
    console.error();
    showHelp();
    process.exit(1);
  }

  // Normalize argv so the subcommand's `program.parse(process.argv)`
  // works. Commander's default `from: 'node'` slices argv[2..], so
  // we put a fake script name at argv[1] and real args from argv[2].
  process.argv = [process.argv[0], `appliance-${canonical}`, ...args.slice(1)];
  await SUBCOMMANDS[canonical].load();
}

// Ctrl-C inside an @inquirer prompt rejects with ExitPromptError.
// Subcommands that don't wrap their prompts in try/catch would
// otherwise crash with a stack trace on a plain abort — catch it
// centrally and exit with the conventional 130 instead.
process.on('unhandledRejection', (err) => {
  if (err instanceof Error && err.name === 'ExitPromptError') {
    console.error('Cancelled.');
    process.exit(130);
  }
  throw err;
});

main().catch((err) => {
  if (err instanceof Error && err.name === 'ExitPromptError') {
    console.error('Cancelled.');
    process.exit(130);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
