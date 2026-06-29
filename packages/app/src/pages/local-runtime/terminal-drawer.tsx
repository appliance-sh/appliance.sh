import * as React from 'react';
import { useTerminalSessions, type TerminalSessionMeta } from '@/providers/terminal-sessions-provider';

// View over a provider-owned terminal session (E3.2).
//
// This component no longer owns the xterm lifecycle: it does not create a
// `Terminal`, does not open a PTY, and — crucially — does NOT call
// `session.close()` on unmount. The live `Terminal` + host `TerminalSession`
// live in `TerminalSessionsProvider` (mounted above the router), so they
// survive route changes. Here we only *mount the view*: we ask the provider
// to reparent the session's xterm node into our container and keep it sized.
//
// Closing a session is an explicit user action (the Close button →
// `closeSession`, which destroys the PTY). Dismissing the drawer (the
// backdrop, or Hide) only hides it — the process keeps running.
function TerminalDrawerView({ session }: { session: TerminalSessionMeta }) {
  const terminals = useTerminalSessions();
  const mountRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    return terminals.attachView(session.id, el);
  }, [terminals, session.id]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-4 md:items-center"
      onClick={() => terminals.hide()}
      role="presentation"
    >
      <div
        className="flex h-[70vh] w-full max-w-4xl flex-col overflow-hidden rounded-md border border-[var(--color-border)] bg-[#0a0a0a]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Terminal: ${session.subtitle}`}
      >
        <header className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-background)] px-4 py-2">
          <div>
            <div className="text-sm font-semibold">{session.title}</div>
            <div className="font-mono text-xs text-[var(--color-muted-foreground)]">{session.subtitle}</div>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={
                session.status === 'open'
                  ? 'text-xs text-green-300'
                  : session.status === 'connecting'
                    ? 'text-xs text-cyan-300'
                    : 'text-xs text-[var(--color-muted-foreground)]'
              }
            >
              {session.status === 'connecting' ? 'connecting…' : session.status}
            </span>
            {/* Hide keeps the session alive (the process keeps running); only
                Close destroys the PTY. */}
            <button
              type="button"
              onClick={() => terminals.hide()}
              className="rounded px-2 py-1 text-xs hover:bg-[var(--color-muted)]"
            >
              Hide
            </button>
            <button
              type="button"
              onClick={() => terminals.closeSession(session.id)}
              className="rounded px-2 py-1 text-xs hover:bg-[var(--color-muted)]"
            >
              Close
            </button>
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
  const { sessions, activeId } = useTerminalSessions();
  const active = activeId ? sessions.find((s) => s.id === activeId) : undefined;
  if (!active) return null;
  return <TerminalDrawerView session={active} />;
}
