import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
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
  installCmd: 'command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code >/dev/null 2>&1',
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

/** The sandbox VM the cwd project targets: the linked VM, else the shared
 *  default sandbox VM. */
export function targetVm(): string {
  return readSandboxVm() ?? DEFAULT_SANDBOX_VM;
}

/** Resolve the ABSOLUTE host command the proxy runs to fetch the key,
 *  pinning the `appliance` binary path (never PATH-relative). Under a
 *  bun-compiled single binary `execPath` IS `appliance`; under node it's
 *  the interpreter, so we qualify it with the resolved script path. */
export function printKeyHelperCommand(): string {
  const exe = process.execPath;
  const base = path.basename(exe).toLowerCase();
  if (base.startsWith('appliance')) {
    return `'${exe}' agent print-key`;
  }
  // node/bun-as-interpreter: `<interp> <script> agent print-key`.
  const script = process.argv[1] ? path.resolve(process.argv[1]) : exe;
  return `'${exe}' '${script}' agent print-key`;
}

/** Compose the in-session launch line: cd to the workspace then exec the
 *  agent under the proxy/CA/placeholder env. Values are metachar-free
 *  (URLs, fixed strings), so they need no quoting — which keeps this a
 *  single-quoted argument to `tmux new-session` upstream. */
export function composeLaunchLine(adapter: AgentAdapter, proxyUrl: string, opts: AgentLaunchOpts): string {
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
  const assigns = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  const argv = adapter.launchArgv(opts).join(' ');
  return `cd ${GUEST_WORKSPACE}; exec env ${assigns} ${argv}`;
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
}

/**
 * Launch a coding agent in a reattachable `agent-<id>` tmux session as
 * the appliance user, wired through the host credential broker. Boots/
 * ensures the sandbox VM, requires the host key, configures the broker,
 * installs the agent on first use, and spawns the detached session.
 * Returns the session id (attach with `appliance vm shell <vm>
 * --session <id>`).
 */
export async function runAgent(opts: RunAgentOpts = {}): Promise<string> {
  const adapter = opts.adapter ?? claudeCodeAdapter;
  const mode = opts.mode ?? 'interactive';
  const vm = opts.vm ?? targetVm();
  const projectDir = path.resolve(opts.projectDir ?? process.cwd());

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
  const sessionId = mintAgentSessionId();
  const tmuxSession = `appliance-${sessionId}`;
  const launchLine = composeLaunchLine(adapter, proxyUrl, { mode, task: opts.task });

  // One in-guest invocation (runs as the appliance user via the vsock
  // one-shot path): install-on-first-use, then create the DETACHED tmux
  // session running the launch line directly. `has-session ||` keeps it
  // idempotent; tmux daemonizes, so the session survives this client.
  const tmux = `tmux -L appliance -f /etc/appliance/tmux.conf`;
  const script =
    `${adapter.installCmd}; ` +
    `${tmux} has-session -t ${tmuxSession} 2>/dev/null || ` +
    `${tmux} new-session -d -s ${tmuxSession} '${launchLine}'`;

  console.log(chalk.cyan(`» launching ${adapter.type} in session ${chalk.bold(sessionId)} (${mode})`));
  const r = vmRunScript(vm, script);
  if (r.status !== 0) {
    throw new Error(`failed to launch the agent session in VM '${vm}' (exit ${r.status}).\n${r.stdout}`);
  }

  console.log(`${chalk.green('✓')} agent ${chalk.bold(sessionId)} running in VM '${vm}'`);
  const bin = path.basename(vmBinary());
  console.log(`  Attach:  appliance vm shell --name ${vm} --session ${sessionId}`);
  console.log(chalk.dim(`           (or ${bin} shell ${vm} --session ${sessionId})`));
  return sessionId;
}
