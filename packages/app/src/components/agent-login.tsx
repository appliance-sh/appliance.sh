import * as React from 'react';
import { Check, KeyRound, Loader2, Sparkles, TerminalSquare } from 'lucide-react';
import { useHost } from '@/providers/host-provider';
import { Button } from '@/components/ui/button';
import { CommandSnippet } from '@/components/ui/command-snippet';
import type { AgentAuthKind, AgentAuthStatus } from '@/lib/host';
import { cn } from '@/lib/utils';

// Desktop agent login (Phase 5, L3 — docs/agent-login.md §4). Lets a
// desktop-only user authenticate the agent WITHOUT a terminal, in either
// mode:
//   • API key       — a masked paste field → `microvm_agent_login('api-key')`.
//   • Sign in with   — runs `claude setup-token` in a visible host terminal
//     Claude (OAuth)   (the full-screen TUI shows a one-year token on-screen
//                       ONLY — there is no headless capture, docs §7), then a
//                       masked paste field captures the token the user copies
//                       → `microvm_agent_login('oauth')`.
// The credential is stored host-side (Keychain) and NEVER sent to the VM —
// the egress broker injects it host-side at request time.

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

function kindLabel(kind: AgentAuthKind): string {
  return kind === 'oauth' ? 'Claude subscription' : 'API key';
}

/**
 * Self-contained agent-login control. Shows the current signed-in state and
 * lets the user store an Anthropic credential host-side via `host.agentAuth`.
 * Reused on the launcher's keyless path and in Settings. Renders nothing when
 * the host has no `agentAuth` capability (web shell).
 */
export function AgentLoginPanel({
  onAuthenticated,
  className,
}: {
  onAuthenticated?: (status: AgentAuthStatus) => void;
  className?: string;
}) {
  const host = useHost();
  const auth = host.agentAuth;

  const [status, setStatus] = React.useState<AgentAuthStatus | null>(null);
  const [mode, setMode] = React.useState<AgentAuthKind>('oauth');
  const [apiKey, setApiKey] = React.useState('');
  const [paste, setPaste] = React.useState('');
  const [hasClaude, setHasClaude] = React.useState<boolean | null>(null);
  const [terminalLaunched, setTerminalLaunched] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  // The kind we just stored — Settings can label "Signed in (…)" immediately
  // even on macOS, where `status()` deliberately doesn't read the secret to
  // discover the kind (that would pop a Keychain prompt).
  const [lastKind, setLastKind] = React.useState<AgentAuthKind | null>(null);

  const refreshStatus = React.useCallback(async (): Promise<AgentAuthStatus | null> => {
    if (!auth) return null;
    try {
      const s = await auth.status();
      setStatus(s);
      return s;
    } catch {
      const s = { configured: false, kind: null } as const;
      setStatus(s);
      return s;
    }
  }, [auth]);

  React.useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // Probe host `claude` lazily the first time the OAuth mode is shown — it
  // gates "Sign in with Claude" (setup-token needs a host `claude`).
  React.useEffect(() => {
    if (mode !== 'oauth' || !auth || hasClaude !== null) return;
    let cancelled = false;
    void auth
      .hasHostClaude()
      .then((ok) => !cancelled && setHasClaude(ok))
      .catch(() => !cancelled && setHasClaude(false));
    return () => {
      cancelled = true;
    };
  }, [mode, auth, hasClaude]);

  if (!auth) return null; // desktop-only capability

  const finish = (kind: AgentAuthKind, s: AgentAuthStatus | null) => {
    setLastKind(kind);
    onAuthenticated?.(s ?? { configured: true, kind });
  };

  const saveApiKey = async () => {
    const value = apiKey.trim();
    if (!value) {
      setErr('Paste an Anthropic API key first.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await auth.login({ kind: 'api-key', value });
      setApiKey('');
      finish('api-key', await refreshStatus());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveOauth = async () => {
    const token = extractOauthToken(paste);
    if (!token) {
      setErr('Could not find an sk-ant-oat01- token in what you pasted. Copy the token shown by `claude setup-token`.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await auth.login({ kind: 'oauth', value: token });
      setPaste('');
      finish('oauth', await refreshStatus());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const openTerminal = async () => {
    setErr(null);
    try {
      setTerminalLaunched(await auth.runSetupToken());
    } catch (e) {
      // Best-effort: the manual command below is always available.
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const signOut = async () => {
    setBusy(true);
    setErr(null);
    try {
      await auth.logout();
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
            Signed in
            {displayKind ? (
              <span className="text-[var(--color-muted-foreground)]"> · {kindLabel(displayKind)}</span>
            ) : null}
          </span>
          <Button variant="ghost" size="sm" onClick={() => void signOut()} disabled={busy}>
            Sign out
          </Button>
        </div>
      ) : null}

      {/* Mode toggle: lead with the subscription path, API key as the
          alternative. */}
      <div className="inline-flex rounded-md border border-[var(--color-border)] p-0.5">
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
                {terminalLaunched ? 'Terminal opened' : 'Open terminal & run it'}
              </Button>
              {hasClaude === null ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--color-muted-foreground)]" />
              ) : null}
            </div>
            <div className="space-y-1">
              <span className="text-[var(--color-muted-foreground)]">…or run it yourself:</span>
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
                  if (e.key === 'Enter') void saveOauth();
                }}
                placeholder="sk-ant-oat01-…"
                disabled={busy}
                className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1.5 font-mono disabled:opacity-50"
              />
            </label>
            <Button size="sm" onClick={() => void saveOauth()} disabled={busy || !paste.trim()}>
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
                if (e.key === 'Enter') void saveApiKey();
              }}
              placeholder="sk-ant-…"
              disabled={busy}
              className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1.5 font-mono disabled:opacity-50"
            />
          </label>
          <Button size="sm" onClick={() => void saveApiKey()} disabled={busy || !apiKey.trim()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save key
          </Button>
        </div>
      )}

      {err ? (
        <p role="alert" className="font-mono text-[10px] text-red-300">
          {err}
        </p>
      ) : null}

      <p className="text-[10px] text-[var(--color-muted-foreground)]">
        Stored in your login keychain on this machine. Brokered into agents at request time — it never enters the VM.
      </p>
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
