import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Shared shell-out helper for the local-runtime modules (runtime.ts,
// cluster.ts, api-server.ts). Mirrors the desktop's
// `run_status_command`: never throws on a non-zero exit — callers get
// the exit status plus both streams and decide what's fatal. Only a
// failed *spawn* (tool not on PATH) raises, with an actionable
// message instead of a bare ENOENT.

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export async function runCommand(argv: string[], opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
  const [cmd, ...args] = argv;
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout: opts.timeoutMs,
      // A wedged tool dumping logs must not OOM the caller; 16 MiB is
      // far beyond any output we parse (k3d list JSON, kubectl apply).
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
    if (e.code === 'ENOENT') {
      throw new Error(`\`${cmd}\` is not installed or not on PATH.`);
    }
    if (e.killed && opts.timeoutMs) {
      throw new Error(`\`${argv.join(' ')}\` timed out after ${Math.round(opts.timeoutMs / 1000)}s.`);
    }
    return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? (e instanceof Error ? e.message : String(e)) };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
