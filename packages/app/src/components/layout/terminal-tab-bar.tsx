import * as React from 'react';
import { Plus, X } from 'lucide-react';
import {
  useTerminalSessions,
  statusLabel,
  statusDotClass,
  type TerminalSessionMeta,
} from '@/providers/terminal-sessions-provider';
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

// Compact projection of E3.2's `StatusPill`: same colour semantics
// (shared `statusDotClass`) shrunk to a single dot so it fits a tab. The
// status word is also folded into the tab button's accessible name (it is
// not colour-only) — this dot is decorative for assistive tech.
function StatusDot({ status }: { status: TerminalSessionMeta['status'] }) {
  return <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', statusDotClass(status))} />;
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
  // Set while cancelling so the blur that fires when the still-focused input
  // unmounts (`editing=false`) does NOT run the commit — otherwise Escape
  // would commit the discarded draft instead of dropping it.
  const skipBlurRef = React.useRef(false);
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
    // Clear the cancel latch up front: it's a plain ref (not reset on
    // re-render), so a prior Escape-cancel could leave it set and make the
    // next edit's first blur silently drop instead of commit.
    skipBlurRef.current = false;
    setDraft(session.title);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    onRename(draft);
  };
  const cancel = () => {
    skipBlurRef.current = true;
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
          onBlur={() => {
            // Cancel (Escape) unmounts this still-focused input, which fires
            // a blur on the removed node; that blur must NOT commit the draft
            // the user just discarded — swallow it once and reset the latch.
            if (skipBlurRef.current) {
              skipBlurRef.current = false;
              return;
            }
            commit();
          }}
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
          onKeyDown={(e) => {
            // Keyboard rename path: F2 starts editing the focused tab, so
            // rename isn't double-click-only (and double-click stays as the
            // discoverable mouse route, hinted by the button title).
            if (e.key === 'F2') {
              e.preventDefault();
              startEdit();
            }
          }}
          className="min-w-0 flex-1 truncate text-left"
          aria-pressed={active}
          // Fold the status word into the accessible name so a screen-reader
          // / keyboard user can tell a live tab from a dead one — the dot is
          // colour-only and aria-hidden.
          aria-label={`${session.title} (${statusLabel(session.status)})`}
          aria-keyshortcuts="F2"
          title="Double-click or press F2 to rename"
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
  // recent one) — the dock has no VM context of its own to target. The dock
  // only mounts with ≥1 session, so a fork source always exists; no disabled
  // guard is needed.
  const handleNew = React.useCallback(() => {
    const source = sessions.find((s) => s.id === activeId) ?? sessions[sessions.length - 1];
    if (source) duplicateSession(source.id);
  }, [duplicateSession, sessions, activeId]);

  return (
    <div className="flex items-center gap-2">
      {/* "Shells" label and "+" sit OUTSIDE the scroll strip so they stay
          pinned when the tabs overflow horizontally. */}
      <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
        Shells
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
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
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-muted-foreground)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]"
        title="Open another shell on the same target"
        aria-label="Open another shell"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
