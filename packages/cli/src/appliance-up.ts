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
  devcontainerPublishedPorts,
  dnsLabel,
  ensureSandboxVm,
  findComposeFile,
  guestIp,
  parseComposeDependsOn,
  parseComposePsJson,
  parseDevcontainerUp,
  parseExposedPort,
  vmShell,
  vmShellCapture,
} from './utils/sandbox.js';
import type { SandboxService } from './utils/link.js';

// `appliance up` — near-zero-config local run of a repo's own container
// definition in the shared sandbox microVM (docs/up.md §2, §5, §6 A).
//
// This version implements the Dockerfile, docker-compose, and
// devcontainer slices: detect the project type in cwd, bring up the
// sandbox VM with the workspace shared + docker provisioned, build + run
// in-guest against the mounted workspace (a single image, `docker
// compose up` for a compose project, or the official `@devcontainers/cli`
// for a devcontainer), publish the declared ports, persist a `sandbox`
// block to link.json, and print the host-reachable URL map.

ensureHelperBinOnPath();

const program = new Command();

program
  .description('build + run this project (Dockerfile or docker-compose) in the shared sandbox microVM')
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
      'no Dockerfile or compose file found in this directory.\n' +
        "`appliance up` runs a project's own container definition — add a Dockerfile / compose file, or cd into the project root."
    );
  }
  if (type === 'compose') {
    await runComposeUp(opts, cwd);
    return;
  }
  if (type === 'devcontainer') {
    await runDevcontainerUp(opts, cwd);
    return;
  }
  if (type !== 'dockerfile') {
    // Unreachable today (detectProjectType only returns the four types),
    // but guard rather than fall through to the Dockerfile path.
    console.log(`detected ${type}: not yet supported by \`up\``);
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

/**
 * Compose bring-up (docs/up.md §6 B): ensure the sandbox VM, run
 * `docker compose up -d --build` in-guest against the shared workspace,
 * then surface a per-service URL map from `docker compose ps`. The
 * project name is the deterministic cwd-basename label, isolating this
 * project inside the shared dockerd exactly as compose isolates projects
 * on one daemon (docs/up.md §3).
 */
async function runComposeUp(opts: { vm: string }, cwd: string): Promise<void> {
  const composeFile = findComposeFile(cwd);
  if (!composeFile) {
    // detectProjectType said 'compose', so this is unreachable in
    // practice — guard anyway rather than build a bogus -f path.
    throw new Error('no compose file found in this directory.');
  }
  const project = dnsLabel(path.basename(cwd));
  const guestComposePath = `${GUEST_WORKSPACE}/${composeFile}`;
  const vm = opts.vm;

  console.log(chalk.bold(`Detected: docker-compose (${composeFile} → ${project})`));

  // 1. Boot/ensure the sandbox VM with docker + this workspace mounted.
  await ensureSandboxVm(vm, cwd);

  // 2. Build + start the whole project in-guest, streaming output.
  console.log(chalk.cyan(`» docker compose up -d --build (${project})`));
  const up = vmShell(vm, ['docker', 'compose', '-f', guestComposePath, '-p', project, 'up', '-d', '--build']);
  if (up !== 0) throw new Error(`docker compose up failed (exit ${up})`);

  // 3. Introspect the running project for the per-service URL map.
  const ps = vmShellCapture(vm, [
    'docker',
    'compose',
    '-f',
    guestComposePath,
    '-p',
    project,
    'ps',
    '--format',
    'json',
    '--all',
  ]);
  const psServices = ps.status === 0 ? parseComposePsJson(ps.stdout) : [];
  const dependsOn = parseComposeDependsOn(path.join(cwd, composeFile));

  // Model each service for link.json. A service may publish 0..N ports;
  // we record the first published mapping as the service's port/hostPort
  // (the cloud-promotion shape is one port per workload, docs/up.md §5).
  const services: SandboxService[] = psServices.map((svc) => {
    const first = svc.ports[0];
    const deps = dependsOn[svc.service];
    return {
      name: svc.service,
      ...(first ? { port: first.containerPort, exposed: true, hostPort: first.hostPort } : { exposed: false }),
      ...(deps && deps.length ? { dependsOn: deps } : {}),
    };
  });

  // 4. Persist the sandbox link (additive to any api-server link).
  const sandbox = {
    type: 'compose' as const,
    vm,
    project,
    services,
    composeFile,
  };
  const linkPath = writeSandboxLink(sandbox, cwd);

  // 5. Surface the URL map. Published ports are reachable from the host
  //    at the guest IP (docs/up.md §4 v1).
  const ip = guestIp(vm);
  console.log();
  console.log(chalk.green(`Sandbox up — ${project} (compose)`));
  if (services.length === 0) {
    console.log(chalk.yellow('  no services reported by `docker compose ps` — check `appliance logs`.'));
  }
  const nameWidth = Math.max(4, ...services.map((s) => s.name.length));
  for (const svc of services) {
    const name = svc.name.padEnd(nameWidth);
    if (svc.exposed && svc.hostPort) {
      if (ip) {
        console.log(`  ${name}  →  ${chalk.bold(`http://${ip}:${svc.hostPort}`)}   (${svc.name} :${svc.port})`);
      } else {
        console.log(`  ${name}  published on host port ${svc.hostPort} (:${svc.port}) — guest IP not known yet`);
      }
    } else {
      console.log(`  ${name}  ${chalk.dim('internal (not published)')}`);
    }
  }
  if (!ip && services.some((s) => s.exposed)) {
    console.log(chalk.yellow('  Run `appliance status` once the VM finishes booting to get the URLs.'));
  }
  console.log(chalk.dim(`  Logs: appliance logs -f      Stop: appliance down`));
  console.log(chalk.dim(`  Linked: ${linkPath}`));
}

/**
 * Devcontainer bring-up (docs/up.md §6 C): ensure the sandbox VM, ensure
 * the official `@devcontainers/cli` is installed in-guest, then run
 * `devcontainer up --workspace-folder /persist/workspace` against the
 * shared workspace so the repo's `devcontainer.json` toolchain comes up
 * verbatim. The CLI drives the in-guest dockerd exactly as our
 * Dockerfile/compose paths do, so the resulting container coexists with
 * other sandbox projects on the same daemon (docs/up.md §3).
 *
 * `devcontainer up` is idempotent and prints a machine-readable JSON
 * result on stdout; we parse the last result object to get the
 * `containerId` + `outcome`, then surface any published ports as
 * host-reachable URLs and persist the link for `down`/`logs`/`shell`.
 */
async function runDevcontainerUp(opts: { vm: string }, cwd: string): Promise<void> {
  const project = dnsLabel(path.basename(cwd));
  const vm = opts.vm;

  console.log(chalk.bold(`Detected: devcontainer (${project})`));

  // 1. Boot/ensure the sandbox VM with docker + this workspace mounted.
  await ensureSandboxVm(vm, cwd);

  // 2. Ensure the devcontainers CLI is present, then bring the
  //    devcontainer up — in ONE in-guest invocation, output captured.
  //    node + npm ship in the dev VM; `npm i -g @devcontainers/cli` (only
  //    when the binary is missing) hits the network, which is allowed.
  //    The merged PTY stream carries both the progress log and the final
  //    `{"outcome":...,"containerId":...}` JSON result we parse. (Running
  //    `up` twice raced the result line; installing in a separate shell
  //    raced the PATH update — folding both into one shell fixes both.)
  console.log(
    chalk.cyan(`» devcontainer up --workspace-folder ${GUEST_WORKSPACE} (installing @devcontainers/cli if needed)…`)
  );
  const script =
    'command -v devcontainer >/dev/null 2>&1 || npm install -g @devcontainers/cli >/dev/null 2>&1; ' +
    `devcontainer up --workspace-folder ${GUEST_WORKSPACE}`;
  const result = vmShellCapture(vm, ['sh', '-lc', script]);
  const parsed = parseDevcontainerUp(result.stdout);
  if (!parsed) {
    throw new Error('devcontainer up did not report a result.\n' + `Raw output:\n${result.stdout || '(empty)'}`);
  }
  if (parsed.outcome !== 'success') {
    throw new Error(`devcontainer up failed: ${parsed.message ?? parsed.outcome}`);
  }
  const containerId = parsed.containerId;
  if (!containerId) {
    throw new Error('devcontainer up succeeded but reported no containerId.');
  }

  // 5. Discover any published ports so we can surface host-reachable URLs.
  const published = devcontainerPublishedPorts(vm, containerId);

  // 6. Persist the sandbox link (additive to any api-server link).
  const sandbox: SandboxLink = {
    type: 'devcontainer',
    vm,
    project,
    containerId,
    workspace: GUEST_WORKSPACE,
    services: published.map((p) => ({
      name: project,
      port: p.containerPort,
      exposed: true,
      hostPort: p.hostPort,
    })),
  };
  const linkPath = writeSandboxLink(sandbox, cwd);

  // 7. Surface the result. A devcontainer often publishes no ports (it's
  //    a workspace you shell into) — point at `appliance shell` then.
  const ip = guestIp(vm);
  console.log();
  console.log(chalk.green(`Sandbox up — ${project} (devcontainer)`));
  console.log(`  Container:  ${chalk.bold(containerId.slice(0, 12))}`);
  if (published.length) {
    for (const p of published) {
      if (ip) {
        console.log(`  ${project}  →  ${chalk.bold(`http://${ip}:${p.hostPort}`)}   (container :${p.containerPort})`);
      } else {
        console.log(
          `  ${project}  published on host port ${p.hostPort} (:${p.containerPort}) — guest IP not known yet`
        );
      }
    }
    if (!ip) console.log(chalk.yellow('  Run `appliance status` once the VM finishes booting to get the URLs.'));
  } else {
    console.log(chalk.dim('  no published ports — enter the container with `appliance shell`'));
  }
  console.log(chalk.dim(`  Enter: appliance shell       Logs: appliance logs -f      Stop: appliance down`));
  console.log(chalk.dim(`  Linked: ${linkPath}`));
}

program.parse(process.argv);
