import { runCommand, sleep } from './exec.js';
import type { ProgressEvent } from './types.js';

// Container-runtime daemon management. The docker provider proves the
// *CLI* exists; this module owns the daemon underneath it — probing
// reachability and, where appliance can do so safely, starting the
// runtime on the user's behalf.
//
// The only runtime we auto-start is colima: it's a userland CLI the
// user installed themselves, and `colima start` is an ordinary
// unprivileged, idempotent command — exactly what they'd type by
// hand. Docker Desktop (GUI app) and system dockerd (root) stay
// guidance-only; booting those would fork system trust decisions.

// A cold colima VM boot (disk allocation, base image pull, network
// setup) can take well over a minute on first start; bound it
// generously so a genuinely wedged `colima start` still can't hang
// the caller forever.
const COLIMA_START_TIMEOUT_MS = 240_000;
// The host-side docker socket can lag a beat behind colima reporting
// ready while the forward is wired up.
const SOCKET_SETTLE_TIMEOUT_MS = 20_000;

/**
 * Whether a Docker daemon is actually *reachable* — distinct from
 * "the `docker` CLI is on PATH". `docker --version` exits 0 even when
 * no daemon is running; `docker version --format {{.Server.Version}}`
 * forces a round-trip to the daemon, so a non-zero exit here means
 * "installed but not running" — the exact state a stopped colima VM
 * leaves the machine in.
 */
export async function dockerDaemonReachable(): Promise<boolean> {
  try {
    const r = await runCommand(['docker', 'version', '--format', '{{.Server.Version}}']);
    return r.ok;
  } catch {
    return false;
  }
}

async function whichSucceeds(cmd: string): Promise<boolean> {
  try {
    const r = await runCommand([cmd, '--version']);
    return r.ok;
  } catch {
    return false;
  }
}

// Docker contexts created by GUI runtimes. When any of these exist
// alongside colima, the machine has a competing runtime that may own
// the default socket — auto-starting colima could race or confuse it,
// so we stay hands-off and surface guidance instead.
const GUI_RUNTIME_CONTEXTS = ['desktop-linux', 'orbstack', 'rancher-desktop'];

async function dockerContextNames(): Promise<string[]> {
  try {
    const r = await runCommand(['docker', 'context', 'ls', '--format', '{{.Name}}']);
    if (!r.ok) return [];
    return r.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Whether the user has a colima VM instance (running or stopped). */
async function colimaInstanceExists(): Promise<boolean> {
  try {
    // One JSON object per line, one line per instance; empty when the
    // user never created a VM (`colima start` would then build a fresh
    // one — a bigger action than restarting the VM they already had,
    // so we don't auto-start in that case).
    const r = await runCommand(['colima', 'list', '-j']);
    if (!r.ok) return false;
    return r.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .some((line) => {
        try {
          const parsed = JSON.parse(line) as { name?: string };
          return typeof parsed.name === 'string' && parsed.name.length > 0;
        } catch {
          return false;
        }
      });
  } catch {
    return false;
  }
}

/**
 * True when colima is the runtime providing Docker on this machine —
 * the guard for auto-start: we only bring colima up when the user's
 * docker is actually backed by it, never when they're on Docker
 * Desktop / OrbStack with a stray colima install sitting alongside.
 *
 * Detection, in order of confidence:
 *   1. `DOCKER_HOST` points at a colima socket.
 *   2. The active docker context is `colima`.
 *   3. The active context is `default` (a clean `colima stop` resets
 *      the context, so a stopped colima looks exactly like "no
 *      runtime" here), a colima VM instance exists, and no GUI
 *      runtime context (Docker Desktop, OrbStack, Rancher Desktop)
 *      is present to claim the default socket instead.
 */
export async function colimaIsActiveRuntime(): Promise<boolean> {
  if (!(await whichSucceeds('colima'))) return false;
  if (process.env.DOCKER_HOST?.includes('.colima')) return true;
  try {
    const r = await runCommand(['docker', 'context', 'show']);
    if (!r.ok) return false;
    const current = r.stdout.trim();
    if (current === 'colima') return true;
    if (current !== 'default') return false;
    const names = await dockerContextNames();
    if (GUI_RUNTIME_CONTEXTS.some((name) => names.includes(name))) return false;
    return colimaInstanceExists();
  } catch {
    return false;
  }
}

/**
 * Platform-appropriate nudge for "Docker is installed but the daemon
 * isn't reachable" in the cases appliance can't safely auto-start.
 * colima is handled before callers ever surface this, so it isn't
 * suggested as the primary fix here.
 */
export function dockerUnreachableHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') {
    return 'Docker isn’t running. Start your container runtime — Docker Desktop, OrbStack, or `colima start` — and retry.';
  }
  if (platform === 'linux') {
    return 'Docker isn’t running. Start it with `sudo systemctl start docker` and retry.';
  }
  return 'Docker isn’t running. Start Docker Desktop and retry.';
}

/**
 * Bring the container runtime up if appliance can do so safely.
 *
 * Reachable daemon → no-op. Unreachable + colima is the active
 * runtime → `colima start` (idempotent), then poll until the host
 * socket answers. Every other "daemon down" case throws an actionable
 * message instead of letting a cryptic k3d timeout surface downstream.
 */
export async function ensureDockerRunning(opts: { onProgress?: (event: ProgressEvent) => void } = {}): Promise<void> {
  if (await dockerDaemonReachable()) return;
  if (!(await colimaIsActiveRuntime())) {
    throw new Error(dockerUnreachableHint());
  }
  opts.onProgress?.({ type: 'progress', tool: 'docker', message: 'Docker daemon not running — starting colima' });
  const start = await runCommand(['colima', 'start'], { timeoutMs: COLIMA_START_TIMEOUT_MS });
  if (!start.ok) {
    throw new Error(`Docker isn’t running and \`colima start\` failed: ${start.stderr.trim()}`);
  }
  const deadline = Date.now() + SOCKET_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await dockerDaemonReachable()) {
      opts.onProgress?.({ type: 'done', tool: 'docker', message: 'colima started; Docker daemon reachable' });
      return;
    }
    await sleep(500);
  }
  throw new Error(
    'colima started but the Docker daemon is still unreachable. Check `colima status` and `docker info`.'
  );
}

export interface RuntimeDaemonStatus {
  /** Whether a daemon answered the version round-trip. */
  running: boolean;
  /**
   * Meaningful when `running` is false: whether appliance can start
   * the runtime itself (colima is the active runtime). Drives a
   * "start it for me" affordance vs. manual-start guidance.
   */
  startable: boolean;
}

/** One-shot daemon probe used by status/doctor surfaces. */
export async function runtimeDaemonStatus(): Promise<RuntimeDaemonStatus> {
  const running = await dockerDaemonReachable();
  if (running) return { running: true, startable: false };
  return { running: false, startable: await colimaIsActiveRuntime() };
}
