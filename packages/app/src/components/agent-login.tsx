import * as React from 'react';
import { Check, ExternalLink, Github, KeyRound, Loader2, Sparkles, TerminalSquare } from 'lucide-react';
import { useHost } from '@/providers/host-provider';
import { Button } from '@/components/ui/button';
import { CommandSnippet } from '@/components/ui/command-snippet';
import type { AgentAuthKind, AgentAuthStatus } from '@/lib/host';
import {
  agentAdapter,
  DEFAULT_AGENT_TYPE,
  GITHUB_FINE_GRAINED_PAT_SETTINGS_URL,
  looksLikeOpenAiKey,
  validateCopilotPat,
} from '@/lib/agents';
import { cn } from '@/lib/utils';

// Desktop agent login (Phase 5, L3 / multi-agent G3 — docs/agent-login.md §4,
// docs/multi-agent-adapters.md §4). Lets a desktop-only user authenticate a
// coding agent WITHOUT a terminal, PARAMETERIZED by agent type. Each agent's
// credential UX (and its host store) differs:
//   • claude-code — API key (masked paste → `agent login api-key`) OR
//     "Sign in with Claude": runs `claude setup-token` in a visible host
//     terminal (the full-screen TUI shows a one-year token on-screen ONLY —
//     there is no headless capture, docs §7), then a masked field captures the
//     token the user copies. Stored under the `anthropic` provider.
//   • copilot — a masked fine-grained GitHub PAT field. We REQUIRE a
//     `github_pat_` token scoped to ONLY `Copilot Requests` (mirrors the CLI's
//     `validateCopilotPat`; the narrow scope is the security bound on host-keyed
//     injection, docs §4/§7) and REJECT classic `ghp_` PATs. Stored under the
//     `github-copilot` provider, tagged `pat`.
//   • codex — a masked OpenAI API key field, soft `sk-` shape warning. Stored
//     under the `openai` provider, tagged `api-key`.
// The credential is stored host-side (Keychain) PER PROVIDER and NEVER sent to
// the VM — the egress broker injects it host-side at request time.

const SETUP_TOKEN_CMD = 'claude setup-token';

/** Pull the first `sk-ant-oat01-…` token out of a paste — mirrors the CLI's
 *  `extractOAuthToken` so a paste of the bare token OR the whole
 *  `export CLAUDE_CODE_OAUTH_TOKEN=…` line `setup-token` prints both work
 *  (ANSI colour codes stripped first). Returns null when no token is found. */
function extractOauthToken(raw: string): string | null {
  const clean = raw.replace(/\[[0-9;?]*[ -/]*[@-~]/g, '');
  const m = clean.match(/sk-ant-oat01-[A-Za-z0-9_-]+/);
  return m ? m[0] : null;
}

/** Label a stored credential kind in the agent's own vocabulary. */
function kindLabel(kind: AgentAuthKind): string {
  if (kind === 'oauth') return 'Claude subscription';
  if (kind === 'pat') return 'GitHub PAT';
  return 'API key';
}

/**
 * Self-contained agent-login control, parameterized by `agentType` (default
 * `claude-code`). Shows the current signed-in state for THAT agent and lets the
 * user store its credential host-side via `host.agentAuth` (each agent → its
 * own provider store). Reused on the launcher's keyless path and in Settings.
 * Renders nothing when the host has no `agentAuth` capability (web shell).
 */
export function AgentLoginPanel({
  agentType = DEFAULT_AGENT_TYPE,
  onAuthenticated,
  className,
}: {
  agentType?: string;
  onAuthenticated?: (status: AgentAuthStatus) => void;
  className?: string;
}) {
  const host = useHost();
  const auth = host.agentAuth;
  const adapter = agentAdapter(agentType);

  const [status, setStatus] = React.useState<AgentAuthStatus | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  // The kind we just stored — Settings can label "Signed in (…)" immediately
  // even on macOS, where `status()` deliberately doesn't read the secret to
  // discover the kind (that would pop a Keychain prompt).
  const [lastKind, setLastKind] = React.useState<AgentAuthKind | null>(null);

  const refreshStatus = React.useCallback(async (): Promise<AgentAuthStatus | null> => {
    if (!auth) return null;
    try {
      const s = await auth.status(adapter.type);
      setStatus(s);
      return s;
    } catch {
      const s = { configured: false, kind: null } as const;
      setStatus(s);
      return s;
    }
  }, [auth, adapter.type]);

  React.useEffect(() => {
    // Re-resolve when the agent type changes (the picker switches stores).
    setStatus(null);
    setLastKind(null);
    setErr(null);
    void refreshStatus();
  }, [refreshStatus]);

  if (!auth) return null; // desktop-only capability

  const finish = (kind: AgentAuthKind, s: AgentAuthStatus | null) => {
    setLastKind(kind);
    onAuthenticated?.(s ?? { configured: true, kind });
  };

  // Store a resolved secret under this agent's provider store, tagged by kind.
  // Shared by all three credential UXes — the only per-agent differences are
  // the input + validation that produce `(kind, value)`.
  const store = async (kind: AgentAuthKind, value: string, after?: () => void) => {
    setBusy(true);
    setErr(null);
    try {
      await auth.login({ agentType: adapter.type, kind, value });
      after?.();
      finish(kind, await refreshStatus());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    setErr(null);
    try {
      await auth.logout(adapter.type);
      setLastKind(null);
      await refreshStatus();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const displayKind = status?.kind ?? lastKind;

  return (
    <div className={cn('w-full max-w-md space-y-3 text-xs', className)}>
      {status?.configured ? (
        <div className="flex items-center justify-between gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-muted)] px-3 py-2">
          <span className="flex items-center gap-2">
            <Check className="h-3.5 w-3.5 text-green-400" />
            Signed in to {adapter.label}
            {displayKind ? (
              <span className="text-[var(--color-muted-foreground)]"> · {kindLabel(displayKind)}</span>
            ) : null}
          </span>
          <Button variant="ghost" size="sm" onClick={() => void signOut()} disabled={busy}>
            Sign out
          </Button>
        </div>
      ) : null}

      {adapter.login === 'claude' ? (
        <ClaudeLogin auth={auth} busy={busy} setErr={setErr} store={store} />
      ) : adapter.login === 'github-pat' ? (
        <CopilotPatLogin busy={busy} setErr={setErr} store={store} />
      ) : (
        <OpenAiKeyLogin busy={busy} setErr={setErr} store={store} />
      )}

      {err ? (
        <p role="alert" className="font-mono text-[10px] text-red-300">
          {err}
        </p>
      ) : null}

      <p className="text-[10px] text-[var(--color-muted-foreground)]">
        Stored in your login keychain on this machine, per agent. Brokered into agents at request time — it never enters
        the VM.
      </p>
    </div>
  );
}

// ---- claude-code: API key OR "Sign in with Claude" (unchanged UX) --------

type StoreFn = (kind: AgentAuthKind, value: string, after?: () => void) => Promise<void>;

function ClaudeLogin({
  auth,
  busy,
  setErr,
  store,
}: {
  auth: NonNullable<ReturnType<typeof useHost>['agentAuth']>;
  busy: boolean;
  setErr: (e: string | null) => void;
  store: StoreFn;
}) {
  const [mode, setMode] = React.useState<'oauth' | 'api-key'>('oauth');
  const [apiKey, setApiKey] = React.useState('');
  const [paste, setPaste] = React.useState('');
  const [hasClaude, setHasClaude] = React.useState<boolean | null>(null);
  const [terminalLaunched, setTerminalLaunched] = React.useState(false);
  // True when the last "Open terminal" click could NOT auto-launch a terminal
  // (non-macOS, where runSetupToken() resolves false, or a launch error). Drives
  // an inline "copy the command below" note so the click is never a dead no-op.
  const [terminalAutoOpenFailed, setTerminalAutoOpenFailed] = React.useState(false);

  // Probe host `claude` lazily the first time the OAuth mode is shown — it
  // gates "Sign in with Claude" (setup-token needs a host `claude`).
  React.useEffect(() => {
    if (mode !== 'oauth' || hasClaude !== null) return;
    let cancelled = false;
    void auth
      .hasHostClaude()
      .then((ok) => !cancelled && setHasClaude(ok))
      .catch(() => !cancelled && setHasClaude(false));
    return () => {
      cancelled = true;
    };
  }, [mode, auth, hasClaude]);

  // The "Terminal opened" confirmation is transient: re-clicking re-launches,
  // so revert the label after a few seconds rather than leaving a stale sticky
  // "Terminal opened" that hides that the button is still actionable.
  React.useEffect(() => {
    if (!terminalLaunched) return;
    const id = setTimeout(() => setTerminalLaunched(false), 4000);
    return () => clearTimeout(id);
  }, [terminalLaunched]);

  const saveApiKey = () => {
    const value = apiKey.trim();
    if (!value) {
      setErr('Paste an Anthropic API key first.');
      return;
    }
    void store('api-key', value, () => setApiKey(''));
  };

  const saveOauth = () => {
    const token = extractOauthToken(paste);
    if (!token) {
      setErr('Could not find an sk-ant-oat01- token in what you pasted. Copy the token shown by `claude setup-token`.');
      return;
    }
    void store('oauth', token, () => setPaste(''));
  };

  const openTerminal = async () => {
    setErr(null);
    setTerminalAutoOpenFailed(false);
    try {
      const launched = await auth.runSetupToken();
      setTerminalLaunched(launched);
      // Off-macOS (or any host without an auto-launch) resolves false — surface
      // the manual fallback instead of a silent no-op.
      setTerminalAutoOpenFailed(!launched);
    } catch (e) {
      // Best-effort: the manual command below is always available.
      setTerminalLaunched(false);
      setTerminalAutoOpenFailed(true);
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  // Soft, NON-blocking shape check: Anthropic keys are `sk-ant-…`. A mis-paste
  // would store "successfully" then 401 at launch, so warn early — but let the
  // user proceed (we don't gate Save on it; the prefix isn't a hard contract).
  const apiKeyTrimmed = apiKey.trim();
  const apiKeyShapeWarn = apiKeyTrimmed.length > 0 && !apiKeyTrimmed.startsWith('sk-ant-');

  return (
    <>
      {/* Mode toggle: lead with the subscription path, API key as the
          alternative. */}
      <div
        role="group"
        aria-label="Authentication method"
        className="inline-flex rounded-md border border-[var(--color-border)] p-0.5"
      >
        <ModeTab active={mode === 'oauth'} onClick={() => setMode('oauth')}>
          <Sparkles className="h-3.5 w-3.5" /> Sign in with Claude
        </ModeTab>
        <ModeTab active={mode === 'api-key'} onClick={() => setMode('api-key')}>
          <KeyRound className="h-3.5 w-3.5" /> API key
        </ModeTab>
      </div>

      {mode === 'oauth' ? (
        hasClaude === false ? (
          <div className="space-y-2 rounded-md border border-dashed border-[var(--color-border)] p-3 text-[var(--color-muted-foreground)]">
            <p>
              Claude Code isn&rsquo;t installed on this machine, so &ldquo;Sign in with Claude&rdquo; can&rsquo;t run.
              Install it with{' '}
              <code className="font-mono text-[var(--color-foreground)]">npm install -g @anthropic-ai/claude-code</code>
              , or use an API key instead.
            </p>
            <Button variant="outline" size="sm" onClick={() => setMode('api-key')}>
              <KeyRound className="h-3.5 w-3.5" /> Use an API key
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-[var(--color-muted-foreground)]">
              Sign in with your Claude Pro/Max/Team subscription. This runs{' '}
              <code className="font-mono">claude setup-token</code> in a terminal; a browser opens, then the terminal
              shows a one-year token to paste back here.
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void openTerminal()}
                disabled={busy || hasClaude === null}
              >
                <TerminalSquare className="h-3.5 w-3.5" />
                {terminalLaunched ? 'Terminal opened — run again?' : 'Open terminal & run it'}
              </Button>
              {hasClaude === null ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--color-muted-foreground)]" />
              ) : null}
            </div>
            {terminalAutoOpenFailed ? (
              <p className="text-[var(--color-muted-foreground)]">
                Couldn&rsquo;t open a terminal automatically — copy the command below and run it yourself.
              </p>
            ) : null}
            <div className="space-y-1">
              <span className="text-[var(--color-muted-foreground)]">
                {terminalAutoOpenFailed ? 'Run this in any terminal:' : '…or run it yourself:'}
              </span>
              <CommandSnippet command={SETUP_TOKEN_CMD} />
            </div>
            <label className="block space-y-1">
              <span className="text-[var(--color-muted-foreground)]">Paste the token (sk-ant-oat01-…)</span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveOauth();
                }}
                placeholder="sk-ant-oat01-…"
                disabled={busy}
                className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1.5 font-mono disabled:opacity-50"
              />
            </label>
            <Button size="sm" onClick={saveOauth} disabled={busy || !paste.trim()}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save token
            </Button>
          </div>
        )
      ) : (
        <div className="space-y-2">
          <p className="text-[var(--color-muted-foreground)]">
            Paste an Anthropic API key (<code className="font-mono">sk-ant-…</code>). Get one from the Anthropic
            Console.
          </p>
          <label className="block space-y-1">
            <span className="text-[var(--color-muted-foreground)]">API key</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveApiKey();
              }}
              placeholder="sk-ant-…"
              disabled={busy}
              className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1.5 font-mono disabled:opacity-50"
            />
          </label>
          {apiKeyShapeWarn ? (
            <p className="text-amber-300/90">
              That doesn&rsquo;t look like an Anthropic key — they start with <code className="font-mono">sk-ant-</code>
              . You can still save it.
            </p>
          ) : null}
          <Button size="sm" onClick={saveApiKey} disabled={busy || !apiKey.trim()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save key
          </Button>
        </div>
      )}
    </>
  );
}

// ---- copilot: fine-grained GitHub PAT (Copilot Requests only) ------------

function CopilotPatLogin({
  busy,
  setErr,
  store,
}: {
  busy: boolean;
  setErr: (e: string | null) => void;
  store: StoreFn;
}) {
  const [pat, setPat] = React.useState('');

  const save = () => {
    const v = validateCopilotPat(pat);
    if (!v.ok) {
      setErr(
        v.reason === 'classic'
          ? 'Classic ghp_ PAT rejected — it carries your full account scope. Create a fine-grained github_pat_ token scoped to Copilot Requests only.'
          : v.reason === 'empty'
            ? 'Paste a fine-grained GitHub PAT first.'
            : 'Expected a fine-grained GitHub PAT starting with github_pat_. Mint one scoped to Copilot Requests and paste it.'
      );
      return;
    }
    void store('pat', v.value, () => setPat(''));
  };

  const trimmed = pat.trim();
  // Live shape feedback BEFORE save: a classic ghp_ is a hard reject; anything
  // non-empty that isn't github_pat_ gets a soft heads-up (Save still validates).
  const isClassic = trimmed.startsWith('ghp_');
  const wrongShape = trimmed.length > 0 && !isClassic && !trimmed.startsWith('github_pat_');

  return (
    <div className="space-y-2">
      <p className="text-[var(--color-muted-foreground)]">
        GitHub Copilot signs in with a <span className="text-[var(--color-foreground)]">fine-grained GitHub PAT</span>.
        The token is brokered onto Copilot&rsquo;s <code className="font-mono">api.github.com</code> leg and never
        enters the VM.
      </p>

      {/* Security bound (Sasha's pre-ship guard): the fine-grained PAT's narrow
          scope is the ENTIRE bound on host-keyed injection, so make the
          single-scope requirement impossible to miss. */}
      <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-2.5 py-2 text-amber-200">
        <p className="font-semibold">
          Grant ONLY the <code className="font-mono">Copilot Requests</code> permission.
        </p>
        <p className="mt-1 text-[10px] leading-relaxed text-amber-200/80">
          That single scope is the security bound: the PAT is injected on ALL guest&nbsp;&rarr;&nbsp;
          <code className="font-mono">api.github.com</code> traffic, so a broader scope would let the sandbox act beyond
          Copilot requests. Classic <code className="font-mono">ghp_</code> tokens are rejected — they carry your full
          account scope.
        </p>
        <a
          href={GITHUB_FINE_GRAINED_PAT_SETTINGS_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-medium text-amber-100 underline hover:text-white"
        >
          <ExternalLink className="h-3 w-3" /> Create a fine-grained token on GitHub
        </a>
      </div>

      <label className="block space-y-1">
        <span className="text-[var(--color-muted-foreground)]">Fine-grained PAT</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={pat}
          onChange={(e) => setPat(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
          }}
          placeholder="github_pat_…"
          disabled={busy}
          className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1.5 font-mono disabled:opacity-50"
        />
      </label>
      {isClassic ? (
        <p className="text-red-300">
          That&rsquo;s a classic <code className="font-mono">ghp_</code> token — rejected. Use a fine-grained{' '}
          <code className="font-mono">github_pat_</code> token scoped to Copilot Requests only.
        </p>
      ) : wrongShape ? (
        <p className="text-amber-300/90">
          A fine-grained PAT starts with <code className="font-mono">github_pat_</code>.
        </p>
      ) : null}
      <Button size="sm" onClick={save} disabled={busy || !trimmed || isClassic}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Github className="h-3.5 w-3.5" />} Save PAT
      </Button>
    </div>
  );
}

// ---- codex: OpenAI API key -----------------------------------------------

function OpenAiKeyLogin({
  busy,
  setErr,
  store,
}: {
  busy: boolean;
  setErr: (e: string | null) => void;
  store: StoreFn;
}) {
  const [key, setKey] = React.useState('');

  const save = () => {
    const value = key.trim();
    if (!value) {
      setErr('Paste an OpenAI API key first.');
      return;
    }
    void store('api-key', value, () => setKey(''));
  };

  // Soft, NON-blocking shape check (mirrors the CLI's `looksLikeOpenAiKey`):
  // OpenAI keys are `sk-…`. Warn but never gate Save — there's no hard format.
  const trimmed = key.trim();
  const shapeWarn = trimmed.length > 0 && !looksLikeOpenAiKey(trimmed);

  return (
    <div className="space-y-2">
      <p className="text-[var(--color-muted-foreground)]">
        Paste an OpenAI API key (<code className="font-mono">sk-…</code>). It&rsquo;s brokered onto Codex&rsquo;s{' '}
        <code className="font-mono">api.openai.com</code> calls and never enters the VM. Get one from the OpenAI
        platform dashboard.
      </p>
      <label className="block space-y-1">
        <span className="text-[var(--color-muted-foreground)]">API key</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
          }}
          placeholder="sk-…"
          disabled={busy}
          className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1.5 font-mono disabled:opacity-50"
        />
      </label>
      {shapeWarn ? (
        <p className="text-amber-300/90">
          That doesn&rsquo;t look like an OpenAI key — they start with <code className="font-mono">sk-</code>. You can
          still save it.
        </p>
      ) : null}
      <Button size="sm" onClick={save} disabled={busy || !trimmed}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save key
      </Button>
    </div>
  );
}

function ModeTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors',
        active
          ? 'bg-[var(--color-accent)] text-[var(--color-foreground)]'
          : 'text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]'
      )}
    >
      {children}
    </button>
  );
}
