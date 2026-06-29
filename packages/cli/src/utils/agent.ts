import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

import {
  DEFAULT_SANDBOX_VM,
  GUEST_WORKSPACE,
  ensureSandboxVm,
  runVm,
  runVmCapture,
  vmBinary,
  vmRunScript,
} from './sandbox.js';
import { readSandboxVm } from './link.js';

// Agent runner + the pluggable agent-type adapter seam (Phase 5, A1).
//
// An agent is NOT a new transport — it's the Phase-4 reattachable tmux
// shell (`appliance-vm shell <vm> --session agent-<id>`) launched as the
// non-root `appliance` user in /persist/workspace, with three things in
// front of the launch command:
//   (a) the host egress proxy wired into HTTP(S)_PROXY (so the agent's
//       outbound TLS flows through the broker),
//   (b) the agent CLI's CA / cert-store env (the egress CA is already
//       trusted guest-wide — guest.rs update-ca-certificates), and
//   (c) an INERT placeholder credential so the CLI starts and emits its
//       auth header, which the proxy then overwrites host-side with the
//       real key (see docs/agent-sandbox.md §3; the key never enters the
//       VM).
//
// The credential broker itself (key store, fail-closed injection, MITM
// scoping, peer-gate) is A2 — the host key store / `print-key` helper
// lives in this file; the proxy-side enforcement is in packages/vm
// (egress.rs / creds.rs / mitm.rs).

// ---- adapter seam (docs/agent-sandbox.md §8b) --------------------------

export interface AgentLaunchOpts {
  /** Interactive TTY (`claude`) or one-shot autonomous (`claude -p …`). */
  mode: 'interactive' | 'autonomous';
  /** Autonomous: the prompt. Interactive: an optional label (unused in argv). */
  task?: string;
}

/** A per-host credential rule the broker applies (mirrors creds.rs
 *  CredentialRule). `helper` is resolved to an ABSOLUTE host command by
 *  the runner before it's written, so the proxy never relies on PATH. */
export interface AgentCredentialRule {
  host: string;
  inject: boolean;
  capture: boolean;
  header: string;
  /** Set by the runner (absolute `appliance agent print-key`). */
  helper?: string;
}

/** An agent-type adapter. Claude Code first; codex/aider/etc. are later
 *  adapter objects — no transport or broker change (docs §8b). */
export interface AgentAdapter {
  type: string;
  /** Install-on-first-use, run in-guest before launch (docs §5). */
  installCmd: string;
  /** The launch argv inside the session (docs §6). */
  launchArgv(opts: AgentLaunchOpts): string[];
  /** Hosts whose auth header the broker injects host-side (docs §3). */
  credHosts: AgentCredentialRule[];
  /** Inert placeholder env so the CLI starts + emits its auth header. */
  placeholderEnv?: Record<string, string>;
  /** Agent-specific runtime env (e.g. CLAUDE_CODE_CERT_STORE). */
  runtimeEnv?: Record<string, string>;
  /** Extract a result from autonomous stdout (A6). */
  parseResult?(stdout: string): { ok: boolean; summary?: string };
}

/** The Anthropic host the broker injects the key on. */
export const ANTHROPIC_HOST = 'api.anthropic.com';

/** The INERT placeholder put in the guest's `ANTHROPIC_API_KEY`. Claude
 *  Code won't start without auth in its precedence chain, so a credential
 *  MUST be present for the CLI to run + emit `x-api-key`; the proxy
 *  overwrites this value host-side before it leaves (docs §3 step 4).
 *  Verified (A0 STEP 0): `claude` accepts this shape without local
 *  pre-validation and emits the request — a 401 comes from upstream, not
 *  a local check. Capturing it buys an attacker nothing. */
export const ANTHROPIC_PLACEHOLDER_KEY = 'sk-ant-appliance-proxy';

/** The guest path the egress CA is trusted at (guest.rs:105). Used only
 *  as a NODE_EXTRA_CA_CERTS belt-and-suspenders; CLAUDE_CODE_CERT_STORE's
 *  default `system` source already covers it (docs §4b). */
const GUEST_EGRESS_CA = '/usr/local/share/ca-certificates/appliance-egress.crt';

/** NO_PROXY for the agent: bypass the proxy for loopback + cluster-
 *  internal destinations only (mirrors egress.rs default_no_proxy). */
const AGENT_NO_PROXY =
  'localhost,127.0.0.1,::1,.svc,.svc.cluster.local,.cluster.local,10.42.0.0/16,10.43.0.0/16,kubernetes.default';

export const claudeCodeAdapter: AgentAdapter = {
  type: 'claude-code',
  // Surface install stderr (only stdout is suppressed) so a failed
  // `npm install` is visible rather than silently producing a dead
  // session — runAgent also joins this with `&&` so a failure aborts
  // before the tmux session is created.
  installCmd: 'command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code >/dev/null',
  launchArgv(opts: AgentLaunchOpts): string[] {
    if (opts.mode === 'autonomous') {
      // --dangerously-skip-permissions is why the non-root user exists
      // (agents refuse it as root, docs/rootless-guest.md §0).
      return ['claude', '-p', opts.task ?? '', '--output-format', 'json', '--dangerously-skip-permissions'];
    }
    return ['claude'];
  },
  credHosts: [{ host: ANTHROPIC_HOST, inject: true, capture: false, header: 'x-api-key' }],
  placeholderEnv: { ANTHROPIC_API_KEY: ANTHROPIC_PLACEHOLDER_KEY },
  runtimeEnv: { CLAUDE_CODE_CERT_STORE: 'bundled,system' },
  parseResult(stdout: string): { ok: boolean; summary?: string } {
    // Claude Code's --output-format json prints one result object.
    for (const raw of stdout.split('\n')) {
      const line = raw.trim();
      if (!line.startsWith('{')) continue;
      try {
        const obj = JSON.parse(line) as { is_error?: boolean; result?: unknown };
        if ('result' in obj || 'is_error' in obj) {
          return { ok: obj.is_error !== true, summary: typeof obj.result === 'string' ? obj.result : undefined };
        }
      } catch {
        // not the result line
      }
    }
    return { ok: false };
  },
};

/** Map an agent-type to its adapter. Claude Code is the only one today;
 *  codex/aider/etc. are future adapter objects (docs §8b). Shared by the
 *  CLI command group and the registry's autonomous-result finalizer. */
export function adapterForType(type: string): AgentAdapter | null {
  return type === claudeCodeAdapter.type ? claudeCodeAdapter : null;
}

// ---- host key store (A2 — the broker's host side) ----------------------
//
// The Anthropic key lives host-side ONLY: macOS Keychain
// (`sh.appliance.agent` / `anthropic`), or a 0600 file off-macOS. It is
// never written into any per-VM file and never into the VM. The proxy
// fetches it via the `print-key` helper (a HOST process) at inject time.

const AGENT_KEYCHAIN_SERVICE = 'sh.appliance.agent';
const AGENT_KEYCHAIN_ACCOUNT = 'anthropic';
const SECURITY_BIN = '/usr/bin/security';

function isMacOS(): boolean {
  return process.platform === 'darwin';
}

function agentKeyFile(): string {
  return path.join(os.homedir(), '.appliance', 'agent', 'anthropic-key');
}

/**
 * Read the host Anthropic key, Keychain-first on macOS, 0600-file
 * elsewhere. Returns null when unset/locked/denied. NEVER logs the key.
 * This is the resolution the `print-key` helper outputs to the proxy.
 */
export function readAgentKey(): string | null {
  if (isMacOS()) {
    try {
      const out = execFileSync(
        SECURITY_BIN,
        ['find-generic-password', '-s', AGENT_KEYCHAIN_SERVICE, '-a', AGENT_KEYCHAIN_ACCOUNT, '-w'],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const v = out.trim();
      return v.length > 0 ? v : null;
    } catch {
      return null;
    }
  }
  try {
    const v = fs.readFileSync(agentKeyFile(), 'utf-8').trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * Store the host Anthropic key. macOS Keychain `-U` upsert; 0600 file
 * elsewhere. On macOS the secret is briefly on argv to `security`
 * (no stdin option for add-generic-password) — the documented, accepted
 * tradeoff (same as utils/keychain.ts writeKeychainApiKey), gated to this
 * rare login path. NEVER logs the key.
 */
export function writeAgentKey(key: string): void {
  const value = key.trim();
  if (!value) throw new Error('refusing to store an empty Anthropic key');
  if (isMacOS()) {
    execFileSync(
      SECURITY_BIN,
      ['add-generic-password', '-U', '-s', AGENT_KEYCHAIN_SERVICE, '-a', AGENT_KEYCHAIN_ACCOUNT, '-w', value],
      { stdio: ['ignore', 'ignore', 'ignore'] }
    );
    return;
  }
  const file = agentKeyFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** Forget the stored host key (`appliance agent logout`). */
export function forgetAgentKey(): void {
  if (isMacOS()) {
    try {
      execFileSync(
        SECURITY_BIN,
        ['delete-generic-password', '-s', AGENT_KEYCHAIN_SERVICE, '-a', AGENT_KEYCHAIN_ACCOUNT],
        { stdio: ['ignore', 'ignore', 'ignore'] }
      );
    } catch {
      // not present — nothing to forget
    }
    return;
  }
  try {
    fs.rmSync(agentKeyFile(), { force: true });
  } catch {
    // ignore
  }
}

// ---- runner ------------------------------------------------------------

/** Mint an `agent-<uuid>` session id (mirrors the desktop `${mode}-${uuid}`
 *  convention; satisfies validate_session_id in shell.rs). */
export function mintAgentSessionId(): string {
  return `agent-${globalThis.crypto.randomUUID()}`;
}

/** Normalize a caller-supplied session id to the `agent-<…>` convention
 *  the rehydrate path + registry key off (so `--session <id>` accepts the
 *  bare or prefixed form). Mints nothing — just ensures the prefix. */
export function ensureAgentSessionId(id: string): string {
  const trimmed = id.trim();
  return trimmed.startsWith('agent-') ? trimmed : `agent-${trimmed}`;
}

/** The sandbox VM the cwd project targets: the linked VM, else the shared
 *  default sandbox VM. */
export function targetVm(): string {
  return readSandboxVm() ?? DEFAULT_SANDBOX_VM;
}

/** POSIX-single-quote a token for safe embedding in an `sh -c` command.
 *  Wraps in single quotes and rewrites any embedded single quote as the
 *  classic `'\''` sequence (close-quote, escaped quote, reopen) so the
 *  token can neither be split on whitespace nor break out of the quoting
 *  — and so a wrapper that itself single-quotes the whole line (runAgent →
 *  `tmux new-session`) nests correctly. */
function shQuote(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/** The runnable agent subcommand entry (`appliance-agent.js`), resolved
 *  relative to THIS module so it's stable no matter how the process was
 *  launched. The umbrella dispatcher (appliance.ts) rewrites
 *  `process.argv[1]` to the literal `appliance-agent` before importing
 *  this module, so the helper path must NOT be derived from argv[1] (that
 *  yields a bogus cwd-relative path → `print-key` exits non-zero → every
 *  brokered request fail-closes to 502 under a node invocation). */
function nodeAgentEntry(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'appliance-agent.js');
}

/** Resolve the ABSOLUTE host command the proxy runs (via `sh -c`) to
 *  fetch the key, pinning the entry path (never PATH-relative).
 *
 *  Shipping path: the CLI runs as the Bun-compiled single binary
 *  (`bin/appliance.js` exec's `appliance-bin` / `dist/appliance`), so
 *  `execPath` IS the umbrella binary and `<exe> agent print-key` works.
 *
 *  Dev/test (node or bun-as-interpreter): `execPath` is the interpreter,
 *  so we run the agent subcommand entry DIRECTLY from a module-relative
 *  path — independent of the dispatcher-clobbered `process.argv[1]`. */
export function printKeyHelperCommand(): string {
  const exe = process.execPath;
  const base = path.basename(exe).toLowerCase();
  if (base.startsWith('appliance')) {
    return `${shQuote(exe)} agent print-key`;
  }
  // `<interpreter> <appliance-agent.js> print-key` — the entry's own
  // program (`appliance agent`) dispatches `print-key`.
  return `${shQuote(exe)} ${shQuote(nodeAgentEntry())} print-key`;
}

/** The proxy/CA/placeholder env, rendered as `K=V` assignments for an
 *  `env …` prefix. Values are fixed/metachar-free (URLs, constant paths),
 *  so they're left unquoted. */
function launchEnvAssigns(adapter: AgentAdapter, proxyUrl: string): string {
  const env: Record<string, string> = {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    NO_PROXY: AGENT_NO_PROXY,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    no_proxy: AGENT_NO_PROXY,
    NODE_EXTRA_CA_CERTS: GUEST_EGRESS_CA,
    ...(adapter.runtimeEnv ?? {}),
    ...(adapter.placeholderEnv ?? {}),
  };
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
}

/** Compose the in-session launch line: cd to the workspace then run the
 *  agent under the proxy/CA/placeholder env.
 *
 *  The agent argv — including the user-controlled autonomous `--task`
 *  prompt — is shell-quoted PER TOKEN, and `runAgent` then wraps the whole
 *  line with the POSIX `'\''` trick before handing it to
 *  `tmux new-session`. So a multi-word task no longer mis-parses
 *  (`claude -p fix the test` would otherwise take only `fix`) and a single
 *  quote in the task can't break out of the wrapper into arbitrary
 *  in-guest exec.
 *
 *  `exec` (default) hands the session straight to the agent — right for the
 *  detached tmux launch (interactive TTY). The one-shot capture path
 *  (`--wait`, §6) passes `exec=false` so the login shell OUTLIVES the agent
 *  and the trailing exit-code sentinel (shell.rs) can still fire to carry
 *  the agent's real exit code back over the status-less byte pipe. */
export function composeLaunchLine(adapter: AgentAdapter, proxyUrl: string, opts: AgentLaunchOpts, exec = true): string {
  const argv = adapter.launchArgv(opts).map(shQuote).join(' ');
  return `cd ${GUEST_WORKSPACE}; ${exec ? 'exec ' : ''}env ${launchEnvAssigns(adapter, proxyUrl)} ${argv}`;
}

// ---- autonomous result capture (A6) ------------------------------------
//
// The autonomous run (`claude -p … --output-format json`) is captured one
// of two ways, both feeding `classifyAutonomousResult`:
//   • `--wait` (blocking): runs the headless argv as a captured one-shot
//     over the vsock sentinel path (shell.rs) — stdout + the real exit code
//     come back in-band; no result file is needed.
//   • detached (default): the launch line redirects the JSON result to a
//     file on the VirtioFS-shared workspace and records the exit code, so
//     the host can collect the outcome AFTER the tmux session ends —
//     `reconcileRegistry` reads it to flip the status to done/error.

/** The host + guest paths an autonomous run's result/exit-code are
 *  captured to. The workspace is VirtioFS-shared, so the guest writes under
 *  `/persist/workspace/.appliance/agent-results` and the host reads the
 *  SAME tree at `<projectDir>/.appliance/agent-results` — no VM round-trip
 *  to collect a detached run's result (docs/agent-sandbox.md §6). */
export interface AgentResultPaths {
  hostJson: string;
  hostRc: string;
  guestJson: string;
  guestRc: string;
  guestDir: string;
}

const AGENT_RESULTS_REL = '.appliance/agent-results';

export function agentResultPaths(projectDir: string, sessionId: string): AgentResultPaths {
  const root = path.resolve(projectDir);
  return {
    hostJson: path.join(root, '.appliance', 'agent-results', `${sessionId}.json`),
    hostRc: path.join(root, '.appliance', 'agent-results', `${sessionId}.rc`),
    guestJson: `${GUEST_WORKSPACE}/${AGENT_RESULTS_REL}/${sessionId}.json`,
    guestRc: `${GUEST_WORKSPACE}/${AGENT_RESULTS_REL}/${sessionId}.rc`,
    guestDir: `${GUEST_WORKSPACE}/${AGENT_RESULTS_REL}`,
  };
}

/** The detached-autonomous launch line: like `composeLaunchLine` but it
 *  runs the headless argv NON-exec'd, redirecting the `--output-format
 *  json` result (stdout) to the shared-workspace result file and recording
 *  the exit code in a sibling `.rc` file — so a detached run's outcome is
 *  collectable host-side once its tmux session ends. stderr (Claude's
 *  progress) stays on the pane so an attached tab can watch the run live. */
export function composeAutonomousCaptureLine(
  adapter: AgentAdapter,
  proxyUrl: string,
  opts: AgentLaunchOpts,
  paths: Pick<AgentResultPaths, 'guestJson' | 'guestRc' | 'guestDir'>
): string {
  const assigns = launchEnvAssigns(adapter, proxyUrl);
  const argv = adapter
    .launchArgv({ ...opts, mode: 'autonomous' })
    .map(shQuote)
    .join(' ');
  return (
    `cd ${GUEST_WORKSPACE}; mkdir -p ${shQuote(paths.guestDir)}; ` +
    `env ${assigns} ${argv} > ${shQuote(paths.guestJson)}; ` +
    `echo $? > ${shQuote(paths.guestRc)}`
  );
}

/** The classified outcome of an autonomous run. `done` only when the agent
 *  exited 0 AND the adapter parsed a non-error result; a non-zero exit, an
 *  unparseable stream, or an `is_error` result is `error` (docs §6). */
export interface AutonomousResult {
  status: 'done' | 'error';
  exitCode: number | null;
  summary?: string;
}

/** Classify an autonomous run from its exit code + captured stdout. Pure
 *  (unit-tested): the single source of truth both the `--wait` path and the
 *  detached reconcile finalizer run through. */
export function classifyAutonomousResult(
  exitCode: number | null,
  stdout: string,
  adapter: AgentAdapter
): AutonomousResult {
  const parsed = adapter.parseResult?.(stdout);
  const ok = exitCode === 0 && parsed?.ok === true;
  const summary = parsed?.summary ?? (ok ? 'completed' : `no result captured (exit ${exitCode ?? 'unknown'})`);
  return { status: ok ? 'done' : 'error', exitCode, summary };
}

/** Read + classify a detached autonomous run's captured result from the
 *  shared workspace. Returns null when the JSON result file isn't present
 *  yet (the run produced nothing) so the caller can fall back to `exited`
 *  rather than inventing an outcome. NEVER throws on a missing/corrupt
 *  file. */
export function readAutonomousResultFromFiles(
  hostJson: string,
  hostRc: string,
  adapter: AgentAdapter
): AutonomousResult | null {
  let stdout: string;
  try {
    stdout = fs.readFileSync(hostJson, 'utf-8');
  } catch {
    return null; // no result file → not finalized; caller treats as exited
  }
  let exitCode: number | null = null;
  try {
    const n = Number.parseInt(fs.readFileSync(hostRc, 'utf-8').trim(), 10);
    if (Number.isInteger(n)) exitCode = n;
  } catch {
    // rc missing — leave null; classify maps a missing code to `error`
  }
  return classifyAutonomousResult(exitCode, stdout, adapter);
}

/** Read the proxy URL the guest should use from `appliance-vm egress
 *  gateway` (which prints `HTTPS_PROXY=<url>`), derived from the VM's
 *  subnet gateway + egress port (egress.rs guest_proxy_url). */
function resolveProxyUrl(vm: string): string {
  const r = runVmCapture(['egress', 'gateway', vm]);
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^HTTPS_PROXY=(.+)$/);
    if (m) return m[1].trim();
  }
  throw new Error(`could not resolve the egress proxy URL for VM '${vm}' (egress gateway gave no HTTPS_PROXY)`);
}

/** Apply the broker's per-host cred rule(s) + turn MITM on for this VM
 *  (A2). Idempotent. The Anthropic rule is inject + capture:false with the
 *  pinned-absolute `print-key` helper; the placeholder never enters
 *  egress-secrets.json. */
export function configureBroker(vm: string, adapter: AgentAdapter): void {
  const helper = printKeyHelperCommand();
  for (const rule of adapter.credHosts) {
    const args = ['creds', 'add', rule.host, '--name', vm, '--header', rule.header];
    if (rule.inject) args.push('--inject');
    if (rule.capture) args.push('--capture');
    args.push('--helper', rule.helper ?? helper);
    const code = runVm(args);
    if (code !== 0) throw new Error(`failed to write the credential rule for ${rule.host} (exit ${code})`);
  }
  const mitm = runVm(['egress', 'mitm', 'on', '--name', vm]);
  if (mitm !== 0) throw new Error(`failed to enable TLS interception on VM '${vm}' (exit ${mitm})`);
}

export interface RunAgentOpts {
  /** Target VM; defaults to the linked/shared sandbox VM. */
  vm?: string;
  /** Project dir to mount at /persist/workspace; defaults to cwd. */
  projectDir?: string;
  adapter?: AgentAdapter;
  mode?: 'interactive' | 'autonomous';
  task?: string;
  /** Use this session id (normalized to the `agent-` prefix) instead of
   *  minting one — lets a caller (the CLI `--session`, the desktop tab)
   *  pre-allocate the agent's session id. */
  sessionId?: string;
  /** Autonomous: block until the run completes, capturing the result
   *  in-band over the one-shot sentinel path, instead of detaching. */
  wait?: boolean;
}

/** What a launch produced. `result` is set only for a blocking (`--wait`)
 *  autonomous run; `resultPath` is the host path a DETACHED autonomous run
 *  writes its captured JSON result to (read later by reconcile). */
export interface RunAgentResult {
  sessionId: string;
  vm: string;
  mode: 'interactive' | 'autonomous';
  resultPath?: string;
  result?: AutonomousResult;
}

/**
 * Launch a coding agent as the appliance user, wired through the host
 * credential broker. Boots/ensures the sandbox VM, requires the host key,
 * configures the broker, and installs the agent on first use. Then either:
 *
 *   • interactive / detached-autonomous (default): spawns the reattachable
 *     `agent-<id>` tmux session and returns immediately (attach with
 *     `appliance vm shell <vm> --session <id>`). Autonomous redirects its
 *     result to the shared workspace so reconcile can finalize it.
 *   • autonomous + `wait`: runs the headless task to completion over the
 *     vsock one-shot sentinel path, capturing stdout + the exit code, and
 *     returns the classified `result`.
 */
export async function runAgent(opts: RunAgentOpts = {}): Promise<RunAgentResult> {
  const adapter = opts.adapter ?? claudeCodeAdapter;
  const mode = opts.mode ?? 'interactive';
  const vm = opts.vm ?? targetVm();
  const projectDir = path.resolve(opts.projectDir ?? process.cwd());
  const wait = mode === 'autonomous' && opts.wait === true;

  // Fail fast before booting anything if the host key isn't configured —
  // the proxy fails closed, so the agent would only hit a 502 otherwise.
  if (!readAgentKey()) {
    throw new Error(
      'Anthropic key not configured. Run `appliance agent login` to store it host-side ' +
        '(it is brokered into the agent and never enters the VM).'
    );
  }

  console.log(chalk.cyan(`» ensuring sandbox VM '${vm}' with the workspace mounted`));
  await ensureSandboxVm(vm, projectDir);

  console.log(chalk.cyan('» configuring the host credential broker (Anthropic key injected at the proxy)'));
  configureBroker(vm, adapter);

  const proxyUrl = resolveProxyUrl(vm);
  const sessionId = opts.sessionId ? ensureAgentSessionId(opts.sessionId) : mintAgentSessionId();
  const paths = agentResultPaths(projectDir, sessionId);

  // --wait: run the headless task to completion as a captured one-shot over
  // the vsock sentinel path (shell.rs) — stdout (the JSON result) and the
  // agent's real exit code come back in-band. Non-exec so the sentinel can
  // fire after claude; install joined with `&&` so a failed install aborts.
  if (wait) {
    const line = composeLaunchLine(adapter, proxyUrl, { mode, task: opts.task }, false);
    const script = `(${adapter.installCmd}) && (${line})`;
    console.log(chalk.cyan(`» running ${adapter.type} headless to completion (--wait) — capturing the result`));
    const r = vmRunScript(vm, script);
    const result = classifyAutonomousResult(r.status, r.stdout, adapter);
    return { sessionId, vm, mode, result };
  }

  const tmuxSession = `appliance-${sessionId}`;
  const launchLine =
    mode === 'autonomous'
      ? composeAutonomousCaptureLine(adapter, proxyUrl, { mode, task: opts.task }, paths)
      : composeLaunchLine(adapter, proxyUrl, { mode, task: opts.task });

  // One in-guest invocation (runs as the appliance user via the vsock
  // one-shot path): install-on-first-use, then create the DETACHED tmux
  // session running the launch line directly. The install is joined with
  // `&&` (in a subshell, so its own internal `||` is contained) so a
  // failed install ABORTS instead of leaving a dead session; `has-session
  // ||` keeps the launch idempotent; tmux daemonizes, so the session
  // survives this client. The launch line is shQuote-wrapped (POSIX
  // `'\''`) so its already-per-token-quoted argv nests safely as a single
  // `tmux new-session` argument.
  const tmux = `tmux -L appliance -f /etc/appliance/tmux.conf`;
  const script =
    `(${adapter.installCmd}) && ` +
    `(${tmux} has-session -t ${tmuxSession} 2>/dev/null || ` +
    `${tmux} new-session -d -s ${tmuxSession} ${shQuote(launchLine)})`;

  console.log(chalk.cyan(`» launching ${adapter.type} in session ${chalk.bold(sessionId)} (${mode})`));
  const r = vmRunScript(vm, script);
  if (r.status !== 0) {
    throw new Error(`failed to launch the agent session in VM '${vm}' (exit ${r.status}).\n${r.stdout}`);
  }

  console.log(`${chalk.green('✓')} agent ${chalk.bold(sessionId)} running in VM '${vm}'`);
  const bin = path.basename(vmBinary());
  console.log(`  Attach:  appliance vm shell --name ${vm} --session ${sessionId}`);
  console.log(chalk.dim(`           (or ${bin} shell ${vm} --session ${sessionId})`));
  if (mode === 'autonomous') {
    console.log(chalk.dim('  Result:  appliance agent list   (status flips to done/error on completion)'));
  }
  return { sessionId, vm, mode, resultPath: mode === 'autonomous' ? paths.hostJson : undefined };
}
