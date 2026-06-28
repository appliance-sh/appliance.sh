import { Command } from 'commander';
import chalk from 'chalk';
import * as path from 'node:path';
import { ensureHelperBinOnPath } from '@appliance.sh/helper';
import { writeSandboxLink } from './utils/link.js';
import type { SandboxLink } from './utils/link.js';
import {
  DEFAULT_SANDBOX_VM,
  GUEST_WORKSPACE,
  deterministicHostPort,
  detectProjectType,
  dnsLabel,
  ensureSandboxVm,
  guestIp,
  parseExposedPort,
  vmShell,
} from './utils/sandbox.js';

// `appliance up` — near-zero-config local run of a repo's own container
// definition in the shared sandbox microVM (docs/up.md §2, §5, §6 A).
//
// This version implements the Dockerfile slice only: detect a Dockerfile
// in cwd, bring up the sandbox VM with the workspace shared + docker
// provisioned, build + run the image in-guest against the mounted
// workspace, publish its port, persist a `sandbox` block to link.json,
// and print the host-reachable URL. Compose + devcontainer are detected
// and rejected with guidance, not run.

ensureHelperBinOnPath();

const program = new Command();

program
  .description('build + run this project (Dockerfile) in the shared sandbox microVM')
  .option('--vm <name>', 'sandbox VM to run in', DEFAULT_SANDBOX_VM)
  .option('--port <port>', 'container port to publish (overrides EXPOSE)', parsePort)
  .option('--host-port <port>', 'host port to publish on (overrides the deterministic default)', parsePort)
  .option('--detach', 'do not stream container logs after starting (default: start + print URL)', false)
  .option('--no-open', 'do not attempt to open the URL (accepted for forward-compat; v1 never auto-opens)')
  .action(async (opts: { vm: string; port?: number; hostPort?: number; detach: boolean }) => {
    try {
      await runUp(opts);
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

function parsePort(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`expected a port (1–65535), got '${value}'`);
  }
  return n;
}

async function runUp(opts: { vm: string; port?: number; hostPort?: number; detach: boolean }): Promise<void> {
  const cwd = process.cwd();
  const type = detectProjectType(cwd);

  if (type === 'none') {
    throw new Error(
      'no Dockerfile found in this directory.\n' +
        "`appliance up` runs a project's own container definition — add a Dockerfile, or cd into the project root."
    );
  }
  // Compose / devcontainer are detected by precedence (docs/up.md §1) but
  // not implemented here — exit cleanly with the unsupported notice.
  if (type !== 'dockerfile') {
    console.log(`detected ${type}: not yet supported by \`up\` (Dockerfile only in this version)`);
    return;
  }

  const dockerfile = path.join(cwd, 'Dockerfile');
  const project = dnsLabel(path.basename(cwd));
  const containerPort = opts.port ?? parseExposedPort(dockerfile) ?? 8000;
  const hostPort = opts.hostPort ?? deterministicHostPort(project);
  const vm = opts.vm;

  console.log(chalk.bold(`Detected: Dockerfile (${project})`));
  console.log(chalk.dim(`  container port ${containerPort} → host port ${hostPort}`));

  // 1. Boot/ensure the sandbox VM with docker + this workspace mounted,
  //    and wait for the in-guest engine.
  await ensureSandboxVm(vm, cwd);

  // 2. Build in-guest from the shared workspace.
  console.log(chalk.cyan(`» building image ${project} from ${GUEST_WORKSPACE}`));
  const build = vmShell(vm, ['docker', 'build', '-t', project, GUEST_WORKSPACE]);
  if (build !== 0) throw new Error(`docker build failed (exit ${build})`);

  // 3. Replace any prior container and run detached with the port
  //    published. `rm -f` is best-effort (no container yet on first run).
  vmShell(vm, ['docker', 'rm', '-f', project]);
  console.log(chalk.cyan(`» starting container ${project}`));
  const run = vmShell(vm, ['docker', 'run', '-d', '--name', project, '-p', `${hostPort}:${containerPort}`, project]);
  if (run !== 0) throw new Error(`docker run failed (exit ${run})`);

  // 4. Persist the sandbox link (additive to any api-server link).
  const sandbox: SandboxLink = {
    type: 'dockerfile',
    vm,
    project,
    services: [{ name: project, port: containerPort, exposed: true, hostPort }],
  };
  const linkPath = writeSandboxLink(sandbox, cwd);

  // 5. Surface the URL. The published port is reachable from the host
  //    directly at the guest IP (docs/up.md §4 v1 — a 127.0.0.1 forward
  //    is a follow-up).
  const ip = guestIp(vm);
  console.log();
  console.log(chalk.green(`Sandbox up — ${project} (dockerfile)`));
  if (ip) {
    console.log(`  ${project}  →  ${chalk.bold(`http://${ip}:${hostPort}`)}   (container :${containerPort})`);
  } else {
    console.log(
      chalk.yellow(
        `  ${project} is running on host port ${hostPort}, but the guest IP isn't known yet.\n` +
          `  Run \`appliance status\` once the VM finishes booting to get the URL.`
      )
    );
  }
  console.log(chalk.dim(`  Logs: appliance logs -f      Stop: appliance down`));
  console.log(chalk.dim(`  Linked: ${linkPath}`));
  // The container runs detached and we return after printing the URL.
  // `--detach` is accepted for forward-compat (no behavioral effect yet);
  // a foreground log stream is a follow-up — use `appliance logs -f`.
}

program.parse(process.argv);
