#!/usr/bin/env node

import { ensureHelperBinOnPath, ensureLocalhostFetch } from '@appliance.sh/helper';
import * as sdk from '@appliance.sh/sdk';
import { userArgs } from './utils/argv.js';

// Prepend ~/.appliance/bin to PATH so any downstream spawns (docker,
// kubectl, crane) resolve helper-installed binaries when the system
// PATH lacks them. Idempotent; safe to also call from a subcommand
// entry directly.
ensureHelperBinOnPath();

// Windows' resolver doesn't implement RFC 6761 `.localhost`, which the
// microVM runtime's URLs (`api.appliance.localhost`, per-deploy
// hostnames) depend on — teach this process' fetch to resolve them.
ensureLocalhostFetch();

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
  agent: {
    description: 'run a coding agent (Claude Code, Copilot, Codex) inside the sandbox microVM',
    load: () => import('./appliance-agent.js'),
  },
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
  cluster: {
    description: 'list, switch, and forget clusters (shared with the desktop app)',
    load: () => import('./appliance-cluster.js'),
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
    description:
      'one-tap local onboarding: boot the microVM runtime and guide your first deploy (--remote <url> for cloud creds)',
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
    description: '(removed) the local k3d runtime — use `appliance vm` / `appliance up`',
    load: () => import('./appliance-local.js'),
  },
  logs: {
    description: "stream a deployment's container logs (local engines)",
    load: () => import('./appliance-logs.js'),
  },
  vm: {
    description: 'manage the microVM runtimes (deploy VM `appliance`; `up`/`agent` use sandbox VM `appliance-sbx`)',
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
    description: 'manage credential profiles (the lower-level store behind `appliance cluster`)',
    load: () => import('./appliance-profile.js'),
  },
  server: {
    description: 'run the control plane as a lightweight local daemon — deploys to your Docker daemon, no VM/k3s',
    load: () => import('./appliance-server.js'),
  },
  stack: {
    description: 'deploy, inspect, and destroy a collection of appliances as a unit (appliance.stack.json)',
    load: () => import('./appliance-stack.js'),
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

// Help groups the commands by workflow instead of alphabetically: the
// three things people come here to do (run this repo in the sandbox,
// deploy appliances, operate runtimes/servers) beat a flat A–Z wall.
// Names must exist in SUBCOMMANDS; anything unlisted lands in "Other"
// so a newly-registered command is never silently hidden.
const COMMAND_GROUPS: Array<{ title: string; names: string[] }> = [
  {
    title: 'Run this repo locally (shared sandbox microVM)',
    names: ['up', 'down', 'shell', 'logs', 'agent'],
  },
  {
    title: 'Deploy appliances (local microVM or cloud — same commands, switch with --profile)',
    names: [
      'init',
      'deploy',
      'stack',
      'open',
      'app',
      'build',
      'configure',
      'manifest',
      'env',
      'deployment',
      'destroy',
      'link',
      'unlink',
    ],
  },
  {
    title: 'Runtimes, servers & credentials',
    names: [
      'server',
      'vm',
      'doctor',
      'login',
      'whoami',
      'profile',
      'cluster',
      'keys',
      'test',
      'bootstrap',
      'teardown',
      'local',
    ],
  },
];

function showHelp(): void {
  console.log('Usage: appliance <command> [options]');
  const allNames = Object.keys(SUBCOMMANDS);
  const width = Math.max(...allNames.map((n) => n.length));
  const grouped = new Set(COMMAND_GROUPS.flatMap((g) => g.names));
  const leftovers = allNames.filter((n) => !grouped.has(n)).sort();
  const groups = [...COMMAND_GROUPS, ...(leftovers.length > 0 ? [{ title: 'Other', names: leftovers }] : [])];
  for (const group of groups) {
    console.log();
    console.log(`${group.title}:`);
    for (const name of group.names) {
      const def = SUBCOMMANDS[name];
      if (!def) continue;
      const aliasTail = def.aliases && def.aliases.length > 0 ? ` (alias: ${def.aliases.join(', ')})` : '';
      console.log(`  ${name.padEnd(width)}  ${def.description}${aliasTail}`);
    }
  }
  console.log();
  console.log('Shortcuts:');
  for (const [name, sc] of Object.entries(SHORTCUTS)) {
    console.log(`  ${name.padEnd(width)}  alias for \`appliance ${sc.target} ${sc.prefix.join(' ')}\``);
  }
  console.log();
  console.log('Getting started:');
  console.log('  Fastest local deploys:      appliance server start  →  appliance deploy  →  appliance open');
  console.log('  Isolated local runtime:     appliance init  →  appliance deploy   (microVM + k3s)');
  console.log('  Run this repo, no manifest: appliance up          (Dockerfile / compose / devcontainer)');
  console.log('  Run a coding agent:         appliance agent login  →  appliance agent start');
  console.log('  A collection of apps:       appliance stack init  →  appliance stack deploy');
  console.log('  Cloud on AWS:               appliance bootstrap  →  appliance login  →  appliance deploy');
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
