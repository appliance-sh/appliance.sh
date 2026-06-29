import * as React from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useHost } from '@/providers/host-provider';
import type { TerminalSession } from '@/lib/host';

// App-root store for live terminal sessions (E3.2).
//
// The xterm `Terminal`, its `FitAddon`, the DOM node it is bound to, and
// the host `TerminalSession` (the PTY handle) all live *here*, in a
// provider mounted above the router — not in any route component. That is
// what lets a shell survive in-app navigation: route changes swap the
// `<Outlet/>` underneath, but these objects (and the guest process behind
// the PTY) are never unmounted, so nothing calls `session.close()`.
//
// A session is created/focused by `openSession` and only ever torn down by
// the explicit `closeSession` action — closing is now a deliberate user
// action, not a route-unmount side effect.
//
// The provider keeps two parallel views of each session:
//   - the heavy, non-serializable objects (term/fit/container/session) in a
//     ref-held `Map`, so re-renders never recreate them;
//   - a light `TerminalSessionMeta` in React state, so the chrome (title,
//     status pill) re-renders when status changes.

export type TerminalStatus = 'connecting' | 'open' | 'closed' | 'error';

/** Args to open or focus a terminal session. */
export interface OpenTerminalOptions {
  /** kubectl/shell target — a pod name, or the VM name for a host shell. */
  target: string;
  /** 'microvm' routes through the microVM's kubeconfig / vsock shell. */
  engine?: 'microvm';
  /** For the microVM engine, the VM name (routes to its kubeconfig). */
  clusterName?: string;
  /** 'dev'/'host' open a shell into the microVM host itself instead of a
   *  `kubectl exec` into a pod. */
  mode?: 'dev' | 'host';
  /** Header label. Defaults to a label derived from engine/mode. */
  title?: string;
  /** Stable de-dupe key: reopening with the same key focuses the existing
   *  live session instead of spawning a second PTY. Defaults to a
   *  composite of engine/clusterName/mode/target.
   *
   *  NOTE: this is a *host-side* identity for the desktop tab. It is
   *  distinct from the guest tmux session id that E3.4 will thread through
   *  the transport (`vm shell --session <id>`); when that lands it can be
   *  carried alongside this key. */
  sessionKey?: string;
}

/** Light, render-safe projection of a session for the chrome. */
export interface TerminalSessionMeta {
  id: string;
  status: TerminalStatus;
  error: string | null;
  title: string;
  /** The target line shown under the title (pod / VM name). */
  subtitle: string;
  mode?: 'dev' | 'host';
  engine?: 'microvm';
}

// The heavy, route-independent objects. Held in a ref Map, never in React
// state, so renders never recreate xterm instances or reopen PTYs.
interface LiveSession {
  id: string;
  key: string;
  term: Terminal;
  fit: FitAddon;
  /** Detached DOM node xterm is bound to. Reparented into whichever view
   *  is showing it; parked in the off-screen holder otherwise. Owned here
   *  so it (and its rendered scrollback) survives route changes. */
  container: HTMLDivElement;
  /** The live host PTY handle. Null until `host.terminal.open` resolves. */
  session: TerminalSession | null;
  /** Disposes the `term.onData` keystroke binding. */
  disposeInput?: () => void;
  /** Open args retained so close can sweep host/dev debugger pods. */
  target: string;
  engine?: 'microvm';
  clusterName?: string;
  mode?: 'dev' | 'host';
}

interface TerminalSessionsContextValue {
  sessions: TerminalSessionMeta[];
  /** The session whose view is currently shown, or null when hidden. */
  activeId: string | null;
  /** Open a new session, or focus an existing one with the same key.
   *  Returns the session id. */
  openSession(opts: OpenTerminalOptions): string;
  /** Explicitly destroy a session: kill the PTY, dispose xterm, and sweep
   *  any debugger pod a host/dev shell left behind. The only path that
   *  closes a PTY. */
  closeSession(id: string): void;
  /** Show a session's view (set it active). */
  focusSession(id: string): void;
  /** Hide the active view without closing the session — the PTY stays
   *  live, the scrollback is retained. */
  hide(): void;
  /** Mount a session's xterm node into `host` and keep its size in step.
   *  Returns a cleanup that parks the node back in the holder (it does NOT
   *  close the session). Used by the view; not for general callers. */
  attachView(id: string, host: HTMLElement): () => void;
}

const TerminalSessionsContext = React.createContext<TerminalSessionsContextValue | null>(null);

function deriveTitle(opts: OpenTerminalOptions): string {
  if (opts.title) return opts.title;
  const base = opts.engine === 'microvm' ? 'Terminal · microVM' : 'Terminal';
  if (opts.mode === 'dev') return `${base} · dev workspace`;
  if (opts.mode === 'host') return `${base} · host`;
  return base;
}

let nextSessionSeq = 0;

export function TerminalSessionsProvider({ children }: { children: React.ReactNode }) {
  const host = useHost();
  const liveRef = React.useRef<Map<string, LiveSession>>(new Map());
  const holderRef = React.useRef<HTMLDivElement | null>(null);
  const [sessions, setSessions] = React.useState<TerminalSessionMeta[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);

  const patchMeta = React.useCallback((id: string, patch: Partial<TerminalSessionMeta>) => {
    setSessions((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }, []);

  // Park a session's container in the off-screen holder (keeps it in the
  // DOM so xterm stays measurable, but invisible). Never removes it.
  const park = React.useCallback((live: LiveSession) => {
    // A closed session has already been pulled from the registry and its
    // container detached + disposed; re-parking it would re-append an
    // orphaned node into the holder, leaking one <div> per Close. The
    // attach cleanup still fires on that unmount, so no-op once it's gone.
    if (!liveRef.current.has(live.id)) return;
    const holder = holderRef.current;
    if (holder && live.container.parentNode !== holder) {
      holder.appendChild(live.container);
    }
  }, []);

  const focusSession = React.useCallback((id: string) => {
    if (liveRef.current.has(id)) setActiveId(id);
  }, []);

  const hide = React.useCallback(() => setActiveId(null), []);

  const openSession = React.useCallback(
    (opts: OpenTerminalOptions): string => {
      const key =
        opts.sessionKey ?? [opts.engine ?? '', opts.clusterName ?? '', opts.mode ?? '', opts.target].join('|');

      // De-dupe: reopening focuses the existing live session.
      for (const [id, live] of liveRef.current) {
        if (live.key === key) {
          setActiveId(id);
          return id;
        }
      }

      const id = `term-${++nextSessionSeq}`;
      const subtitle = opts.target;
      const meta: TerminalSessionMeta = {
        id,
        status: 'connecting',
        error: null,
        title: deriveTitle(opts),
        subtitle,
        mode: opts.mode,
        engine: opts.engine,
      };
      setSessions((prev) => [...prev, meta]);
      setActiveId(id);

      if (!host.terminal) {
        // Web shell has no PTY transport — surface the same error the old
        // route drawer did, but keep the (inert) session registered so the
        // view can render the message.
        patchMeta(id, { status: 'error', error: 'Interactive terminals are only available in the desktop app.' });
        return id;
      }

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
        theme: { background: '#0a0a0a' },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      const container = document.createElement('div');
      container.style.height = '100%';
      container.style.width = '100%';
      // Open while parked in the holder so xterm has a laid-out element to
      // bind to; the view fits it to real dimensions on attach.
      if (holderRef.current) holderRef.current.appendChild(container);
      term.open(container);

      const live: LiveSession = {
        id,
        key,
        term,
        fit,
        container,
        session: null,
        target: opts.target,
        engine: opts.engine,
        clusterName: opts.clusterName,
        mode: opts.mode,
      };
      liveRef.current.set(id, live);

      host.terminal
        .open(
          {
            target: opts.target,
            engine: opts.engine,
            clusterName: opts.clusterName,
            mode: opts.mode,
            cols: term.cols,
            rows: term.rows,
          },
          (event) => {
            if (event.type === 'data') {
              term.write(event.data);
            } else if (event.type === 'exit') {
              const code = event.code ?? 0;
              term.write(`\r\n\x1b[90m[process exited${code ? ` (${code})` : ''}]\x1b[0m\r\n`);
              patchMeta(id, { status: 'closed' });
            }
          }
        )
        .then((s) => {
          // The session may have been closed before open resolved.
          if (!liveRef.current.has(id)) {
            void s.close();
            return;
          }
          live.session = s;
          const sub = term.onData((d) => void live.session?.write(d));
          live.disposeInput = () => sub.dispose();
          patchMeta(id, { status: 'open' });
          term.focus();
        })
        .catch((e) => {
          patchMeta(id, { status: 'error', error: e instanceof Error ? e.message : String(e) });
        });

      return id;
    },
    [host, patchMeta]
  );

  const closeSession = React.useCallback(
    (id: string) => {
      const live = liveRef.current.get(id);
      if (!live) {
        // An inert web session (no PTY transport) has meta but never got a
        // live handle, so the teardown below doesn't apply — still drop its
        // meta so a closed/error session can't linger in the list.
        setSessions((prev) => prev.filter((m) => m.id !== id));
        setActiveId((cur) => (cur === id ? null : cur));
        return;
      }
      liveRef.current.delete(id);
      live.disposeInput?.();
      void live.session?.close();
      live.term.dispose();
      live.container.remove();
      // A host/dev shell rides `kubectl debug node/`, which leaves a
      // debugger pod behind — sweep it when the session is destroyed.
      if (live.mode && live.engine === 'microvm') {
        void host.vm
          ?.instance(live.clusterName)
          .cleanupShell()
          .catch(() => {});
      }
      setSessions((prev) => prev.filter((m) => m.id !== id));
      setActiveId((cur) => (cur === id ? null : cur));
    },
    [host]
  );

  const attachView = React.useCallback(
    (id: string, hostEl: HTMLElement) => {
      const live = liveRef.current.get(id);
      if (!live) return () => {};
      hostEl.appendChild(live.container);
      const refit = () => {
        try {
          live.fit.fit();
        } catch {
          // container not laid out yet
        }
        void live.session?.resize(live.term.cols, live.term.rows);
      };
      // Fit after the browser has laid the container out, then redraw so a
      // reparented xterm repaints its retained buffer.
      const raf = requestAnimationFrame(() => {
        refit();
        live.term.refresh(0, live.term.rows - 1);
        live.term.focus();
      });
      const ro = new ResizeObserver(refit);
      ro.observe(hostEl);
      return () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        park(live);
      };
    },
    [park]
  );

  const value = React.useMemo<TerminalSessionsContextValue>(
    () => ({ sessions, activeId, openSession, closeSession, focusSession, hide, attachView }),
    [sessions, activeId, openSession, closeSession, focusSession, hide, attachView]
  );

  return (
    <TerminalSessionsContext.Provider value={value}>
      {children}
      {/* Off-screen holder: parks live terminal nodes (and their scrollback)
          while no view is showing them, keeping them mounted across nav. */}
      <div
        ref={holderRef}
        aria-hidden
        style={{ position: 'fixed', left: '-99999px', top: 0, width: '800px', height: '600px', overflow: 'hidden' }}
      />
    </TerminalSessionsContext.Provider>
  );
}

export function useTerminalSessions(): TerminalSessionsContextValue {
  const ctx = React.useContext(TerminalSessionsContext);
  if (!ctx) {
    throw new Error('useTerminalSessions called outside TerminalSessionsProvider');
  }
  return ctx;
}
