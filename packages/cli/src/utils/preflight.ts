import * as net from 'node:net';
import * as tls from 'node:tls';
import { spawnSync } from 'node:child_process';
import {
  IN_CLUSTER_API_SERVER_DEFAULT_IMAGE,
  helperBinDir,
  runStatus,
  runtimeDaemonStatus,
} from '@appliance.sh/helper';
import type { StatusEntry } from '@appliance.sh/helper';

// Reusable preflight checks shared by `appliance doctor` and any other
// surface that needs a structured "can this machine run Appliance?"
// verdict (the desktop sidecar, CI smoke tests, …). Every check returns
// the same {status, remediation} shape so callers render a uniform
// checklist without branching on the check's identity.
//
// Checks never throw: a probe that can't run (tool missing, command
// errors) resolves to a `fail` (or `warn`) with an actionable
// remediation, never a rejected promise. That keeps the orchestrator a
// flat `Promise.all` and guarantees `doctor` always prints a full
// report instead of bailing on the first surprise.

/** The published api-server image the cluster pulls on first deploy.
 *  Re-exported from the helper's canonical constant so doctor's `--fix`
 *  (`docker pull`) and the bootstrap path can never drift apart. */
export const PUBLISHED_API_SERVER_IMAGE = IN_CLUSTER_API_SERVER_DEFAULT_IMAGE;

/** The microVM runtime can't emulate, so the api-server image must
 *  carry the host's architecture. Mirrors VM_HOST_ARCH in
 *  appliance-vm.ts. */
export const HOST_ARCH: 'arm64' | 'amd64' = process.arch === 'arm64' ? 'arm64' : 'amd64';

/** Ports the microVM runtime forwards on the host. A conflicting
 *  listener here is the single most common cause of a silent first-run
 *  failure (the runtime can't bind the port, and startup times out with
 *  an opaque message). */
export const REQUIRED_PORTS: PortSpec[] = [
  { port: 8081, purpose: 'ingress (HTTP) — *.appliance.localhost', probe: 'http://127.0.0.1:8081/' },
  { port: 6443, purpose: 'kubernetes API server', tlsProbe: true },
  { port: 5052, purpose: 'in-VM image registry', probe: 'http://127.0.0.1:5052/v2/' },
];

interface PortSpec {
  port: number;
  purpose: string;
  /** When set, an HTTP URL that answering on this port means *our own*
   *  runtime already holds it — so an occupied port is "runtime up",
   *  not a conflict. */
  probe?: string;
  /** When true, a port that completes a TLS handshake is recognized as
   *  our own runtime (the kube-apiserver on 6443 speaks TLS, not HTTP,
   *  so it has no plain-HTTP signature). */
  tlsProbe?: boolean;
}

export type CheckStatus = 'pass' | 'fail' | 'warn';

export interface CheckResult {
  /** Stable identifier, e.g. `docker`, `port:8081`, `api-server-image`. */
  id: string;
  /** Short human label rendered as the checklist row title. */
  label: string;
  status: CheckStatus;
  /** One-line detail (resolved version, what was found, why it failed). */
  detail?: string;
  /** Actionable fix, shown only for `fail`/`warn`. */
  remediation?: string;
}

function pass(id: string, label: string, detail?: string): CheckResult {
  return { id, label, status: 'pass', detail };
}
function fail(id: string, label: string, detail: string, remediation: string): CheckResult {
  return { id, label, status: 'fail', detail, remediation };
}
function warn(id: string, label: string, detail: string, remediation: string): CheckResult {
  return { id, label, status: 'warn', detail, remediation };
}

/** Run `<tool> <args>` and return its trimmed first stdout line, or
 *  null when the tool isn't on PATH / exits non-zero. Never throws. */
function probeVersion(tool: string, args: string[]): string | null {
  try {
    const r = spawnSync(tool, args, { encoding: 'utf8' });
    if (r.status !== 0 || r.error) return null;
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) return trimmed;
    }
    return '';
  } catch {
    return null;
  }
}

// ---- container runtime --------------------------------------------------

/** Docker CLI present *and* a daemon reachable. "installed but not
 *  running" is the canonical stopped-colima state, surfaced distinctly
 *  so the remediation can offer the auto-start path. */
export async function checkDockerRuntime(): Promise<CheckResult> {
  const version = probeVersion('docker', ['--version']);
  if (version === null) {
    return fail(
      'docker',
      'Container runtime (Docker)',
      'docker CLI not found on PATH',
      'Install a container runtime — Docker Desktop, OrbStack, or Colima (`brew install colima docker`).'
    );
  }
  const daemon = await runtimeDaemonStatus();
  if (daemon.running) {
    return pass('docker', 'Container runtime (Docker)', version);
  }
  return fail(
    'docker',
    'Container runtime (Docker)',
    `${version} — installed, but the daemon is not reachable`,
    daemon.startable
      ? 'Docker is installed but its colima VM is stopped. Run `colima start`.'
      : 'Start your container runtime (Docker Desktop / OrbStack, or `colima start`), then re-run `appliance doctor`.'
  );
}

// ---- toolchain ----------------------------------------------------------

/** Rust toolchain (rustc + cargo). Only needed to build the
 *  `appliance-vm` binary from a repo checkout, so this is a `warn`, not
 *  a hard fail — published binaries ship without it. */
export function checkRust(): CheckResult {
  const rustc = probeVersion('rustc', ['--version']);
  const cargo = probeVersion('cargo', ['--version']);
  if (rustc && cargo) {
    return pass('rust', 'Rust toolchain (rustc, cargo)', rustc);
  }
  const missing = [!rustc && 'rustc', !cargo && 'cargo'].filter(Boolean).join(', ');
  return warn(
    'rust',
    'Rust toolchain (rustc, cargo)',
    `${missing} not found — only needed to build appliance-vm from source`,
    'Install Rust via rustup: `curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh`. Skip if you use the published microVM binary.'
  );
}

/** bun — used to compile the single-binary CLI distribution. A `warn`
 *  for the same reason as Rust: end users run a prebuilt binary. */
export function checkBun(): CheckResult {
  const version = probeVersion('bun', ['--version']);
  if (version) {
    return pass('bun', 'bun (CLI build toolchain)', `v${version}`);
  }
  return warn(
    'bun',
    'bun (CLI build toolchain)',
    'bun not found — only needed to compile the CLI from source',
    'Install bun: `curl -fsSL https://bun.sh/install | bash`. Skip if you only run the published `appliance` binary.'
  );
}

// ---- helper-managed binaries -------------------------------------------

/** crane / kubectl from the helper provider registry. Probed via
 *  `runStatus` so the resolution order (managed bin dir → PATH) matches
 *  exactly what the rest of the CLI uses. `crane` is optional (microVM
 *  only) → `warn`; the required tools → `fail`. */
export async function checkHelperBinaries(): Promise<CheckResult[]> {
  let entries: StatusEntry[];
  try {
    entries = await runStatus();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [
      fail(
        'helper-binaries',
        'Helper binaries (crane, kubectl)',
        `could not probe helper providers: ${message}`,
        'Install the helper-managed binaries (kubectl, crane), then re-run `appliance doctor`.'
      ),
    ];
  }
  // The docker provider is covered by checkDockerRuntime; skip it here
  // so the report doesn't list docker twice.
  return entries
    .filter((e) => e.provider.name !== 'docker')
    .map((e) => {
      const { provider, check } = e;
      const label = `${provider.name} (${provider.description.replace(/\.$/, '')})`;
      if (check.installed) {
        return pass(`bin:${provider.name}`, label, check.version);
      }
      const remediation = provider.autoInstallable
        ? `Install ${provider.name} under ${helperBinDir()} or via your package manager; the microVM runtime fetches it automatically on \`appliance vm up\` when missing.`
        : provider.manualInstall({ binDir: helperBinDir(), platform: 'darwin', arch: 'arm64' }).instructions;
      const detail = check.error ?? 'not installed';
      // crane is microVM-only and not "required" — a missing crane only
      // blocks the VM engine, so warn rather than fail the whole machine.
      return provider.required
        ? fail(`bin:${provider.name}`, label, detail, remediation)
        : warn(`bin:${provider.name}`, label, detail, remediation);
    });
}

// ---- ports --------------------------------------------------------------

/** Whether a TCP port is free to bind on 127.0.0.1. Resolves true when
 *  the bind succeeds (port free), false on EADDRINUSE (occupied). */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

/** Whether an HTTP probe answers (any status) within a short timeout —
 *  i.e. *something* is serving HTTP there, used to recognize our own
 *  runtime holding a port rather than a foreign conflict. */
async function httpResponds(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

/** Whether a TLS handshake completes on 127.0.0.1:port — used to
 *  recognize the kube-apiserver (TLS, self-signed) holding 6443. We
 *  don't validate the cert; reaching `secureConnect` is enough signal
 *  that *a* TLS server (not a foreign plain-TCP listener) is there. */
function tlsResponds(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, timeout: 2_000 }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export async function checkPorts(): Promise<CheckResult[]> {
  return Promise.all(
    REQUIRED_PORTS.map(async ({ port, purpose, probe, tlsProbe }) => {
      const id = `port:${port}`;
      const label = `Port ${port} free`;
      if (await portFree(port)) {
        return pass(id, label, purpose);
      }
      // Occupied. If it answers our runtime's own signature (HTTP for
      // ingress/registry, TLS for the kube-apiserver), the runtime is
      // simply already up — not a first-run conflict.
      const ours = (probe && (await httpResponds(probe))) || (tlsProbe && (await tlsResponds(port)));
      if (ours) {
        return pass(id, label, `held by a running Appliance runtime (${purpose})`);
      }
      return fail(
        id,
        label,
        `something is already listening on ${port} (${purpose})`,
        `Free port ${port} (find the listener with \`lsof -i :${port}\`) or stop a previously-started runtime before starting a new one.`
      );
    })
  );
}

// ---- api-server image ---------------------------------------------------

/** Host-resolved architecture of a local image, or null when it isn't
 *  in the docker daemon. Mirrors inspectArch in appliance-vm.ts. */
function inspectArch(ref: string): string | null {
  const r = spawnSync('docker', ['image', 'inspect', '--format', '{{.Architecture}}', ref], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

/**
 * Is the api-server image resolvable for this host's architecture? The
 * runtimes can't emulate, so an image without a matching `linux/<arch>`
 * variant crashloops with `exec format error`. We treat "present
 * locally with the host arch" as a pass; "present but wrong arch" as a
 * fail; "absent" as a warn (the cluster pulls it from ghcr on first
 * deploy — `--fix` pre-pulls it so first-run is offline-safe and fast).
 *
 * Skipped entirely when docker is unreachable (the docker check already
 * failed and re-reporting the same daemon error here is noise).
 */
export function checkApiServerImage(dockerReachable: boolean): CheckResult {
  const id = 'api-server-image';
  const label = 'api-server image resolvable';
  if (!dockerReachable) {
    return warn(
      id,
      label,
      'skipped — Docker daemon is not reachable',
      'Fix the container runtime above, then re-run `appliance doctor`.'
    );
  }
  const arch = inspectArch(PUBLISHED_API_SERVER_IMAGE);
  if (arch === null) {
    return warn(
      id,
      label,
      `${PUBLISHED_API_SERVER_IMAGE} not pulled locally`,
      `The cluster pulls it on first deploy. To pre-pull (faster, offline-safe first run): \`docker pull ${PUBLISHED_API_SERVER_IMAGE}\` — or run \`appliance doctor --fix\`.`
    );
  }
  if (arch !== HOST_ARCH) {
    return fail(
      id,
      label,
      `${PUBLISHED_API_SERVER_IMAGE} resolves to linux/${arch}, but this host needs linux/${HOST_ARCH}`,
      `Re-pull for the host architecture: \`docker pull --platform linux/${HOST_ARCH} ${PUBLISHED_API_SERVER_IMAGE}\`. The runtime can't emulate, so a cross-arch image crashloops with "exec format error".`
    );
  }
  return pass(id, label, `${PUBLISHED_API_SERVER_IMAGE} (linux/${arch})`);
}

// ---- macOS signing / keychain ------------------------------------------

/**
 * On macOS, Virtualization.framework gates VM creation behind the
 * `com.apple.security.virtualization` entitlement, which requires a
 * code signature. A repo-built `appliance-vm` is unsigned until
 * `packages/vm/scripts/sign-dev.sh` runs. We can't know the user's
 * binary path generically, so this is an informational `warn` that
 * points at the signing step. No-op (pass) off macOS.
 */
export function checkMacSigning(): CheckResult {
  const id = 'mac-signing';
  const label = 'macOS code-signing (microVM entitlement)';
  if (process.platform !== 'darwin') {
    return pass(id, label, 'not applicable on this platform');
  }
  const codesign = probeVersion('codesign', ['--version']) !== null || spawnSync('codesign', []).error === undefined;
  if (!codesign) {
    return warn(
      id,
      label,
      'codesign not found — Xcode command line tools may be missing',
      'Install the Xcode command line tools: `xcode-select --install`.'
    );
  }
  return warn(
    id,
    label,
    'a repo-built appliance-vm must be signed to boot a microVM',
    'Booting microVMs needs the com.apple.security.virtualization entitlement. After building, run `packages/vm/scripts/sign-dev.sh` (the published binary is already signed).'
  );
}

// ---- orchestrator -------------------------------------------------------

export interface PreflightReport {
  results: CheckResult[];
  /** True when every check is `pass` or `warn` — no hard failures. */
  ok: boolean;
}

/** Run the full preflight suite and return a structured report. The
 *  caller decides how to render (checklist, JSON) and how to exit. */
export async function runPreflight(): Promise<PreflightReport> {
  const docker = await checkDockerRuntime();
  const dockerReachable = docker.status === 'pass';

  const [helperBinaries, ports] = await Promise.all([checkHelperBinaries(), checkPorts()]);

  const results: CheckResult[] = [
    docker,
    ...helperBinaries,
    checkRust(),
    checkBun(),
    ...ports,
    checkApiServerImage(dockerReachable),
    checkMacSigning(),
  ];

  return { results, ok: results.every((r) => r.status !== 'fail') };
}

/** Auto-resolve the checks doctor can safely fix without forking system
 *  trust decisions. Currently: pre-pull the published api-server image
 *  for the host arch (the same image/pull pattern the bootstrap uses).
 *  Returns a per-fix log line for the caller to render. */
export interface FixOutcome {
  label: string;
  status: 'fixed' | 'skipped' | 'failed';
  detail: string;
}

export function runFixes(report: PreflightReport): FixOutcome[] {
  const outcomes: FixOutcome[] = [];

  const imageCheck = report.results.find((r) => r.id === 'api-server-image');
  if (imageCheck && imageCheck.status !== 'pass') {
    if (imageCheck.detail?.includes('Docker daemon is not reachable')) {
      outcomes.push({
        label: 'pull api-server image',
        status: 'skipped',
        detail: 'Docker daemon is not reachable — start it first.',
      });
    } else {
      outcomes.push(pullApiServerImage());
    }
  }

  return outcomes;
}

/** `docker pull --platform linux/<arch>` the published image — the
 *  identical pull pattern bootstrap relies on, pinned to the host arch
 *  so the runtime gets a runnable variant. */
function pullApiServerImage(): FixOutcome {
  const label = 'pull api-server image';
  const args = ['pull', '--platform', `linux/${HOST_ARCH}`, PUBLISHED_API_SERVER_IMAGE];
  const r = spawnSync('docker', args, { stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8' });
  if (r.status === 0) {
    return { label, status: 'fixed', detail: `pulled ${PUBLISHED_API_SERVER_IMAGE} (linux/${HOST_ARCH})` };
  }
  return {
    label,
    status: 'failed',
    detail: `\`docker ${args.join(' ')}\` failed: ${(r.stderr ?? '').trim() || 'unknown error'}`,
  };
}
