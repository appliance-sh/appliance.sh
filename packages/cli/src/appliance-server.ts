import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { ApplianceBaseType, createApplianceClient } from '@appliance.sh/sdk';
import { mintApiKey, waitForApiServerUrl } from '@appliance.sh/helper';
import { saveCredentials } from './utils/credentials.js';
import { readProfiles } from './utils/profile-store.js';

// `appliance server` — the single-binary local control plane.
//
// Runs the SAME api-server that orchestrates cloud installations as a
// plain host process: state in ~/.appliance/server/data (filesystem
// object store), deploys as containers on the local Docker daemon
// (`appliance-base-docker`). No microVM, no k3s, no registry, no
// image delivery — `appliance server start` is ready in about a
// second, and `appliance deploy --profile local` builds straight into
// the daemon the server deploys from.
//
// This is the lightweight alternative to `appliance init`'s microVM
// runtime: same API, same CLI commands, same profiles mechanism —
// less isolation (containers share the host daemon), zero bring-up.

const SERVER_PROFILE = 'local';
const DEFAULT_SERVER_PORT = 8082;
const SERVER_HOST = '127.0.0.1';
const READY_TIMEOUT_MS = 30_000;

interface ServerState {
  port: number;
  dataDir: string;
  /** PID of the detached server process; absent after `stop`. */
  pid?: number;
  /** Bootstrap token — lets a later `start` re-mint credentials
   *  against a still-running daemon if the profile was deleted. */
  token: string;
  startedAt?: string;
}

function serverDir(): string {
  return path.join(os.homedir(), '.appliance', 'server');
}

function statePath(): string {
  return path.join(serverDir(), 'server.json');
}

function logPath(): string {
  return path.join(serverDir(), 'server.log');
}

function defaultDataDir(): string {
  return path.join(serverDir(), 'data');
}

function readState(): ServerState | null {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8')) as ServerState;
  } catch {
    return null;
  }
}

function writeState(state: ServerState): void {
  fs.mkdirSync(serverDir(), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2), { mode: 0o600 });
}

function apiUrlFor(port: number): string {
  return `http://${SERVER_HOST}:${port}`;
}

function baseConfigJson(dataDir: string): string {
  return JSON.stringify({
    name: SERVER_PROFILE,
    type: ApplianceBaseType.ApplianceDocker,
    docker: { dataDir },
  });
}

/** Env block the server process runs with. Everything is env-driven
 *  so the embedded daemon and the containerized cloud server share
 *  one configuration surface. */
function serverEnv(port: number, dataDir: string, token: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    APPLIANCE_MODE: 'server',
    PORT: String(port),
    HOST: SERVER_HOST,
    BOOTSTRAP_TOKEN: token,
    APPLIANCE_BASE_CONFIG: baseConfigJson(dataDir),
  };
}

async function isReachable(port: number): Promise<boolean> {
  try {
    const res = await fetch(`${apiUrlFor(port)}/bootstrap/status`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Warn (don't fail) when the Docker daemon isn't reachable — the
 *  server runs fine without it, but every deploy will error. */
function checkDocker(): void {
  const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    console.log(
      chalk.yellow(
        '⚠ Docker daemon not reachable — the server will start, but deploys will fail until Docker is running.'
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
async function ensureCredentials(port: number, token: string): Promise<'reused' | 'minted'> {
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

function printBanner(port: number, dataDir: string, opts: { alreadyRunning?: boolean } = {}): void {
  console.log();
  console.log(chalk.green(opts.alreadyRunning ? 'Local server already running.' : 'Local server is up.'));
  console.log(`  API server:  ${apiUrlFor(port)}`);
  console.log(`  Runtime:     local Docker daemon (containers on this machine)`);
  console.log(`  State:       ${dataDir}`);
  console.log(`  Profile:     ${SERVER_PROFILE}`);
  console.log(`  Deploy:      appliance deploy --profile ${SERVER_PROFILE}`);
  console.log(`  Stop:        appliance server stop`);
}

/**
 * How to re-invoke this CLI for the detached server child. Under Node
 * the dispatcher rewrote argv[1] to a fake name, so resolve this
 * module's own emitted file and run it directly; under a bun
 * single-binary, import.meta.url isn't a real file and execPath IS
 * the CLI — route back through the `server` subcommand.
 */
function selfInvocation(runArgs: string[]): { cmd: string; args: string[] } {
  try {
    const self = fileURLToPath(import.meta.url);
    if (fs.existsSync(self)) {
      return { cmd: process.execPath, args: [self, ...runArgs] };
    }
  } catch {
    // compiled binary — import.meta.url isn't file-resolvable
  }
  return { cmd: process.execPath, args: ['server', ...runArgs] };
}

/** Start the api-server in-process (blocks for the process lifetime). */
async function runInProcess(port: number, dataDir: string, token: string): Promise<void> {
  fs.mkdirSync(dataDir, { recursive: true });
  Object.assign(process.env, serverEnv(port, dataDir, token));
  // Import AFTER the env is staged: the api-server reads
  // APPLIANCE_BASE_CONFIG lazily, but PORT/HOST/mode at startServer().
  const { startServer } = await import('@appliance.sh/api-server');
  const server = startServer();
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

async function startDetached(port: number, dataDir: string, token: string): Promise<number> {
  fs.mkdirSync(serverDir(), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const out = fs.openSync(logPath(), 'a');
  const { cmd, args } = selfInvocation(['run']);
  const child = spawn(cmd, args, {
    detached: true,
    stdio: ['ignore', out, out],
    env: serverEnv(port, dataDir, token),
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(out);
  if (child.pid === undefined) {
    throw new Error('failed to spawn the server process');
  }
  return child.pid;
}

async function cmdStart(opts: { port: string; dataDir?: string; foreground?: boolean }): Promise<void> {
  const prior = readState();
  const port = Number.parseInt(opts.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(chalk.red(`Invalid --port: ${opts.port}`));
    process.exit(1);
  }
  const dataDir = path.resolve(opts.dataDir ?? prior?.dataDir ?? defaultDataDir());
  const token = prior?.token ?? randomBytes(24).toString('hex');

  // Already serving? Reconcile credentials and stop there — a second
  // `start` should be a cheap no-op, not a second process.
  if (await isReachable(port)) {
    const outcome = await ensureCredentials(port, token);
    if (outcome === 'minted') {
      console.log(chalk.dim(`credentials minted; profile '${SERVER_PROFILE}' updated`));
    }
    printBanner(port, dataDir, { alreadyRunning: true });
    return;
  }

  checkDocker();

  if (opts.foreground) {
    writeState({ port, dataDir, pid: process.pid, token, startedAt: new Date().toISOString() });
    await runInProcess(port, dataDir, token);
    await ensureCredentials(port, token);
    printBanner(port, dataDir);
    console.log(chalk.dim('  (foreground mode — Ctrl-C stops the server)'));
    return; // keep running; the listener holds the event loop open
  }

  console.log(chalk.cyan('» starting the local server'));
  const pid = await startDetached(port, dataDir, token);
  writeState({ port, dataDir, pid, token, startedAt: new Date().toISOString() });
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
  printBanner(port, dataDir);
}

async function cmdStop(): Promise<void> {
  const state = readState();
  if (!state) {
    console.log('No local server state found — nothing to stop.');
    return;
  }
  const reachable = await isReachable(state.port);
  if (!isProcessAlive(state.pid) && !reachable) {
    console.log('Local server is not running.');
    writeState({ ...state, pid: undefined });
    return;
  }
  if (state.pid && isProcessAlive(state.pid)) {
    process.kill(state.pid);
    console.log(`${chalk.green('✓')} server stopped (pid ${state.pid})`);
  } else {
    console.error(
      chalk.yellow(
        `A server answers on port ${state.port} but its recorded pid is gone — it was started by another process. Stop it there.`
      )
    );
    process.exit(1);
  }
  writeState({ ...state, pid: undefined });
  console.log(chalk.dim('Deployed containers keep running — `appliance destroy` removes them per environment.'));
}

async function cmdStatus(): Promise<void> {
  const state = readState();
  if (!state) {
    console.log(`Local server: ${chalk.dim('never started')}`);
    console.log(`Start it with: appliance server start`);
    return;
  }
  const reachable = await isReachable(state.port);
  const alive = isProcessAlive(state.pid);
  const status = reachable
    ? chalk.green('running')
    : alive
      ? chalk.yellow('starting (unreachable)')
      : chalk.red('stopped');
  console.log(`Local server: ${status}`);
  console.log(`  API server:  ${apiUrlFor(state.port)}`);
  console.log(`  State:       ${state.dataDir}`);
  console.log(`  Profile:     ${SERVER_PROFILE}`);
  if (state.pid && alive) console.log(`  PID:         ${state.pid}`);
  if (state.startedAt) console.log(`  Started:     ${state.startedAt}`);
  console.log(`  Log:         ${logPath()}`);
  if (!reachable) {
    console.log();
    console.log(`Start it with: appliance server start`);
  }
}

async function cmdLogs(opts: { tail: string; follow?: boolean }): Promise<void> {
  const file = logPath();
  if (!fs.existsSync(file)) {
    console.log('No server log yet — start the server with `appliance server start`.');
    return;
  }
  const tail = Number.parseInt(opts.tail, 10);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const start = Number.isInteger(tail) && tail > 0 ? Math.max(0, lines.length - tail - 1) : 0;
  process.stdout.write(lines.slice(start).join('\n'));
  if (!opts.follow) return;

  // Follow by polling file growth — portable (fs.watch is unreliable
  // for appends on some platforms) and cheap at 500ms.
  let offset = fs.statSync(file).size;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const size = fs.statSync(file).size;
    if (size < offset) offset = 0; // truncated/rotated — restart from the top
    if (size > offset) {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        process.stdout.write(buf.toString('utf8'));
      } finally {
        fs.closeSync(fd);
      }
      offset = size;
    }
  }
}

const program = new Command();

program
  .name('appliance server')
  .description('run the Appliance control plane as a lightweight local daemon (no VM, no k3s)');

program
  .command('start')
  .description('start the local server (detached) and save the `local` credential profile')
  .option('--port <port>', 'port to listen on', String(DEFAULT_SERVER_PORT))
  .option('--data-dir <path>', 'state directory (default: ~/.appliance/server/data)')
  .option('--foreground', 'run in the foreground instead of detaching')
  .action(cmdStart);

// Hidden internal entry the detached spawn re-invokes: all
// configuration arrives via the environment (serverEnv), so this just
// boots the embedded api-server and stays in the foreground.
program
  .command('run', { hidden: true })
  .description('internal: run the server from environment configuration')
  .action(async () => {
    const { startServer } = await import('@appliance.sh/api-server');
    startServer();
  });

program.command('stop').description('stop the local server (deployed containers keep running)').action(cmdStop);

program.command('status').description('show the local server state and URL').action(cmdStatus);

program
  .command('logs')
  .description("print the local server's log")
  .option('--tail <lines>', 'number of trailing lines to print', '100')
  .option('-f, --follow', 'keep following the log')
  .action(cmdLogs);

program.parse(process.argv);
