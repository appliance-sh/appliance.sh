import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import chalk from 'chalk';
import { DEFAULT_VM_NAME, readVmPorts, runVm } from './utils/microvm-up.js';
import {
  DEFAULT_RUNTIME,
  DEFAULT_SERVER_PORT,
  SERVER_PROFILE,
  apiUrlFor,
  defaultDataDir,
  ensureCredentials,
  ensureServerRunning,
  isProcessAlive,
  isReachable,
  logPath,
  prepareRuntime,
  printBanner,
  readState,
  runInProcess,
  runtimeLabel,
  writeState,
  type ServerRuntime,
} from './utils/local-server.js';

// `appliance server` — command layer over utils/local-server.ts (the
// core lives there so `appliance dev` can reuse it without triggering
// this module's self-executing program.parse). See that file for the
// runtime model: `vm` (microVM k3s + in-guest BuildKit, no Docker
// needed — the default) vs `docker` (containers on the local daemon).

function parseRuntime(value: string): ServerRuntime {
  if (value !== 'vm' && value !== 'docker') {
    console.error(chalk.red(`Invalid --runtime: ${value} (expected 'vm' or 'docker')`));
    process.exit(1);
  }
  return value;
}

async function cmdStart(opts: {
  port: string;
  dataDir?: string;
  foreground?: boolean;
  runtime: string;
}): Promise<void> {
  const port = Number.parseInt(opts.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(chalk.red(`Invalid --port: ${opts.port}`));
    process.exit(1);
  }
  const runtime = parseRuntime(opts.runtime);

  if (opts.foreground) {
    const prior = readState();
    const dataDir = path.resolve(opts.dataDir ?? prior?.dataDir ?? defaultDataDir());
    const token = prior?.token ?? randomBytes(24).toString('hex');
    const prep = await prepareRuntime(runtime, dataDir);
    writeState({
      port,
      dataDir,
      pid: process.pid,
      token,
      startedAt: new Date().toISOString(),
      runtime,
      vmName: prep.vmName,
      kubeconfigSha: prep.kubeconfigSha,
    });
    await runInProcess(port, dataDir, token, prep.baseConfig);
    await ensureCredentials(port, token);
    printBanner(port, dataDir, { runtime, vmName: prep.vmName, ingressPort: prep.ingressPort });
    console.log(chalk.dim('  (foreground mode — Ctrl-C stops the server)'));
    return; // keep running; the listener holds the event loop open
  }

  await ensureServerRunning({ runtime, port, dataDir: opts.dataDir });
}

async function cmdStop(opts: { vm?: boolean } = {}): Promise<void> {
  const state = readState();
  if (!state) {
    console.log('No local server state found — nothing to stop.');
    return;
  }
  const reachable = await isReachable(state.port);
  if (!isProcessAlive(state.pid) && !reachable) {
    console.log('Local server is not running.');
    writeState({ ...state, pid: undefined });
  } else if (state.pid && isProcessAlive(state.pid)) {
    process.kill(state.pid);
    console.log(`${chalk.green('✓')} server stopped (pid ${state.pid})`);
    writeState({ ...state, pid: undefined });
    if (state.runtime === 'vm') {
      console.log(
        chalk.dim(
          'Deployed apps keep running in the microVM — `appliance destroy` removes them; `appliance vm stop` parks the VM.'
        )
      );
    } else {
      console.log(chalk.dim('Deployed containers keep running — `appliance destroy` removes them per environment.'));
    }
  } else {
    console.error(
      chalk.yellow(
        `A server answers on port ${state.port} but its recorded pid is gone — it was started by another process. Stop it there.`
      )
    );
    process.exit(1);
  }
  if (opts.vm && state.runtime === 'vm') {
    runVm(['stop', state.vmName ?? DEFAULT_VM_NAME]);
  }
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
  const runtime = state.runtime ?? 'docker';
  console.log(`Local server: ${status}`);
  console.log(`  API server:  ${apiUrlFor(state.port)}`);
  console.log(`  Runtime:     ${runtimeLabel(runtime, state.vmName)}`);
  if (runtime === 'vm') {
    // Probe the VM through its forwarded registry — cheap, and it's
    // the forward deploys actually depend on.
    const ports = readVmPorts(state.vmName ?? DEFAULT_VM_NAME);
    let vmUp = false;
    try {
      const res = await fetch(`http://127.0.0.1:${ports.registryPort}/v2/`, { signal: AbortSignal.timeout(2_000) });
      vmUp = res.ok;
    } catch {
      vmUp = false;
    }
    console.log(`  VM:          ${vmUp ? chalk.green('running') : chalk.red('not running')} (appliance vm status)`);
  }
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

program.name('appliance server').description('run the Appliance control plane as a lightweight local daemon');

program
  .command('start')
  .description('start the local server (detached) and save the `local` credential profile')
  .option('--port <port>', 'port to listen on', String(DEFAULT_SERVER_PORT))
  .option('--data-dir <path>', 'state directory (default: ~/.appliance/server/data)')
  .option('--foreground', 'run in the foreground instead of detaching')
  .option(
    '--runtime <runtime>',
    "workload runtime: 'vm' (microVM k3s + BuildKit, no Docker needed) or 'docker' (local Docker daemon)",
    DEFAULT_RUNTIME
  )
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

program
  .command('stop')
  .description('stop the local server (deployed apps keep running)')
  .option('--vm', 'also stop the microVM backing the vm runtime')
  .action(cmdStop);

program.command('status').description('show the local server state and URL').action(cmdStatus);

program
  .command('logs')
  .description("print the local server's log")
  .option('--tail <lines>', 'number of trailing lines to print', '100')
  .option('-f, --follow', 'keep following the log')
  .action(cmdLogs);

program.parse(process.argv);
