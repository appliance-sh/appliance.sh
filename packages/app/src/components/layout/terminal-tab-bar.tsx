import * as React from 'react';
import { Plus, X } from 'lucide-react';
import { useTerminalSessions, type TerminalSessionMeta } from '@/providers/terminal-sessions-provider';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';

// Terminal tab strip (E3.3) — one tab per live session in the
// `TerminalSessionsProvider`. Because the strip is rendered in
// `app-shell.tsx` (outside the route `<Outlet/>`), it is reachable from
// EVERY route: a shell that is running-but-hidden (the modal dismissed,
// `activeId` null) always has a tab here, so navigating away can never
// orphan it — the user sees it and clicks back. Self-exited sessions are
// not auto-reaped; they are clearly flagged (dimmed, "Ended"/"Error" dot)
// and carry a close affordance so the user removes them deliberately.

function statusLabel(status: TerminalSessionMeta['status']): string {
  return status === 'open' ? 'Live' : status === 'connecting' ? 'Connecting…' : status === 'error' ? 'Error' : 'Ended';
}

// Compact projection of E3.2's `StatusPill`: same colour semantics
// (green pulse = Live, red = Error, muted = Connecting/Ended) shrunk to a
// single dot so it fits a tab. The full label rides the tab's `title`.
function StatusDot({ status }: { status: TerminalSessionMeta['status'] }) {
  return (
    <span
      aria-hidden
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        status === 'open'
          ? 'animate-pulse bg-green-400'
          : status === 'error'
            ? 'bg-red-400'
            : status === 'connecting'
              ? 'animate-pulse bg-[var(--color-muted-foreground)]'
              : 'bg-[var(--color-muted-foreground)]'
      )}
    />
  );
}

function TerminalTab({
  session,
  active,
  onSelect,
  onClose,
  onRename,
}: {
  session: TerminalSessionMeta;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename: (title: string) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(session.title);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  // A self-exited / failed shell is dead weight — dim it so the live tabs
  // read first, but keep it present (and closable) per Devon's nit.
  const dead = session.status === 'closed' || session.status === 'error';

  React.useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEdit = () => {
    setDraft(session.title);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    onRename(draft);
  };
  const cancel = () => {
    setEditing(false);
    setDraft(session.title);
  };

  return (
    <div
      className={cn(
        'group flex h-7 max-w-[220px] items-center gap-2 rounded-md border px-2.5 text-xs',
        active
          ? 'border-[var(--color-border-strong)] bg-[var(--color-accent)] text-[var(--color-foreground)]'
          : 'border-[var(--color-border)] bg-transparent text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)]',
        dead && 'opacity-60'
      )}
      title={`${session.title} — ${session.subtitle} (${statusLabel(session.status)})`}
    >
      <StatusDot status={session.status} />
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            // Keep keystrokes out of any underlying terminal.
            e.stopPropagation();
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') cancel();
          }}
          className="w-28 bg-transparent text-xs text-[var(--color-foreground)] outline-none"
          aria-label="Rename terminal tab"
        />
      ) : (
        <button
          type="button"
          onClick={onSelect}
          onDoubleClick={startEdit}
          className="min-w-0 flex-1 truncate text-left"
          aria-pressed={active}
        >
          {session.title}
        </button>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="shrink-0 rounded p-0.5 text-[var(--color-muted-foreground)] opacity-60 hover:bg-[var(--color-destructive)]/20 hover:text-red-400 group-hover:opacity-100"
        aria-label={dead ? `Remove ${session.title}` : `End ${session.title}`}
        title={dead ? 'Remove ended tab' : 'End shell'}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

export function TerminalTabBar() {
  const { sessions, activeId, focusSession, closeSession, renameSession, duplicateSession } = useTerminalSessions();
  const confirm = useConfirm();

  // Close: a live shell is a destructive End (confirm first, mirroring the
  // drawer's "End shell"); a self-exited / errored tab is removed silently.
  const handleClose = React.useCallback(
    async (session: TerminalSessionMeta) => {
      if (session.status === 'open' || session.status === 'connecting') {
        const ok = await confirm({
          title: 'End this shell?',
          description: 'The running process will be terminated.',
          confirmLabel: 'End shell',
        });
        if (!ok) return;
      }
      closeSession(session.id);
    },
    [confirm, closeSession]
  );

  // The "+" forks a new concurrent shell from the active tab (or the most
  // recent one) — the dock has no VM context of its own to target.
  const forkSource = sessions.find((s) => s.id === activeId) ?? sessions[sessions.length - 1];
  const handleNew = React.useCallback(() => {
    if (forkSource) duplicateSession(forkSource.id);
  }, [duplicateSession, forkSource]);

  return (
    <div className="flex items-center gap-2 overflow-x-auto">
      <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
        Shells
      </span>
      <div className="flex items-center gap-1.5">
        {sessions.map((session) => (
          <TerminalTab
            key={session.id}
            session={session}
            active={session.id === activeId}
            onSelect={() => focusSession(session.id)}
            onClose={() => void handleClose(session)}
            onRename={(title) => renameSession(session.id, title)}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={handleNew}
        disabled={!forkSource}
        className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-muted-foreground)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)] disabled:pointer-events-none disabled:opacity-40"
        title="Open another shell on the same target"
        aria-label="Open another shell"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
