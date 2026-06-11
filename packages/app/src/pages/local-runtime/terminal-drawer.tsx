import * as React from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useHost } from '@/providers/host-provider';
import type { TerminalSession } from '@/lib/host';

// Interactive shell into a workload pod, backed by the desktop's PTY
// (`kubectl exec -it` in a real pseudo-terminal). Output streams from
// the host over a channel into xterm; keystrokes + resizes go back
// through the TerminalSession. Engine-aware: routes through the k3d
// context or the microVM kubeconfig.
export function TerminalDrawer({
  target,
  engine,
  onClose,
}: {
  target: string;
  engine?: 'microvm';
  onClose: () => void;
}) {
  const host = useHost();
  const mountRef = React.useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = React.useState<'connecting' | 'open' | 'closed' | 'error'>('connecting');
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!host.terminal) {
      setStatus('error');
      setError('Interactive terminals are only available in the desktop app.');
      return;
    }
    const container = mountRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
      theme: { background: '#0a0a0a' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    let session: TerminalSession | null = null;
    let disposed = false;

    host.terminal
      .open({ target, engine, cols: term.cols, rows: term.rows }, (event) => {
        if (event.type === 'data') {
          term.write(event.data);
        } else if (event.type === 'exit') {
          setStatus('closed');
          const code = event.code ?? 0;
          term.write(`\r\n\x1b[90m[process exited${code ? ` (${code})` : ''}]\x1b[0m\r\n`);
        }
      })
      .then((s) => {
        if (disposed) {
          void s.close();
          return;
        }
        session = s;
        setStatus('open');
        term.focus();
        // Pipe keystrokes to the PTY.
        term.onData((d) => void session?.write(d));
      })
      .catch((e) => {
        setStatus('error');
        setError(e instanceof Error ? e.message : String(e));
      });

    // Keep the PTY's window size in step with the rendered terminal.
    const pushResize = () => {
      try {
        fit.fit();
      } catch {
        // container not laid out yet
      }
      void session?.resize(term.cols, term.rows);
    };
    const ro = new ResizeObserver(pushResize);
    ro.observe(container);

    return () => {
      disposed = true;
      ro.disconnect();
      void session?.close();
      term.dispose();
    };
  }, [host, target, engine]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-4 md:items-center"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex h-[70vh] w-full max-w-4xl flex-col overflow-hidden rounded-md border border-[var(--color-border)] bg-[#0a0a0a]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Terminal: ${target}`}
      >
        <header className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-background)] px-4 py-2">
          <div>
            <div className="text-sm font-semibold">Terminal{engine === 'microvm' ? ' · microVM' : ''}</div>
            <div className="font-mono text-xs text-[var(--color-muted-foreground)]">{target}</div>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={
                status === 'open'
                  ? 'text-xs text-green-300'
                  : status === 'connecting'
                    ? 'text-xs text-cyan-300'
                    : 'text-xs text-[var(--color-muted-foreground)]'
              }
            >
              {status === 'connecting' ? 'connecting…' : status}
            </span>
            <button type="button" onClick={onClose} className="rounded px-2 py-1 text-xs hover:bg-[var(--color-muted)]">
              Close
            </button>
          </div>
        </header>

        {error ? (
          <div className="border-b border-red-500/40 bg-red-500/10 px-4 py-2 font-mono text-xs text-red-300">
            {error}
          </div>
        ) : null}

        <div ref={mountRef} className="min-h-0 flex-1 overflow-hidden p-2" />
      </div>
    </div>
  );
}
