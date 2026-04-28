import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import type { BootstrapEvent } from '../types';

// Thin wrapper around the host's container runtime CLI. Probes for
// `docker` first, then `podman` — both speak a compatible enough
// surface for this module's needs (pull/login/tag/push/run/stop/
// logs). Colima exposes a Docker-compatible socket so plain `docker`
// works once Colima is up.
//
// The bootstrapper assumes the runtime is already installed; checking
// the prerequisite is the wizard's job. This module fails loudly with
// a recognisable message if no runtime is on PATH so callers can
// surface a clear error.

export type RuntimeKind = 'docker' | 'podman';

let cachedRuntime: RuntimeKind | null = null;

export function detectRuntime(): RuntimeKind {
  if (cachedRuntime) return cachedRuntime;
  for (const candidate of ['docker', 'podman'] as const) {
    const r = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (r.status === 0) {
      cachedRuntime = candidate;
      return candidate;
    }
  }
  throw new Error(
    'No container runtime found on PATH. Install Docker Desktop, Colima, or Podman before running bootstrap.'
  );
}

interface RunOptions {
  /** stdin payload for commands that read from stdin (e.g. `docker login --password-stdin`). */
  input?: string;
  /** When true, capture stdout instead of inheriting. */
  captureStdout?: boolean;
}

interface RunResult {
  stdout: string;
  stderr: string;
}

function runSync(args: string[], opts: RunOptions = {}): RunResult {
  const runtime = detectRuntime();
  const r = spawnSync(runtime, args, {
    input: opts.input,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`${runtime} ${args.join(' ')} exited ${r.status}: ${(r.stderr || r.stdout || '').trim()}`);
  }
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function pullImage(image: string, emit?: (e: BootstrapEvent) => void): void {
  emit?.({ type: 'log', level: 'info', message: `pulling ${image}` });
  try {
    runSync(['pull', image]);
  } catch (err) {
    // Pull failure is fatal unless the image is already on disk
    // (typical dev workflow: a freshly-built local tag with no
    // registry to pull from). In that case we proceed with the
    // local copy and warn the operator that we couldn't refresh.
    if (imageExistsLocally(image)) {
      emit?.({
        type: 'log',
        level: 'warn',
        message: `pull failed for ${image}; using locally-cached image (${err instanceof Error ? err.message : String(err)})`,
      });
      return;
    }
    throw err;
  }
}

function imageExistsLocally(image: string): boolean {
  const runtime = detectRuntime();
  const r = spawnSync(runtime, ['image', 'inspect', image], { stdio: 'ignore' });
  return r.status === 0;
}

export function tagImage(src: string, dst: string): void {
  runSync(['tag', src, dst]);
}

export function pushImage(image: string, emit?: (e: BootstrapEvent) => void): void {
  emit?.({ type: 'log', level: 'info', message: `pushing ${image}` });
  runSync(['push', image]);
}

export function login(registryHost: string, username: string, password: string): void {
  runSync(['login', registryHost, '--username', username, '--password-stdin'], { input: password });
}

export interface RunContainerOptions {
  image: string;
  /** Bind on `127.0.0.1:<hostPort>` → `<containerPort>`. The runtime decides on hostPort if omitted. */
  port: { hostPort: number; containerPort: number };
  /** Environment variables. Undefined values are skipped. */
  env: Record<string, string | undefined>;
  /** Bind mounts (`-v <host>:<container>[:ro]`). Used by the dogfood
   *  bootstrap to expose the operator's `~/.aws` to the container so
   *  AWS_PROFILE / SSO token cache resolution works inside it. */
  volumes?: Array<{ host: string; container: string; readOnly?: boolean }>;
  /** Optional name for the container — useful for log readability. */
  name?: string;
}

export interface ContainerHandle {
  /** Container ID returned by the runtime's `run -d` command. */
  id: string;
  /** Tail logs through the supplied emit fn. Resolves once the container exits. */
  attachLogs(emit: (e: BootstrapEvent) => void): { stop: () => void };
  /** Stop and remove the container. Idempotent — safe to call after the container has exited. */
  stop(): void;
}

export function runDetached(opts: RunContainerOptions): ContainerHandle {
  const runtime = detectRuntime();

  const args = ['run', '-d', '--rm'];
  if (opts.name) args.push('--name', opts.name);
  args.push('-p', `127.0.0.1:${opts.port.hostPort}:${opts.port.containerPort}`);
  for (const [key, value] of Object.entries(opts.env)) {
    if (value === undefined) continue;
    args.push('-e', `${key}=${value}`);
  }
  for (const volume of opts.volumes ?? []) {
    args.push('-v', `${volume.host}:${volume.container}${volume.readOnly ? ':ro' : ''}`);
  }
  args.push(opts.image);

  const result = spawnSync(runtime, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${runtime} run failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  const id = result.stdout.trim();

  let logsProcess: ChildProcess | null = null;
  let stopped = false;

  const handle: ContainerHandle = {
    id,
    attachLogs(emit) {
      logsProcess = spawn(runtime, ['logs', '-f', id], { stdio: ['ignore', 'pipe', 'pipe'] });
      const onChunk = (level: 'info' | 'warn') => (chunk: Buffer) => {
        for (const line of chunk.toString('utf8').split('\n')) {
          if (line.length === 0) continue;
          emit({ type: 'log', level, message: `[api-server] ${line.trimEnd()}` });
        }
      };
      logsProcess.stdout?.on('data', onChunk('info'));
      logsProcess.stderr?.on('data', onChunk('warn'));
      return {
        stop: () => {
          if (logsProcess && !logsProcess.killed) logsProcess.kill('SIGTERM');
        },
      };
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (logsProcess && !logsProcess.killed) logsProcess.kill('SIGTERM');
      // -t 1: short grace period; with --rm the container is removed on stop.
      // Best-effort: a stuck container shouldn't block the bootstrap caller.
      const r = spawnSync(runtime, ['stop', '-t', '1', id], { stdio: 'ignore' });
      if (r.status !== 0) {
        // Try a hard kill if stop somehow failed.
        spawnSync(runtime, ['kill', id], { stdio: 'ignore' });
      }
    },
  };

  return handle;
}

/**
 * Find an available TCP port on 127.0.0.1. Asks the kernel for a
 * free port (`listen(0)`), then closes the socket. There's a race
 * between this returning and the caller binding the port — but the
 * window is small and the alternative (managing a port pool) is
 * heavier than warranted for a single-shot bootstrap subprocess.
 */
export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error('failed to allocate ephemeral port'));
      }
    });
  });
}
