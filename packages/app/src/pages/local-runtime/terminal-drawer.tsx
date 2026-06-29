import * as React from 'react';
import { useLocation } from 'react-router';
import {
  useTerminalSessions,
  statusLabel,
  statusDotClass,
  type TerminalSessionMeta,
} from '@/providers/terminal-sessions-provider';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';

// View over a provider-owned terminal session (E3.2).
//
// This component no longer owns the xterm lifecycle: it does not create a
// `Terminal`, does not open a PTY, and — crucially — does NOT call
// `session.close()` on unmount. The live `Terminal` + host `TerminalSession`
// live in `TerminalSessionsProvider` (mounted above the router), so they
// survive route changes. Here we only *mount the view*: we ask the provider
// to reparent the session's xterm node into our container and keep it sized.
//
// Closing a session is an explicit user action (End shell → `closeSession`,
// which destroys the PTY). Dismissing the drawer (the backdrop, Hide, or
// Esc) only hides it — the process keeps running.

// Status badge — mirrors `PodLogsDrawer`'s pulsing-dot badge so the two
// live surfaces read the same: a pulsing green "Live" when connected,
// plain-language states otherwise.
function StatusPill({ status }: { status: TerminalSessionMeta['status'] }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium',
        status === 'open'
          ? 'bg-green-500/15 text-green-300'
          : status === 'error'
            ? 'bg-red-500/15 text-red-300'
            : 'bg-[var(--color-muted)] text-[var(--color-muted-foreground)]'
      )}
    >
      {/* Label + dot come from the shared helpers so the dock tab (E3.3) and
          this pill (E3.2) can't drift on the four-way status semantics. */}
      <span className={cn('h-1.5 w-1.5 rounded-full', statusDotClass(status))} />
      {statusLabel(status)}
    </span>
  );
}

function TerminalDrawerView({ session }: { session: TerminalSessionMeta }) {
  // Destructure the stable callbacks: the whole context value gets a new
  // identity on every status patch / sibling open / hide / focus, so an
  // effect that depends on it would re-park + re-attach + re-fit + steal
  // focus on unrelated changes. The callbacks themselves are stable.
  const { attachView, hide, closeSession, isFocused } = useTerminalSessions();
  const confirm = useConfirm();
  const mountRef = React.useRef<HTMLDivElement | null>(null);
  // The control that opened this shell — captured on mount (before xterm
  // grabs focus in its rAF) so dismissing can hand focus back to it.
  const openerRef = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    return attachView(session.id, el);
  }, [attachView, session.id]);

  React.useEffect(() => {
    const el = document.activeElement;
    openerRef.current = el instanceof HTMLElement ? el : null;
  }, []);

  // Hide the modal (the PTY keeps running) and return focus to the opener.
  const dismiss = React.useCallback(() => {
    hide();
    openerRef.current?.focus();
  }, [hide]);

  // End shell — the only path that destroys the PTY. Confirm first while
  // the process is still live; a closed/error session closes silently.
  const end = React.useCallback(async () => {
    if (session.status === 'open') {
      const ok = await confirm({
        title: 'End this shell?',
        description: 'The running process will be terminated.',
        confirmLabel: 'End shell',
      });
      if (!ok) return;
    }
    closeSession(session.id);
  }, [confirm, closeSession, session.id, session.status]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-4 md:items-center"
      onClick={dismiss}
      role="presentation"
    >
      <div
        className="flex h-[70vh] w-full max-w-4xl flex-col overflow-hidden rounded-md border border-[var(--color-border)] bg-[#0a0a0a]"
        onClick={(e) => e.stopPropagation()}
        // Capture phase so Esc reaches us before xterm — but only hijack it
        // when the terminal is NOT focused (e.g. focus on the Hide button).
        // When the terminal holds focus, defer to xterm's custom key handler:
        // a focused full-screen TUI (vim/less) gets raw Esc, while a normal
        // prompt Hides the view there. This keeps reattachable TUIs usable
        // (E3.4 / Devon) without losing Esc-to-Hide. Scoped to the dialog
        // subtree, so an overlaid confirm dialog keeps its own Esc handling.
        onKeyDownCapture={(e) => {
          if (e.key !== 'Escape') return;
          if (isFocused(session.id)) return;
          e.preventDefault();
          e.stopPropagation();
          dismiss();
        }}
        role="dialog"
        aria-label={`Terminal: ${session.subtitle}`}
      >
        <header className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-background)] px-4 py-2">
          <div>
            <div className="text-sm font-semibold">{session.title}</div>
            <div className="font-mono text-xs text-[var(--color-muted-foreground)]">{session.subtitle}</div>
          </div>
          <div className="flex items-center gap-3">
            <StatusPill status={session.status} />
            {/* Hide is the primary, obvious action — it keeps the session
                alive. End shell is destructive and confirmed: it's the only
                control that kills the running process. */}
            <Button size="sm" onClick={dismiss}>
              Hide
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void end()}>
              End shell
            </Button>
          </div>
        </header>

        {session.error ? (
          <div className="border-b border-red-500/40 bg-red-500/10 px-4 py-2 font-mono text-xs text-red-300">
            {session.error}
          </div>
        ) : null}

        <div ref={mountRef} className="min-h-0 flex-1 overflow-hidden p-2" />
      </div>
    </div>
  );
}

// Persistent terminal layer — rendered once in `app-shell.tsx`, OUTSIDE the
// route `<Outlet/>`, so navigating never unmounts it and thus never tears
// down the active session. It simply shows the active session's view (or
// nothing when hidden); the session objects themselves live in the provider.
export function TerminalLayer() {
  const { sessions, activeId, hide } = useTerminalSessions();
  const { pathname } = useLocation();

  // Spec §4.1: a route change HIDES the active terminal — it does not
  // close it. The modal is full-screen (`fixed inset-0 z-40`), so leaving
  // it up would cover the destination route and nav would appear to do
  // nothing. Hiding keeps the PTY + scrollback alive; only End shell
  // destroys the session. (This lives here, not in the provider, because
  // the provider is mounted above the router and has no `useLocation`.)
  React.useEffect(() => {
    hide();
  }, [pathname, hide]);

  const active = activeId ? sessions.find((s) => s.id === activeId) : undefined;
  if (!active) return null;
  return <TerminalDrawerView session={active} />;
}
