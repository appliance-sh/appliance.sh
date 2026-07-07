import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { ApplianceBaseType, createApplianceClient } from '@appliance.sh/sdk';
import { mintApiKey, waitForApiServerUrl } from '@appliance.sh/helper';
import { saveCredentials } from './credentials.js';
import { readProfiles } from './profile-store.js';
import { DEFAULT_VM_NAME, ensureVmRuntime, runVmQuiet, type VmRuntimeInfo } from './microvm-up.js';

// Core of `appliance server` — the single-binary local control plane.
//
// Runs the SAME api-server that orchestrates cloud installations as a
// plain host process: state in ~/.appliance/server/data (filesystem
// object store), ready in about a second. Two workload runtimes:
//
//   • `vm` (default): deploys land in the appliance microVM's k3s
//     cluster — images build via the in-guest BuildKit, so no Docker
//     is needed anywhere. The host daemon drives the VM's cluster
//     through its forwarded kubeconfig; the api-server itself stays on
//     the host (no in-cluster bootstrap, no api-server image delivery).
//   • `docker`: the original plain-Docker runtime — deploys as
//     containers on the local Docker daemon (`appliance-base-docker`),
//     builds via `docker build` straight into that daemon.
//
// Same API, same CLI commands, same `local` profile either way — the
// runtime only changes where workloads execute.
//
// This lives in utils (not appliance-server.ts) so `appliance dev` can
// import `ensureServerRunning` without triggering the command module's
// self-executing program.parse.

export const SERVER_PROFILE = 'local';
export const DEFAULT_SERVER_PORT = 8082;
const SERVER_HOST = '127.0.0.1';
const READY_TIMEOUT_MS = 30_000;

export type ServerRuntime = 'vm' | 'docker';
export const DEFAULT_RUNTIME: ServerRuntime = 'vm';

export interface ServerState {
  port: number;
  dataDir: string;
  /** PID of the detached server process; absent after `stop`. */
  pid?: number;
  /** Bootstrap token — lets a later `start` re-mint credentials
   *  against a still-running daemon if the profile was deleted. */
  token: string;
  startedAt?: string;
  /** Workload runtime the running daemon was configured with. Absent
   *  in state files from before the VM runtime existed → 'docker'. */
  runtime?: ServerRuntime;
  /** microVM backing the 'vm' runtime. */
  vmName?: string;
  /** sha256 of the kubeconfig baked into the daemon's env at spawn —
   *  detects a recreated VM whose credentials a running daemon no
   *  longer holds, so `start` knows to respawn. */
  kubeconfigSha?: string;
}

function serverDir(): string {
  return path.join(os.homedir(), '.appliance', 'server');
}

function statePath(): string {
  return path.join(serverDir(), 'server.json');
}

export function logPath(): string {
  return path.join(serverDir(), 'server.log');
}

export function defaultDataDir(): string {
  return path.join(serverDir(), 'data');
}

export function readState(): ServerState | null {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8')) as ServerState;
  } catch {
    return null;
  }
}

export function writeState(state: ServerState): void {
  fs.mkdirSync(serverDir(), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function apiUrlFor(port: number): string {
  return `http://${SERVER_HOST}:${port}`;
}

function baseConfigJson(dataDir: string): string {
  return JSON.stringify({
    name: SERVER_PROFILE,
    type: ApplianceBaseType.ApplianceDocker,
    docker: { dataDir },
  });
}

/**
 * Kubernetes base config pointing the host daemon at the microVM's
 * k3s. Exported (pure) for tests. The kubeconfig is inlined — the VM
 * engine already rewrote its server address to the forwarded
 * 127.0.0.1:<apiPort> — and re-read at every `start`, so a recreated
 * VM is picked up by the kubeconfigSha comparison in
 * ensureServerRunning. The registry ref `localhost:<registryPort>`
 * resolves host-side via the engine's port forward AND guest-side via
 * the containerd mirror + loopback alias, so one image ref serves the
 * build push and the pod pull. `buildkit.addr` is what flips deploys
 * to docker-free builds.
 */
export function vmBaseConfigJson(dataDir: string, vm: VmRuntimeInfo, kubeconfigYaml: string): string {
  return JSON.stringify({
    name: SERVER_PROFILE,
    type: ApplianceBaseType.ApplianceKubernetes,
    kubernetes: {
      kubeconfig: kubeconfigYaml,
      namespace: 'appliance',
      hostnameSuffix: 'appliance.localhost',
      ingressClassName: 'traefik',
      hostPort: vm.ports.hostPort,
      dataDir,
      registry: { url: `localhost:${vm.ports.registryPort}`, insecure: true },
      buildkit: { addr: `tcp://127.0.0.1:${vm.ports.buildkitPort}` },
    },
  });
}

/** Env block the server process runs with. Everything is env-driven
 *  so the embedded daemon and the containerized cloud server share
 *  one configuration surface. */
function serverEnv(port: number, dataDir: string, token: string, baseConfig: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    APPLIANCE_MODE: 'server',
    PORT: String(port),
    HOST: SERVER_HOST,
    BOOTSTRAP_TOKEN: token,
    APPLIANCE_BASE_CONFIG: baseConfig,
  };
}

export async function isReachable(port: number): Promise<boolean> {
  try {
    const res = await fetch(`${apiUrlFor(port)}/bootstrap/status`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

export function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Warn (don't fail) when the Docker daemon isn't reachable — the
 *  server runs fine without it, but every docker-runtime deploy will
 *  error. Only consulted for `--runtime docker`. */
function checkDocker(): void {
  const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    console.log(
      chalk.yellow(
        '⚠ Docker daemon not reachable — the server will start, but deploys will fail until Docker is running. ' +
          '(The default `--runtime vm` needs no Docker at all.)'
      )
    );
  }
}

/**
 * Make sure the `local` profile authenticates against the daemon,
 * minting a first key via the bootstrap token when needed. Mirrors
 * the microVM flow's no-key-sprawl behavior: existing working
 * credentials are kept, not replaced.
 */
export async function ensureCredentials(port: number, token: string): Promise<'reused' | 'minted'> {
  const apiUrl = apiUrlFor(port);
  const existing = readProfiles().profiles[SERVER_PROFILE];
  if (existing) {
    try {
      const client = createApplianceClient({
        baseUrl: apiUrl,
        credentials: { keyId: existing.keyId, secret: existing.secret },
      });
      if ((await client.listProjects()).success) return 'reused';
    } catch {
      // fall through to mint
    }
  }
  const key = await mintApiKey(apiUrl, token, 'Local Server');
  saveCredentials({ apiUrl, keyId: key.id, secret: key.secret }, SERVER_PROFILE);
  return 'minted';
}

export function runtimeLabel(runtime: ServerRuntime, vmName?: string): string {
  return runtime === 'vm'
    ? `microVM '${vmName ?? DEFAULT_VM_NAME}' (k3s) — no Docker needed`
    : 'local Docker daemon (containers on this machine)';
}

export function printBanner(
  port: number,
  dataDir: string,
  opts: { alreadyRunning?: boolean; runtime?: ServerRuntime; vmName?: string; ingressPort?: number } = {}
): void {
  const runtime = opts.runtime ?? 'docker';
  console.log();
  console.log(chalk.green(opts.alreadyRunning ? 'Local server already running.' : 'Local server is up.'));
  console.log(`  API server:  ${apiUrlFor(port)}`);
  console.log(`  Runtime:     ${runtimeLabel(runtime, opts.vmName)}`);
  if (runtime === 'vm') {
    console.log(`  Apps:        http://<project>-<env>.appliance.localhost:${opts.ingressPort ?? 8081}`);
  }
  console.log(`  State:       ${dataDir}`);
  console.log(`  Profile:     ${SERVER_PROFILE}`);
  console.log(`  Deploy:      appliance deploy --profile ${SERVER_PROFILE}`);
  console.log(`  Stop:        appliance server stop`);
}

/**
 * Whether a reachable daemon must be respawned to honor the requested
 * configuration. Pure — exported for tests. A daemon's runtime and (on
 * the vm runtime) the kubeconfig it holds are baked into its env at
 * spawn, so any drift means restart; legacy state files predate
 * `runtime` and were always docker.
 */
export function shouldRestartDaemon(
  prior: { runtime?: ServerRuntime; kubeconfigSha?: string } | null,
  requested: { runtime: ServerRuntime; kubeconfigSha?: string }
): boolean {
  const priorRuntime = prior?.runtime ?? 'docker';
  if (priorRuntime !== requested.runtime) return true;
  if (requested.runtime === 'vm' && prior?.kubeconfigSha !== requested.kubeconfigSha) return true;
  return false;
}

/** Everything runtime-specific `start` needs, resolved up front. For
 *  the vm runtime this boots (or reuses) the microVM and waits for its
 *  cluster + registry — the slow half of a cold start. */
export interface RuntimePrep {
  runtime: ServerRuntime;
  baseConfig: string;
  vmName?: string;
  kubeconfigSha?: string;
  ingressPort?: number;
}

export async function prepareRuntime(runtime: ServerRuntime, dataDir: string): Promise<RuntimePrep> {
  if (runtime === 'docker') {
    checkDocker();
    return { runtime, baseConfig: baseConfigJson(dataDir) };
  }
  const vm = await ensureVmRuntime(DEFAULT_VM_NAME);
  // Publish any configured egress policy — best-effort and quiet: the
  // `appliance` namespace only exists after the first deploy, and a
  // permissive default policy is a harmless no-op anyway.
  runVmQuiet(['egress', 'sync', vm.name]);
  const kubeconfigYaml = fs.readFileSync(vm.kubeconfigPath, 'utf8');
  return {
    runtime,
    baseConfig: vmBaseConfigJson(dataDir, vm, kubeconfigYaml),
    vmName: vm.name,
    kubeconfigSha: createHash('sha256').update(kubeconfigYaml).digest('hex'),
    ingressPort: vm.ports.hostPort,
  };
}

/**
 * How to re-invoke this CLI for the detached server child. Under Node
 * the dispatcher rewrote argv[1] to a fake name, so resolve the
 * appliance-server command module's emitted file (a sibling of this
 * utils dir) and run it directly; under a bun single-binary,
 * import.meta.url isn't a real file and execPath IS the CLI — route
 * back through the `server` subcommand.
 */
function selfInvocation(runArgs: string[]): { cmd: string; args: string[] } {
  // Under a bun single-binary, import.meta.url points into the virtual
  // bunfs — which exists()-checks true — so the Node branch below would
  // spawn the CLI with that bogus path as argv[1] and the dispatcher
  // would parse `run` as an unknown top-level command (printing help)
  // instead of `server run`. execPath IS the CLI there, so route back
  // through the `server` subcommand. Only the plain-Node dev path (where
  // the dispatcher rewrote argv[1] to a fake name) needs the self-file.
  if (!process.versions.bun) {
    try {
      const serverModule = fileURLToPath(new URL('../appliance-server.js', import.meta.url));
      if (fs.existsSync(serverModule)) {
        return { cmd: process.execPath, args: [serverModule, ...runArgs] };
      }
    } catch {
      // import.meta.url isn't file-resolvable — fall through
    }
  }
  return { cmd: process.execPath, args: ['server', ...runArgs] };
}

/** Start the api-server in-process (blocks for the process lifetime). */
export async function runInProcess(port: number, dataDir: string, token: string, baseConfig: string): Promise<void> {
  fs.mkdirSync(dataDir, { recursive: true });
  Object.assign(process.env, serverEnv(port, dataDir, token, baseConfig));
  // Import AFTER the env is staged: the api-server reads
  // APPLIANCE_BASE_CONFIG lazily, but PORT/HOST/mode at startServer().
  const { startServer } = await import('@appliance.sh/api-server');
  const server = startServer();
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

async function startDetached(port: number, dataDir: string, token: string, baseConfig: string): Promise<number> {
  fs.mkdirSync(serverDir(), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const out = fs.openSync(logPath(), 'a');
  const { cmd, args } = selfInvocation(['run']);
  const child = spawn(cmd, args, {
    detached: true,
    stdio: ['ignore', out, out],
    env: serverEnv(port, dataDir, token, baseConfig),
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(out);
  if (child.pid === undefined) {
    throw new Error('failed to spawn the server process');
  }
  return child.pid;
}

/** Kill the recorded daemon process and wait for its port to free up.
 *  Returns false when nothing we own answers (someone else's server). */
async function stopDaemonProcess(state: ServerState): Promise<boolean> {
  if (!state.pid || !isProcessAlive(state.pid)) return false;
  process.kill(state.pid);
  const deadline = Date.now() + 10_000;
  while (isProcessAlive(state.pid) || (await isReachable(state.port))) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return true;
}

export interface EnsureServerOptions {
  runtime?: ServerRuntime;
  port?: number;
  dataDir?: string;
  /** Suppress the closing banner (programmatic callers print their own). */
  quiet?: boolean;
}

/**
 * The programmatic core of `appliance server start`: bring the runtime
 * up (booting the microVM when needed), ensure a daemon with the
 * requested configuration is serving, and reconcile the `local`
 * profile's credentials. Idempotent — an already-correct daemon is a
 * cheap no-op; a runtime/kubeconfig mismatch triggers a clean restart.
 * `appliance dev` calls this before its first deploy.
 */
export async function ensureServerRunning(opts: EnsureServerOptions = {}): Promise<{
  apiUrl: string;
  port: number;
  runtime: ServerRuntime;
}> {
  const prior = readState();
  const port = opts.port ?? prior?.port ?? DEFAULT_SERVER_PORT;
  const runtime = opts.runtime ?? DEFAULT_RUNTIME;
  const dataDir = path.resolve(opts.dataDir ?? prior?.dataDir ?? defaultDataDir());
  const token = prior?.token ?? randomBytes(24).toString('hex');

  // Resolve the runtime first: on the vm runtime this boots/reuses the
  // microVM — required even when the daemon already runs (the VM may
  // have been stopped independently) — and yields the fresh kubeconfig
  // the staleness check below compares against.
  const prep = await prepareRuntime(runtime, dataDir);

  // Already serving? When the daemon matches the requested runtime and
  // (for vm) still holds the current kubeconfig, reconcile credentials
  // and stop there — a second `start` is a cheap no-op, not a second
  // process. Any mismatch means the daemon's env is stale: restart it.
  if (await isReachable(port)) {
    if (!shouldRestartDaemon(prior, prep)) {
      const outcome = await ensureCredentials(port, token);
      if (outcome === 'minted') {
        console.log(chalk.dim(`credentials minted; profile '${SERVER_PROFILE}' updated`));
      }
      if (!opts.quiet) {
        printBanner(port, dataDir, {
          alreadyRunning: true,
          runtime,
          vmName: prep.vmName,
          ingressPort: prep.ingressPort,
        });
      }
      return { apiUrl: apiUrlFor(port), port, runtime };
    }
    const priorRuntime = prior?.runtime ?? 'docker';
    const reason =
      priorRuntime !== runtime ? `runtime changed (${priorRuntime} → ${runtime})` : 'the microVM was recreated';
    console.log(chalk.yellow(`» ${reason} — restarting the local server`));
    if (!prior || !(await stopDaemonProcess(prior))) {
      console.error(
        chalk.red(
          `A server answers on port ${port} but this CLI doesn't own it — stop it where it was started, or pass --port.`
        )
      );
      process.exit(1);
    }
    if (priorRuntime === 'docker' && runtime === 'vm') {
      console.log(
        chalk.dim('Existing docker-runtime apps keep running under Docker — redeploy to move them into the VM.')
      );
    }
  }

  console.log(chalk.cyan('» starting the local server'));
  const pid = await startDetached(port, dataDir, token, prep.baseConfig);
  writeState({
    port,
    dataDir,
    pid,
    token,
    startedAt: new Date().toISOString(),
    runtime,
    vmName: prep.vmName,
    kubeconfigSha: prep.kubeconfigSha,
  });
  try {
    await waitForApiServerUrl(apiUrlFor(port), READY_TIMEOUT_MS);
  } catch {
    console.error(chalk.red(`Server did not become ready on port ${port} within ${READY_TIMEOUT_MS / 1000}s.`));
    console.error(chalk.dim(`Check the log: appliance server logs   (${logPath()})`));
    process.exit(1);
  }
  const outcome = await ensureCredentials(port, token);
  if (outcome === 'minted') {
    console.log(`${chalk.green('✓')} credentials saved to profile ${chalk.bold(SERVER_PROFILE)}`);
  } else {
    console.log(`${chalk.green('✓')} profile ${chalk.bold(SERVER_PROFILE)} already authenticated`);
  }
  if (!opts.quiet) {
    printBanner(port, dataDir, { runtime, vmName: prep.vmName, ingressPort: prep.ingressPort });
  }
  return { apiUrl: apiUrlFor(port), port, runtime };
}
