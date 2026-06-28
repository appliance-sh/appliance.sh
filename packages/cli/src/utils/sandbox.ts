import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import chalk from 'chalk';

// Shared plumbing for the `appliance up`/`down`/`logs`/`status` sandbox
// commands (docs/up.md). These drive the in-guest Docker engine inside a
// single shared sandbox microVM, building + running a project's own
// container definition from the host workspace shared over VirtioFS.
//
// The binary resolution + run helpers deliberately mirror
// `appliance-vm.ts` (the microVM engine driver) so both surfaces resolve
// the same `appliance-vm` Rust binary the same way.

/** The shared default sandbox VM all `appliance up` projects coexist in
 *  (docs/up.md §3). A dedicated name (not the api-server `appliance` VM)
 *  keeps the sandbox dockerd separate from the deploy/k3s runtime. */
export const DEFAULT_SANDBOX_VM = 'appliance-sbx';

/** Guest path the host workspace is shared at (set by `--mount`). */
const GUEST_WORKSPACE = '/persist/workspace';

/** Marker the in-guest bootstrap drops once dockerd is provisioned. */
const DOCKER_READY_MARKER = '/persist/.docker-ready';

// ---- appliance-vm binary + run helpers (mirrors appliance-vm.ts) -------

/** Resolve the `appliance-vm` binary: explicit override → managed
 *  install → PATH → repo build. Identical order to appliance-vm.ts. */
export function vmBinary(): string {
  const candidates = [
    process.env.APPLIANCE_VM,
    path.join(os.homedir(), '.appliance', 'bin', 'appliance-vm'),
    'appliance-vm',
    path.resolve('packages/vm/target/release/appliance-vm'),
    path.resolve('packages/vm/target/debug/appliance-vm'),
  ].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (probe.status === 0) return candidate;
  }
  console.error(
    chalk.red(
      'appliance-vm binary not found. Build it with `cargo build && ./scripts/sign-dev.sh` in packages/vm, or set APPLIANCE_VM.'
    )
  );
  process.exit(1);
}

export function vmDir(name: string): string {
  return path.join(os.homedir(), '.appliance', 'vm', name);
}

/** Run an `appliance-vm` subcommand, inheriting stdio. Returns its code. */
export function runVm(args: string[]): number {
  const r = spawnSync(vmBinary(), args, { stdio: 'inherit' });
  return r.status ?? 1;
}

/** Run an `appliance-vm` subcommand and capture stdout (stderr passes
 *  through). Returns the exit code + trimmed stdout. */
export function runVmCapture(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(vmBinary(), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  return { status: r.status ?? 1, stdout: (r.stdout ?? '').trim() };
}

/** Run a command inside the VM via `appliance-vm shell <vm> -- <cmd...>`,
 *  inheriting stdio (build/run output streams straight through). */
export function vmShell(vm: string, command: string[]): number {
  return runVm(['shell', vm, '--', ...command]);
}

/** Run a command in the guest and capture its stdout — the quiet probe
 *  behind readiness checks and `status`. */
export function vmShellCapture(vm: string, command: string[]): { status: number; stdout: string } {
  return runVmCapture(['shell', vm, '--', ...command]);
}

// ---- VM spec / state ---------------------------------------------------

interface VmSpecOnDisk {
  devMount?: string;
  docker?: boolean;
}

/** The persisted spec of a VM (`vm.json`), or null when undefined. */
function readVmSpec(name: string): VmSpecOnDisk | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(vmDir(name), 'vm.json'), 'utf8')) as VmSpecOnDisk;
  } catch {
    return null;
  }
}

export interface VmStatusJson {
  exists: boolean;
  running: boolean;
  clusterReady?: boolean;
}

/** Parse `appliance-vm status <vm>` JSON, or null when unreadable. */
export function vmStatus(name: string): VmStatusJson | null {
  const r = runVmCapture(['status', name]);
  try {
    return JSON.parse(r.stdout) as VmStatusJson;
  } catch {
    return null;
  }
}

/** The guest's IP, persisted by the engine at boot
 *  (`~/.appliance/vm/<vm>/guest-ip`). Null when the VM hasn't booted far
 *  enough to discover its lease. Surfaced as the host-reachable URL host
 *  for published ports (docs/up.md §4 — the v1 guest-IP URL). */
export function guestIp(name: string): string | null {
  try {
    const ip = fs.readFileSync(path.join(vmDir(name), 'guest-ip'), 'utf8').trim();
    return ip || null;
  } catch {
    return null;
  }
}

// ---- project detection -------------------------------------------------

export type ProjectType = 'dockerfile' | 'compose' | 'devcontainer' | 'none';

const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const DEVCONTAINER_FILES = ['.devcontainer/devcontainer.json', '.devcontainer.json'];

/** Resolve the project type in cwd by docs/up.md §1 precedence
 *  (compose → devcontainer → dockerfile). Compose/devcontainer are
 *  detected but not run by this version. */
export function detectProjectType(dir: string): ProjectType {
  if (COMPOSE_FILES.some((f) => fs.existsSync(path.join(dir, f)))) return 'compose';
  if (DEVCONTAINER_FILES.some((f) => fs.existsSync(path.join(dir, f)))) return 'devcontainer';
  if (fs.existsSync(path.join(dir, 'Dockerfile'))) return 'dockerfile';
  return 'none';
}

/** Parse the first `EXPOSE <port>` from a Dockerfile, or null when none.
 *  EXPOSE may carry `<port>/<proto>` and multiple ports — we take the
 *  first numeric token of the first EXPOSE line. */
export function parseExposedPort(dockerfilePath: string): number | null {
  let text: string;
  try {
    text = fs.readFileSync(dockerfilePath, 'utf8');
  } catch {
    return null;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!/^EXPOSE\s/i.test(line)) continue;
    const token = line
      .replace(/^EXPOSE\s+/i, '')
      .trim()
      .split(/\s+/)[0];
    const port = Number.parseInt((token ?? '').split('/')[0], 10);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  }
  return null;
}

// ---- identity + ports --------------------------------------------------

/** Normalize a string to a DNS-1123 label (lowercase alphanumeric + `-`,
 *  edges trimmed). The deterministic project id used for the container
 *  name + link.json project (docs/up.md §5). */
export function dnsLabel(input: string): string {
  const label = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  return label || 'app';
}

/** A deterministic host port in the 8100–8999 range, derived from the
 *  project name so a project's URL is stable across `up`s without
 *  colliding with the reserved 8081/6443/5052/5053 ports. `--host-port`
 *  overrides it. */
export function deterministicHostPort(project: string): number {
  let h = 0;
  for (const ch of project) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 8100 + (h % 900);
}

// ---- VM bring-up + docker readiness ------------------------------------

/**
 * Ensure the shared sandbox VM is up with docker provisioned and the
 * project workspace mounted, then wait for the in-guest dockerd. The
 * mount applies on next boot, so if the VM is already running with a
 * different mount we stop it and re-up to remount (docs/up.md §3 and the
 * verified runtime recipe).
 *
 * Returns once `docker version` works in the guest.
 */
export async function ensureSandboxVm(vm: string, projectDir: string, timeoutMs = 300_000): Promise<void> {
  const desiredMount = path.resolve(projectDir);
  const status = vmStatus(vm);
  const spec = readVmSpec(vm);
  const running = status?.running ?? false;
  const currentMount = spec?.devMount ? path.resolve(spec.devMount) : null;

  // A running VM only picks up a new mount on its next boot — restart it
  // when the share points elsewhere so the build sees this project.
  if (running && currentMount !== desiredMount) {
    console.log(
      chalk.yellow(`» sandbox VM '${vm}' is mounted elsewhere (${currentMount ?? 'none'}); restarting to remount`)
    );
    const stop = runVm(['stop', vm]);
    if (stop !== 0) throw new Error(`failed to stop sandbox VM '${vm}' to remount the workspace`);
  }

  console.log(chalk.cyan(`» bringing up sandbox VM '${vm}' with docker + ${desiredMount} → ${GUEST_WORKSPACE}`));
  const code = runVm(['up', vm, '--docker', '--mount', desiredMount]);
  if (code !== 0) throw new Error(`appliance-vm up '${vm}' failed (exit ${code})`);

  await waitForDocker(vm, timeoutMs);
}

/** Poll until the in-guest dockerd is provisioned (`.docker-ready`
 *  marker present and `docker version` answers). Provisioning is
 *  backgrounded so it can lag the cluster by up to ~1 min on a cold
 *  cache. */
export async function waitForDocker(vm: string, timeoutMs: number): Promise<void> {
  console.log(chalk.cyan('» waiting for the in-guest docker engine'));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const marker = vmShellCapture(vm, ['test', '-f', DOCKER_READY_MARKER]);
    if (marker.status === 0) {
      const ver = vmShellCapture(vm, ['docker', 'version']);
      if (ver.status === 0) {
        console.log(`${chalk.green('✓')} docker engine ready`);
        return;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `the in-guest docker engine never became ready in '${vm}' (waited ${Math.round(timeoutMs / 1000)}s).\n` +
          'Provisioning runs in the background on first boot and pulls packages from the network — ' +
          'inspect it with `appliance vm console --name ' +
          vm +
          '` or retry once the cache is warm.'
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

export { GUEST_WORKSPACE };

// ---- status ------------------------------------------------------------

/**
 * Print the sandbox state for the cwd project: the VM state, the
 * container's `docker ps` line, and the host-reachable URL (docs/up.md
 * §2/§4). Returns the process exit code. Called by `appliance status`
 * when a sandbox link is present in cwd.
 */
export async function runSandboxStatus(opts: { json?: boolean } = {}): Promise<number> {
  // Lazy import to avoid a cycle with link.ts importing nothing here.
  const { readSandboxLink } = await import('./link.js');
  const sandbox = readSandboxLink();
  if (!sandbox) {
    console.error(chalk.red('no sandbox link in this folder — run `appliance up` first.'));
    return 1;
  }
  const vm = sandbox.vm;
  const status = vmStatus(vm);
  const ip = guestIp(vm);
  const service = sandbox.services[0];
  const url = ip && service?.hostPort ? `http://${ip}:${service.hostPort}` : null;

  // `docker ps` filtered to this project's container, formatted as a
  // single tab-separated line for parsing + display.
  const ps = vmShellCapture(vm, [
    'docker',
    'ps',
    '-a',
    '--filter',
    `name=^${sandbox.project}$`,
    '--format',
    '{{.Names}}\t{{.Status}}\t{{.Ports}}',
  ]);
  const psLine = ps.status === 0 ? ps.stdout : '';
  const [, state, ports] = psLine ? psLine.split('\t') : [];

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          project: sandbox.project,
          type: sandbox.type,
          vm,
          vmRunning: status?.running ?? false,
          container: sandbox.project,
          state: state ?? null,
          ports: ports ?? null,
          url,
          services: sandbox.services,
        },
        null,
        2
      )
    );
    return 0;
  }

  console.log(chalk.bold(`Sandbox — ${sandbox.project} (${sandbox.type})`));
  console.log(`  VM:         ${vm} (${status?.running ? chalk.green('running') : chalk.dim('stopped')})`);
  if (!psLine) {
    console.log(`  Container:  ${chalk.yellow('not found')} — run \`appliance up\` to start it`);
    return 0;
  }
  console.log(`  Container:  ${sandbox.project} (${state ?? 'unknown'})`);
  if (ports) console.log(`  Ports:      ${ports}`);
  if (url) console.log(`  URL:        ${chalk.bold(url)}`);
  else console.log(chalk.dim('  URL:        guest IP not known yet — is the VM finished booting?'));
  return 0;
}
