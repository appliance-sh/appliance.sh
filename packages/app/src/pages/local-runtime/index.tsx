import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Bot,
  Check,
  Copy,
  Download,
  FileText,
  Loader2,
  Play,
  RefreshCw,
  Terminal as TerminalIcon,
  X,
} from 'lucide-react';
import { type ApplianceClient } from '@appliance.sh/sdk/client';
import { Button } from '@/components/ui/button';
import { AgentLoginPanel, useAgentSignedIn } from '@/components/agent-login';
import { AGENT_ADAPTERS, agentAdapter, agentLabel, DEFAULT_AGENT_TYPE } from '@/lib/agents';
import { useHost } from '@/providers/host-provider';
import { useTerminalSessions, mintAgentSessionId, agentSessionKey } from '@/providers/terminal-sessions-provider';
import { useApplianceClient } from '@/hooks/use-appliance-client';
import { cn } from '@/lib/utils';
import { relativeAge } from '@/lib/time';
import type {
  AgentAuthStatus,
  LocalDeploymentInfo,
  LocalPodInfo,
  LocalPreflightCheck,
  LocalServiceInfo,
} from '@/lib/host';

// ① Setup → Doctor host (docs/desktop-ia.md §3 / move-map 4a). The
// prerequisite preflight that used to sit atop the runtimes page now stands
// alone as the canonical Doctor at `/setup/doctor`; I5 extracts a dedicated
// page, so for I2 this thin page hosts the shared `DoctorPanel`. The runtime
// management itself (engines list, lifecycle, egress, credentials, facts)
// moved to ② Clusters (`pages/clusters/*`).
//
// This module also still owns two surfaces that are MID-MIGRATION and ride
// along inside ② until their phases land:
//   · `WorkloadsPanel` (+ tables / pod-log drawer)  → ③ env-detail in I3
//   · `LaunchAgentButton` (agent launcher)           → ④ Agents in I4
// Both are exported and consumed by `pages/clusters/runtime-detail.tsx`.
export function LocalRuntimePage() {
  const host = useHost();
  const supported = Boolean(host.vm);

  if (!supported) {
    return (
      <div className="max-w-2xl space-y-4">
        <h1 className="text-xl font-semibold">Doctor</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          This shell can&rsquo;t run a local runtime — the prerequisite Doctor is only available in the desktop app.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Doctor</h1>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          Prerequisite checks for the local runtime — Docker / kubectl, a running container-runtime daemon, and a
          one-click start.
        </p>
      </header>
      <DoctorPanel />
    </div>
  );
}

// The prerequisite preflight, self-contained: the host query + the
// `PreflightPanel`. Rendered both here (the canonical ① Doctor) and from the
// ② runtime detail's "Re-run checks" entry — one PreflightPanel, two entry
// points (docs/desktop-ia.md §8 Q4).
export function DoctorPanel() {
  const host = useHost();
  const local = host.local;
  const supported = Boolean(host.vm);

  // Preflight: ask the host which of docker/kubectl are installed.
  // Image builds shell out to docker and workload/log reads to kubectl;
  // if either is missing the relevant action would surface a cryptic
  // "failed to spawn" error. We render an actionable install panel
  // instead. Polled lazily so installing a tool in a separate terminal
  // is reflected within a few seconds without requiring a page reload.
  const preflightQuery = useQuery({
    queryKey: ['local-runtime', 'preflight'],
    enabled: supported && Boolean(local?.preflight),
    queryFn: () => local!.preflight(),
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!data) return 5_000;
      // Keep polling while anything's not ready — including docker
      // installed-but-daemon-down — so starting a tool in another
      // window clears the panel within a few seconds.
      return data.every(checkReady) ? false : 5_000;
    },
  });
  const preflightChecks = preflightQuery.data ?? [];

  return (
    <PreflightPanel
      checks={preflightChecks}
      loading={preflightQuery.isLoading}
      onRefresh={() => preflightQuery.refetch()}
      canInstall={Boolean(local?.installPrereq)}
      onInstall={async (tool) => {
        if (!local?.installPrereq) return;
        await local.installPrereq([tool], () => {});
        preflightQuery.refetch();
      }}
      canStartRuntime={Boolean(local?.startContainerRuntime)}
      onStartRuntime={async () => {
        if (!local?.startContainerRuntime) return;
        await local.startContainerRuntime();
        preflightQuery.refetch();
      }}
    />
  );
}

/** Heuristic: does an agent-launch error look like an UPSTREAM auth rejection
 *  (a stale one-year OAuth token or a bad API key)? The one-year token has no
 *  expiry surfacing — the broker injects the stored credential host-side, so an
 *  EXPIRED token does NOT trip the keyless gate; it surfaces as an opaque 401 /
 *  authentication_error from the agent. Rather than thread a mint timestamp
 *  through the `{kind,value}` Keychain envelope (a risky dual Rust+TS writer
 *  change), we detect the failure SHAPE here and offer a re-login.
 *
 *  NOTE: this catches auth failures that surface through `agent.start()` (and
 *  any error routed to the launcher). A 401 that only appears mid-run inside
 *  the observe tab's output is not auto-detected — that would need the
 *  broker/egress to thread upstream response status back to the desktop. */
export function looksLikeAuthFailure(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('401') ||
    m.includes('unauthorized') ||
    m.includes('authentication_error') ||
    m.includes('invalid x-api-key') ||
    m.includes('invalid api key') ||
    m.includes('oauth token') ||
    m.includes('token has expired') ||
    m.includes('token expired') ||
    (m.includes('token') && m.includes('invalid'))
  );
}

// "Launch agent" (Phase 5, A5 / multi-agent G3): pick an agent type
// (claude-code / copilot / codex — driven by the AGENT_ADAPTERS registry),
// spawn it into the VM's shared workspace, and attach it as an agent-typed dock
// tab to observe + steer it. The selected agent's credential is brokered
// host-side per provider and never enters the VM — sign in here, or run
// `appliance agent login --type <agent>` once. The detached, broker-wired
// `agent-<id>` tmux session is created first (so it exists), then the observe
// tab attaches via the reattachable host-shell transport. Only rendered for dev
// VMs with a shared workspace folder.
//
// Rides along inside ② cluster detail until I4 stands up ④ Agents.
export function LaunchAgentButton({ name, disabledReason }: { name: string; disabledReason?: string | null }) {
  const host = useHost();
  const terminals = useTerminalSessions();
  const agentAuth = host.agentAuth;
  const [open, setOpen] = React.useState(false);
  // Which agent to launch + authenticate (the `--type` key). Drives the login
  // panel, the per-agent sign-in status, and the launch/tab metadata.
  const [agentType, setAgentType] = React.useState<string>(DEFAULT_AGENT_TYPE);
  const [task, setTask] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  // Host-side credential status (L3). Null while unknown (still loading, or
  // the web shell has no `agentAuth`); when the desktop reports `configured:
  // false`, the launcher shows the in-app login affordance instead of the
  // task input — so a desktop-only user can authenticate without a terminal
  // rather than hitting the keyless 502.
  const [authStatus, setAuthStatus] = React.useState<AgentAuthStatus | null>(null);
  // A stored credential that upstream now REJECTS (most often a stale one-year
  // OAuth token) keeps `configured: true`, so the keyless gate won't trip — set
  // this when a launch fails with an auth-shaped error, to swap in a re-login
  // nudge instead of a dead 401. See `looksLikeAuthFailure`.
  const [reauthNudge, setReauthNudge] = React.useState(false);
  // Synchronous re-entrancy latch: the `busy` state in the keydown closure
  // is stale within the same tick, so a rapid double-Enter could fire two
  // launches before the first re-render disables the input. The ref flips
  // before any await, so the second Enter is dropped.
  const launchingRef = React.useRef(false);

  // Per-agent "signed in" dots on the picker (Devon nit): probe every agent's
  // host store while the launcher is open, re-running after a login (keyed on
  // the selected agent's `authStatus`) so a freshly-signed-in agent lights up.
  const signedIn = useAgentSignedIn(open && Boolean(agentAuth), authStatus);

  // Refresh the SELECTED agent's credential status when the launcher opens,
  // when the agent type changes (each type has its own provider store), and
  // after a login or a keyless failure — so the gate reflects the live host
  // store for the agent the user is about to launch.
  const refreshAuth = React.useCallback(() => {
    if (!agentAuth) return;
    void agentAuth
      .status(agentType)
      .then(setAuthStatus)
      .catch(() => setAuthStatus(null));
  }, [agentAuth, agentType]);
  React.useEffect(() => {
    if (open) {
      setReauthNudge(false);
      // Clear the previous agent's status so switching types can't briefly
      // show a stale "signed in" for the new agent before its status resolves.
      setAuthStatus(null);
      refreshAuth();
    }
  }, [open, refreshAuth]);

  const needsLogin = Boolean(agentAuth) && authStatus !== null && !authStatus.configured;
  // Brief loading gate (avoids a one-frame flash of the task input before the
  // login panel): the host has the capability but the status hasn't resolved.
  const authLoading = Boolean(agentAuth) && authStatus === null;

  const launch = async () => {
    if (launchingRef.current) return;
    launchingRef.current = true;
    setBusy(true);
    setErr(null);
    try {
      const sessionId = mintAgentSessionId();
      const t = task.trim() || undefined;
      // Spawn the agent FIRST so its tmux session exists, then attach the
      // observe tab — attaching first would create an empty shell session
      // under the agent id instead of reattaching the agent. `--type` is the
      // selected adapter (claude-code / copilot / codex).
      await host.vm!.instance(name).agent.start({ type: agentType, task: t, sessionId });
      terminals.openSession({
        target: name,
        engine: 'microvm',
        clusterName: name,
        mode: 'host',
        // Distinct de-dupe namespace so a plain "Open shell" on this VM
        // can't focus/steal the agent tab (and vice versa).
        sessionKey: agentSessionKey(sessionId),
        sessionId,
        // The desktop launcher only spawns interactive agents — tag the mode
        // so the tab badge shows a steady "attached" glyph instead of the
        // perpetual "working" spinner reserved for autonomous runs. `type`
        // labels the tab so a user can tell which agent it is.
        agent: { type: agentType, status: 'running', mode: 'interactive' },
        title: t ? `Agent · ${t}` : `Agent · ${agentLabel(agentType)}`,
      });
      setOpen(false);
      setTask('');
    } catch (e) {
      // Surfaces the CLI's stderr verbatim — most often "No Anthropic key
      // configured". Re-check the host store so a keyless failure flips the
      // launcher to the in-app login affordance.
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
      refreshAuth();
      // A stored-but-rejected credential (expired one-year OAuth token / bad
      // key) leaves `configured: true`, so `needsLogin` stays false — detect
      // the auth shape and offer a re-login rather than a dead error.
      if (looksLikeAuthFailure(msg)) setReauthNudge(true);
    } finally {
      setBusy(false);
      launchingRef.current = false;
    }
  };

  if (!open) {
    // Gating-off: when the VM has no shared workspace the agent can't run,
    // but keep the control visible (disabled) so the feature stays
    // discoverable rather than silently absent — AND make the reason
    // genuinely reachable (Devon). `buttonVariants` sets
    // `disabled:pointer-events-none`, so a disabled button swallows hover:
    // its native `title` tooltip never fires and it can't be focused or
    // announced. So (a) wrap it in a `<span title>` that keeps
    // pointer-events (the tooltip now fires on the span), and (b) render
    // the reason as adjacent muted text so it reaches everyone regardless.
    if (disabledReason) {
      return (
        <span className="inline-flex items-center gap-2" title={disabledReason}>
          <Button variant="outline" size="sm" disabled>
            <Bot className="h-4 w-4" /> Run agent
          </Button>
          <span role="note" className="max-w-[18rem] text-[11px] leading-snug text-[var(--color-muted-foreground)]">
            {disabledReason}
          </span>
        </span>
      );
    }
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        title="Run a Claude Code agent in the workspace and observe it in a tab"
      >
        <Bot className="h-4 w-4" /> Run agent
      </Button>
    );
  }
  const selectedLabel = agentLabel(agentType);
  const selectedBin = agentAdapter(agentType).bin;

  // The agent-type picker — claude-code / copilot / codex from the registry —
  // shown above every open-state body so the user can switch which agent they
  // launch + authenticate (each agent has its own host store, so switching
  // re-resolves the sign-in status).
  const picker = (
    <div role="group" aria-label="Agent type" className="flex flex-wrap gap-1">
      {AGENT_ADAPTERS.map((a) => {
        const active = a.type === agentType;
        return (
          <button
            key={a.type}
            type="button"
            aria-pressed={active}
            title={signedIn[a.type] ? `${a.blurb} — signed in` : a.blurb}
            disabled={busy}
            onClick={() => setAgentType(a.type)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors disabled:opacity-50',
              active
                ? 'border-cyan-500/50 bg-cyan-500/10 text-[var(--color-foreground)]'
                : 'border-[var(--color-border)] text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)]'
            )}
          >
            <a.Icon className="h-3.5 w-3.5" /> {a.label}
            {/* A green dot marks an agent that already has a stored credential
                (decorative; the "— signed in" suffix on the button title is
                the accessible signal). */}
            {signedIn[a.type] ? (
              <span aria-hidden className="ml-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-green-400" />
            ) : null}
          </button>
        );
      })}
    </div>
  );

  // Brief loading state while the host credential status resolves, so the task
  // input doesn't render for one frame and then swap to the login panel.
  if (authLoading) {
    return (
      <div className="flex flex-col items-start gap-2">
        {picker}
        <div className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking {selectedLabel} sign-in…
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  // Keyless gate (L3): the desktop reports no stored credential for the SELECTED
  // agent, so offer its in-app login right here instead of letting the launch
  // fail at the broker. The credential is brokered in and never enters the VM.
  // The `reauthNudge` branch reuses the same panel when a stored credential was
  // rejected upstream (likely an expired token / bad key).
  if (needsLogin || reauthNudge) {
    return (
      <div className="flex max-w-md flex-col items-start gap-2">
        {picker}
        <p className={cn('text-xs', reauthNudge ? 'text-amber-300' : 'text-[var(--color-muted-foreground)]')}>
          {reauthNudge
            ? `Your ${selectedLabel} credential may be rejected — sign in again. It's stored on this machine and brokered in; it never enters the VM.`
            : `Sign in to run ${selectedLabel} — its credential is stored on this machine and brokered in; it never enters the VM.`}
        </p>
        <AgentLoginPanel
          agentType={agentType}
          onAuthenticated={(s) => {
            setReauthNudge(false);
            setErr(null);
            setAuthStatus(s);
          }}
        />
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-2">
      {picker}
      <div className="flex items-center gap-2">
        <input
          autoFocus
          type="text"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="task (optional) — e.g. fix the failing test"
          className="w-64 rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1 text-xs"
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void launch();
            if (e.key === 'Escape') setOpen(false);
          }}
        />
        <Button size="sm" onClick={() => void launch()} disabled={busy}>
          <Bot className={cn('h-3.5 w-3.5', busy && 'animate-pulse')} /> {busy ? 'Starting…' : 'Run'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
      {/* Task-box honesty (Parker): claude + codex seed the typed task as the
          interactive TUI's first prompt; Copilot's interactive seeding is
          unverified, so its task box only LABELS the tab — say so rather than
          imply it runs. */}
      {agentType === 'copilot' ? (
        <p className="text-[10px] text-[var(--color-muted-foreground)]">
          Copilot opens a fresh interactive session — a task here only labels the tab; it isn&rsquo;t run automatically.
        </p>
      ) : null}
      {/* A keyless failure flips the launcher to the login affordance above;
          any other error shows here as an alert. */}
      {err ? (
        <p role="alert" className="max-w-[28rem] font-mono text-[10px] text-red-300">
          {err}
        </p>
      ) : null}
      <p className="text-[10px] text-[var(--color-muted-foreground)]">
        Runs <code className="font-mono">{selectedBin}</code> in the shared workspace — your {selectedLabel} credential
        is brokered in and never enters the VM.{' '}
        {agentAuth ? (
          authStatus?.configured ? (
            <>
              Signed in
              {authStatus.kind
                ? ` (${authStatus.kind === 'oauth' ? 'Claude subscription' : authStatus.kind === 'pat' ? 'GitHub PAT' : 'API key'})`
                : ''}{' '}
              — manage in Settings.
            </>
          ) : null
        ) : (
          <>
            Store its credential once with <code className="font-mono">appliance agent login --type {agentType}</code>.
          </>
        )}
      </p>
      {/* Honest-limits caveat (Parker): the key is brokered, but the
          workspace is not. Surface the blast radius where the user launches
          so a throwaway sandbox isn't mistaken for a security jail. */}
      <p className="text-[10px] text-amber-300/90">
        ⚠ Sandbox is throwaway, not a jail — the agent can read/write your mounted workspace.
      </p>
    </div>
  );
}

// A prerequisite is "ready" when it's installed AND — for docker — its
// daemon is actually reachable. `daemonRunning` is undefined for tools
// with no daemon (kubectl), so `!== false` leaves those as ready on
// install alone.
function checkReady(c: LocalPreflightCheck): boolean {
  return c.installed && c.daemonRunning !== false;
}

function PreflightPanel({
  checks,
  loading,
  onRefresh,
  canInstall,
  onInstall,
  canStartRuntime,
  onStartRuntime,
}: {
  checks: LocalPreflightCheck[];
  loading: boolean;
  onRefresh: () => void;
  canInstall: boolean;
  onInstall: (tool: string) => Promise<void>;
  canStartRuntime: boolean;
  onStartRuntime: () => Promise<void>;
}) {
  // While preflight is in flight (and we have no cached result), keep
  // the panel out of the layout — the controls below already render a
  // disabled Start button, and a flicker of "Checking…" before the
  // first result tends to be more noisy than informative.
  if (loading && checks.length === 0) return null;
  if (checks.length === 0) return null;
  const notReady = checks.filter((c) => !checkReady(c));
  // When everything's installed and the only thing wrong is a stopped
  // daemon, the panel is about starting the runtime, not installing —
  // reword the heading so it doesn't tell the user to install tools
  // they already have.
  const onlyDaemonDown = notReady.length > 0 && notReady.every((c) => c.installed);
  if (notReady.length === 0) {
    return (
      <section className="flex items-center justify-between gap-3 rounded-md border border-green-500/40 bg-green-500/10 px-3 py-2 text-xs text-green-300">
        <span className="inline-flex items-center gap-2">
          <Check className="h-3.5 w-3.5" />
          Prerequisites ready: {checks.map((c) => c.tool).join(', ')}
        </span>
        <Button variant="ghost" size="icon" aria-label="Re-check prerequisites" onClick={onRefresh}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </Button>
      </section>
    );
  }
  return (
    <section className="space-y-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-300" />
          <div>
            <h2 className="text-sm font-semibold text-amber-200">
              {onlyDaemonDown ? 'Start the container runtime' : 'Install required tools'}
            </h2>
            <p className="mt-0.5 text-xs text-amber-200/80">
              {onlyDaemonDown
                ? 'The local runtime needs a running Docker daemon. Start it below, then re-check.'
                : 'Image builds need Docker; pod shells and deploys need kubectl. Install the missing tools below, then re-check.'}
            </p>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onRefresh}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /> Re-check
        </Button>
      </header>
      <ul className="space-y-2">
        {checks.map((c) => (
          <PreflightRow
            key={c.tool}
            check={c}
            canInstall={canInstall && c.autoInstallable}
            onInstall={onInstall}
            canStartRuntime={canStartRuntime}
            onStartRuntime={onStartRuntime}
          />
        ))}
      </ul>
    </section>
  );
}

function PreflightRow({
  check,
  canInstall,
  onInstall,
  canStartRuntime,
  onStartRuntime,
}: {
  check: LocalPreflightCheck;
  canInstall: boolean;
  onInstall: (tool: string) => Promise<void>;
  canStartRuntime: boolean;
  onStartRuntime: () => Promise<void>;
}) {
  const [copied, setCopied] = React.useState(false);
  const [installing, setInstalling] = React.useState(false);
  const [installError, setInstallError] = React.useState<string | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [startError, setStartError] = React.useState<string | null>(null);

  const ready = checkReady(check);
  // Installed CLI, but no reachable daemon — the "start your runtime"
  // state, distinct from "not installed".
  const daemonDown = check.installed && check.daemonRunning === false;

  const onCopy = async () => {
    if (!check.installHint || typeof navigator === 'undefined' || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(check.installHint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard permission denied or unavailable — leave the hint
      // visible and let the user copy it manually.
    }
  };

  const onClickInstall = async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      await onInstall(check.tool);
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };

  const onClickStart = async () => {
    setStarting(true);
    setStartError(null);
    try {
      await onStartRuntime();
    } catch (err) {
      // Surfaces the backend's actionable message (e.g. colima failed,
      // or this runtime can't be auto-started).
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  return (
    <li
      className={cn(
        'rounded-md border px-3 py-2 text-xs',
        ready ? 'border-green-500/30 bg-green-500/5' : 'border-amber-500/30 bg-amber-500/10'
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 font-medium">
            {ready ? <Check className="h-3.5 w-3.5 text-green-300" /> : <X className="h-3.5 w-3.5 text-amber-300" />}
            <code className="font-mono">{check.tool}</code>
            {check.version ? <span className="text-[var(--color-muted-foreground)]">— {check.version}</span> : null}
            {daemonDown ? <span className="text-amber-300">— not running</span> : null}
          </div>
          <p className="mt-1 text-[var(--color-muted-foreground)]">{check.purpose}</p>
          {daemonDown ? (
            <div className="mt-2 space-y-2">
              {canStartRuntime && check.daemonStartable ? (
                <Button onClick={onClickStart} disabled={starting} size="sm">
                  <Play className={cn('h-3.5 w-3.5', starting && 'animate-pulse')} />
                  {starting ? 'Starting…' : 'Start runtime'}
                </Button>
              ) : null}
              {check.error ? <p className="text-[var(--color-muted-foreground)]">{check.error}</p> : null}
              {startError ? <p className="font-mono text-[10px] text-red-300">{startError}</p> : null}
            </div>
          ) : null}
          {!check.installed ? (
            <div className="mt-2 space-y-2">
              {canInstall ? (
                <div>
                  <Button onClick={onClickInstall} disabled={installing} size="sm">
                    <Download className={cn('h-3.5 w-3.5', installing && 'animate-pulse')} />
                    {installing ? 'Installing…' : `Install ${check.tool}`}
                  </Button>
                  <p className="mt-1 text-[10px] text-[var(--color-muted-foreground)]">
                    Downloads from the upstream release into <code>~/.appliance/bin/</code>. No admin password needed.
                  </p>
                </div>
              ) : null}
              {check.installHint ? (
                <div>
                  {canInstall ? (
                    <p className="text-[10px] uppercase tracking-wide text-[var(--color-muted-foreground)]">
                      Or install manually:
                    </p>
                  ) : null}
                  <div className="mt-1 flex items-center gap-2">
                    <code className="block flex-1 overflow-x-auto rounded bg-black/40 px-2 py-1 font-mono text-[11px]">
                      {check.installHint}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={onCopy}
                      aria-label={`Copy install command for ${check.tool}`}
                    >
                      <Copy className="h-3 w-3" />
                      {copied ? 'Copied' : 'Copy'}
                    </Button>
                  </div>
                </div>
              ) : null}
              {installError ? (
                <p className="font-mono text-[10px] text-red-300">{installError}</p>
              ) : check.error ? (
                <p className="font-mono text-[10px] text-amber-200/80">{check.error}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

// Workloads / pods / services tables + live pod-log tail. Reads through the
// in-VM api-server (the same signed ApplianceClient that powers projects /
// deployments). Rides along inside ② cluster detail until I3 moves it to ③
// env-detail, where workloads belong with the thing deployed.
export function WorkloadsPanel({ clusterId, vmName }: { clusterId: string; vmName?: string }) {
  const host = useHost();
  const terminals = useTerminalSessions();
  const queryClient = useQueryClient();
  const [activePod, setActivePod] = React.useState<LocalPodInfo | null>(null);

  // Workloads + pod logs now read through the in-VM api-server (the same
  // signed ApplianceClient that powers projects/deployments) instead of
  // a kubectl shell-out. The client is bound to the *active* cluster, so
  // we can only read this VM's workloads when it is the selected one;
  // otherwise we'd surface another cluster's state under this card.
  const client = useApplianceClient();
  const { data: config } = useQuery({ queryKey: ['host', 'config'], queryFn: () => host.getConfig() });
  const isActive = config?.selectedClusterId === clusterId;

  const workloadsQuery = useQuery({
    queryKey: ['local-runtime', 'workloads', clusterId],
    enabled: Boolean(client) && isActive,
    queryFn: async () => {
      const res = await client!.listWorkloads();
      if (!res.success) throw res.error;
      return res.data;
    },
    refetchInterval: 5_000,
  });

  const data = workloadsQuery.data;
  const empty = data && data.deployments.length === 0 && data.pods.length === 0 && data.services.length === 0;

  return (
    <>
      <section className="space-y-3 rounded-md border border-[var(--color-border)] p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Workloads · {vmName ?? 'appliance'}</h2>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh workloads"
            onClick={() => workloadsQuery.refetch()}
            disabled={workloadsQuery.isFetching || !isActive}
          >
            <RefreshCw className={cn('h-4 w-4', workloadsQuery.isFetching && 'animate-spin')} />
          </Button>
        </div>

        {!isActive ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Select this microVM as the active cluster to read its workloads through the api-server.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                await host.selectCluster(clusterId);
                queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
              }}
            >
              Select cluster
            </Button>
          </div>
        ) : workloadsQuery.isLoading ? (
          <p className="text-xs text-[var(--color-muted-foreground)]">Loading…</p>
        ) : workloadsQuery.isError ? (
          <p className="text-xs text-red-300">{(workloadsQuery.error as Error).message}</p>
        ) : empty ? (
          <p className="text-xs text-[var(--color-muted-foreground)]">
            No workloads yet. Deploy an appliance via Projects → Deployments to see it here.
          </p>
        ) : data ? (
          <div className="space-y-5">
            <DeploymentsTable deployments={data.deployments} />
            <PodsTable
              pods={data.pods}
              onLogs={setActivePod}
              onShell={
                host.terminal
                  ? (pod) => terminals.openSession({ target: pod.name, engine: 'microvm', clusterName: vmName })
                  : undefined
              }
            />
            <ServicesTable services={data.services} />
          </div>
        ) : null}
      </section>

      {activePod && client ? (
        <PodLogsDrawer pod={activePod} client={client} onClose={() => setActivePod(null)} />
      ) : null}
    </>
  );
}

function DeploymentsTable({ deployments }: { deployments: LocalDeploymentInfo[] }) {
  if (deployments.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-[var(--color-muted-foreground)]">Deployments</div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-[var(--color-muted-foreground)]">
          <tr>
            <th className="py-1 pr-3">Name</th>
            <th className="py-1 pr-3">Image</th>
            <th className="py-1 pr-3">Replicas</th>
            <th className="py-1 pr-3">Age</th>
          </tr>
        </thead>
        <tbody>
          {deployments.map((d) => (
            <tr key={d.name} className="border-t border-[var(--color-border)]">
              <td className="py-1.5 pr-3 font-medium">{d.name}</td>
              <td className="py-1.5 pr-3 font-mono text-xs">{d.image ?? <em>—</em>}</td>
              <td className="py-1.5 pr-3">
                <span className={d.ready === d.desired ? 'text-green-300' : 'text-amber-300'}>
                  {d.ready}/{d.desired}
                </span>
              </td>
              <td className="py-1.5 pr-3 text-xs text-[var(--color-muted-foreground)]">{relativeAge(d.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PodsTable({
  pods,
  onLogs,
  onShell,
}: {
  pods: LocalPodInfo[];
  onLogs: (pod: LocalPodInfo) => void;
  onShell?: (pod: LocalPodInfo) => void;
}) {
  if (pods.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-[var(--color-muted-foreground)]">Pods</div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-[var(--color-muted-foreground)]">
          <tr>
            <th className="py-1 pr-3">Name</th>
            <th className="py-1 pr-3">Phase</th>
            <th className="py-1 pr-3">Ready</th>
            <th className="py-1 pr-3">Restarts</th>
            <th className="py-1 pr-3">Age</th>
            <th className="py-1 pr-3" />
          </tr>
        </thead>
        <tbody>
          {pods.map((p) => (
            <tr key={p.name} className="border-t border-[var(--color-border)]">
              <td className="py-1.5 pr-3 font-medium">{p.name}</td>
              <td className="py-1.5 pr-3">
                <span className={p.phase === 'Running' ? 'text-green-300' : 'text-amber-300'}>{p.phase}</span>
              </td>
              <td className="py-1.5 pr-3">{p.ready ? '✓' : '—'}</td>
              <td className="py-1.5 pr-3">{p.restartCount}</td>
              <td className="py-1.5 pr-3 text-xs text-[var(--color-muted-foreground)]">{relativeAge(p.createdAt)}</td>
              <td className="py-1.5 pr-3 text-right">
                <div className="flex items-center justify-end gap-1">
                  {onShell && p.phase === 'Running' ? (
                    <Button variant="ghost" size="sm" onClick={() => onShell(p)}>
                      <TerminalIcon className="h-3.5 w-3.5" /> Shell
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="sm" onClick={() => onLogs(p)}>
                    <FileText className="h-3.5 w-3.5" /> Logs
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ServicesTable({ services }: { services: LocalServiceInfo[] }) {
  if (services.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-[var(--color-muted-foreground)]">Services</div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-[var(--color-muted-foreground)]">
          <tr>
            <th className="py-1 pr-3">Name</th>
            <th className="py-1 pr-3">Type</th>
            <th className="py-1 pr-3">Cluster IP</th>
            <th className="py-1 pr-3">NodePort</th>
            <th className="py-1 pr-3">URL</th>
          </tr>
        </thead>
        <tbody>
          {services.map((s) => {
            const url = s.nodePort ? `http://localhost:${s.nodePort}` : null;
            return (
              <tr key={s.name} className="border-t border-[var(--color-border)]">
                <td className="py-1.5 pr-3 font-medium">{s.name}</td>
                <td className="py-1.5 pr-3 text-xs">{s.serviceType}</td>
                <td className="py-1.5 pr-3 font-mono text-xs">{s.clusterIp ?? '—'}</td>
                <td className="py-1.5 pr-3 font-mono text-xs">{s.nodePort ?? '—'}</td>
                <td className="py-1.5 pr-3 font-mono text-xs">
                  {url ? (
                    <a
                      className="underline hover:text-[var(--color-accent)]"
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {url}
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Live pod-log tail. Opens a single chunked `follow` stream against the
// api-server (`streamPodLogs`) — the last 500 lines, then new lines as
// they arrive — instead of polling a snapshot. The stream is aborted on
// unmount or when the viewed pod changes.
const LOG_BUFFER_MAX = 5_000;

function PodLogsDrawer({ pod, client, onClose }: { pod: LocalPodInfo; client: ApplianceClient; onClose: () => void }) {
  const [lines, setLines] = React.useState<string[]>([]);
  const [phase, setPhase] = React.useState<'connecting' | 'live' | 'ended' | 'error'>('connecting');
  const [error, setError] = React.useState<string | null>(null);
  const preRef = React.useRef<HTMLPreElement | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    setLines([]);
    setError(null);
    setPhase('connecting');
    let started = false;
    void client
      .streamPodLogs(pod.name, { tailLines: 500, signal: controller.signal }, (line) => {
        if (!started) {
          started = true;
          setPhase('live');
        }
        setLines((prev) => {
          const next = prev.length >= LOG_BUFFER_MAX ? prev.slice(prev.length - LOG_BUFFER_MAX + 1) : prev.slice();
          next.push(line);
          return next;
        });
      })
      .then((res) => {
        if (controller.signal.aborted) return;
        if (!res.success) {
          setError(res.error.message);
          setPhase('error');
        } else {
          setPhase('ended');
        }
      });
    // Abort the follow on unmount / pod switch — the SDK treats an abort
    // as a clean close, not a failure.
    return () => controller.abort();
  }, [client, pod.name]);

  // Keep the newest lines in view as the stream appends.
  React.useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [lines]);

  const text = lines.join('\n');
  const copy = async () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-4 md:items-center"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex h-[70vh] w-full max-w-4xl flex-col overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-background)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Logs for ${pod.name}`}
      >
        <header className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2">
          <div>
            <div className="text-sm font-semibold">Pod logs</div>
            <div className="font-mono text-xs text-[var(--color-muted-foreground)]">{pod.name}</div>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium',
                phase === 'live'
                  ? 'bg-green-500/15 text-green-300'
                  : phase === 'error'
                    ? 'bg-red-500/15 text-red-300'
                    : 'bg-[var(--color-muted)] text-[var(--color-muted-foreground)]'
              )}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  phase === 'live'
                    ? 'animate-pulse bg-green-400'
                    : phase === 'error'
                      ? 'bg-red-400'
                      : 'bg-[var(--color-muted-foreground)]'
                )}
              />
              {phase === 'live'
                ? 'Live'
                : phase === 'connecting'
                  ? 'Connecting…'
                  : phase === 'error'
                    ? 'Error'
                    : 'Ended'}
            </span>
            <Button variant="outline" size="sm" onClick={copy}>
              <Copy className="h-3.5 w-3.5" /> Copy
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </header>
        <pre
          ref={preRef}
          className="flex-1 overflow-auto whitespace-pre-wrap bg-black/40 p-3 font-mono text-xs leading-relaxed"
        >
          {phase === 'error' ? (
            <span className="text-red-300">{error}</span>
          ) : text ? (
            text
          ) : phase === 'connecting' ? (
            'Connecting…'
          ) : (
            <span className="text-[var(--color-muted-foreground)]">No log lines yet.</span>
          )}
        </pre>
      </div>
    </div>
  );
}
