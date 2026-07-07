import * as net from 'node:net';
import * as tls from 'node:tls';
import { spawnSync } from 'node:child_process';
import { helperBinDir, runInstall, runStatus } from '@appliance.sh/helper';
import type { StatusEntry } from '@appliance.sh/helper';

// Reusable preflight checks shared by `appliance doctor` and any other
// surface that needs a structured "can this machine run Appliance?"
// verdict (the desktop sidecar, CI smoke tests, …). Every check returns
// the same {status, remediation} shape so callers render a uniform
// checklist without branching on the check's identity.
//
// Docker is deliberately NOT checked: nothing in the appliance flow
// needs it anymore. The control plane runs as a guest binary inside the
// microVM and images build server-side with the in-VM BuildKit.
//
// Checks never throw: a probe that can't run (tool missing, command
// errors) resolves to a `fail` (or `warn`) with an actionable
// remediation, never a rejected promise. That keeps the orchestrator a
// flat `Promise.all` and guarantees `doctor` always prints a full
// report instead of bailing on the first surprise.

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
  /** Stable identifier, e.g. `bin:kubectl`, `port:8081`. */
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

/** bun — used to compile the CLI and the api-server guest binary from a
 *  repo checkout. A `warn` for the same reason as Rust: end users run
 *  prebuilt binaries. */
export function checkBun(): CheckResult {
  const version = probeVersion('bun', ['--version']);
  if (version) {
    return pass('bun', 'bun (build toolchain)', `v${version}`);
  }
  return warn(
    'bun',
    'bun (build toolchain)',
    'bun not found — only needed to compile the CLI / api-server guest binary from source',
    'Install bun: `curl -fsSL https://bun.sh/install | bash`. Skip if you only run published binaries.'
  );
}

// ---- helper-managed binaries -------------------------------------------

/** kubectl (and any other helper-managed tools) from the provider
 *  registry. Probed via `runStatus` so the resolution order (managed
 *  bin dir → PATH) matches exactly what the rest of the CLI uses. */
export async function checkHelperBinaries(): Promise<CheckResult[]> {
  let entries: StatusEntry[];
  try {
    entries = await runStatus();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [
      fail(
        'helper-binaries',
        'Helper binaries (kubectl)',
        `could not probe helper providers: ${message}`,
        'Install the helper-managed binaries (kubectl), then re-run `appliance doctor`.'
      ),
    ];
  }
  return entries.map((e) => {
    const { provider, check } = e;
    const label = `${provider.name} (${provider.description.replace(/\.$/, '')})`;
    if (check.installed) {
      return pass(`bin:${provider.name}`, label, check.version);
    }
    const remediation = provider.autoInstallable
      ? `Install ${provider.name} under ${helperBinDir()} or via your package manager (\`appliance doctor --fix\` installs it for you); the microVM runtime also fetches it on \`appliance vm up\` when missing.`
      : provider.manualInstall({
          binDir: helperBinDir(),
          platform: process.platform as 'darwin' | 'linux' | 'win32',
          arch: process.arch as 'x64' | 'arm64',
        }).instructions;
    const detail = check.error ?? 'not installed';
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
  const [helperBinaries, ports] = await Promise.all([checkHelperBinaries(), checkPorts()]);

  const results: CheckResult[] = [...helperBinaries, checkRust(), checkBun(), ...ports, checkMacSigning()];

  return { results, ok: results.every((r) => r.status !== 'fail') };
}

/** Auto-resolve the checks doctor can safely fix without forking system
 *  trust decisions. Returns a per-fix log line for the caller to render. */
export interface FixOutcome {
  label: string;
  status: 'fixed' | 'skipped' | 'failed';
  detail: string;
}

/**
 * Run the safe, non-trust-forking auto-fixes for a preflight report:
 * install the missing helper-managed binaries (kubectl). Port conflicts
 * and toolchain gaps stay with the operator — remediations already name
 * the fix.
 *
 * The macOS dev-binary signing step is deliberately NOT here: it forks a
 * trust/identity decision and is therefore prompted by the caller
 * (`appliance init`), never run blind.
 */
export async function runFixes(report: PreflightReport): Promise<FixOutcome[]> {
  const outcomes: FixOutcome[] = [];

  const missingBins = report.results.filter((r) => r.id.startsWith('bin:') && r.status !== 'pass');
  if (missingBins.length > 0) {
    outcomes.push(...(await installHelperBinaries(missingBins)));
  }

  return outcomes;
}

/** Drive the helper auto-installer for the missing managed binaries.
 *  The check id is `bin:<provider>`, so the provider name is the
 *  suffix. Providers that can't auto-install return guidance rather
 *  than failing — surfaced as a `skipped` so the report still carries
 *  the manual remediation. */
async function installHelperBinaries(missing: CheckResult[]): Promise<FixOutcome[]> {
  const tools = missing.map((r) => r.id.slice('bin:'.length)).filter(Boolean);
  let outcomes;
  try {
    outcomes = await runInstall({ tools });
  } catch (err) {
    return [
      { label: 'install helper binaries', status: 'failed', detail: err instanceof Error ? err.message : String(err) },
    ];
  }
  return outcomes.map((o) => ({
    label: `install ${o.provider.name}`,
    status: o.status === 'installed' || o.status === 'already' ? 'fixed' : o.status === 'failed' ? 'failed' : 'skipped',
    detail: o.message,
  }));
}
