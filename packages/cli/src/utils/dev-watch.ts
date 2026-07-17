import * as fs from 'node:fs';

// File watching + rebuild scheduling for `appliance dev`. Pure logic
// (ignore rules, debounce/coalesce queue) is exported for unit tests;
// the thin fs.watch wrapper is the only OS-touching piece.

/** Directory names whose contents never warrant a rebuild: dependency
 *  trees, VCS metadata, build output (which the build itself writes —
 *  watching it would loop), and appliance state. */
export const DEV_IGNORE_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  'target',
  '.appliance',
  '__pycache__',
  '.venv',
];

/** Trailing file patterns that are editor/OS noise, not source. */
const IGNORE_FILES = [/~$/, /\.swp$/, /\.swx$/, /^\.#/, /\.DS_Store$/, /^appliance\.zip$/];

/** Whether a watch event path (relative to the member dir) should be
 *  ignored. Pure — exported for tests. */
export function shouldIgnorePath(relPath: string): boolean {
  const segments = relPath.split(/[\\/]/).filter(Boolean);
  if (segments.some((s) => DEV_IGNORE_DIRS.includes(s))) return true;
  const base = segments.length > 0 ? segments[segments.length - 1] : relPath;
  return IGNORE_FILES.some((re) => re.test(base));
}

/**
 * Watch a member directory recursively, invoking `onChange` for every
 * non-ignored change. Recursive fs.watch is native on win32/darwin and
 * supported on Linux since Node 20 — no chokidar, which keeps the bun
 * single-binary dependency-free. Caveat: events on network/WSL-mounted
 * paths can be dropped by the OS; the escape hatch is re-saving.
 */
export function watchMember(dir: string, onChange: () => void): { close(): void } {
  const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
    // A null filename (some platforms under load) is still a change —
    // better a redundant no-op rebuild than a missed one.
    if (filename === null || !shouldIgnorePath(String(filename))) onChange();
  });
  // A watcher error (e.g. the dir vanishing) must not crash the dev
  // session — logs + other members keep going.
  watcher.on('error', () => {});
  return { close: () => watcher.close() };
}

/**
 * Debounced, serialized rebuild scheduler. `notify(member)` marks a
 * member dirty; after `debounceMs` of quiet it is queued. One build
 * runs at a time (builds share the buildkit connection and print to
 * one terminal); a member dirtied *while its own build runs* is queued
 * exactly once more, so a save-during-build is never lost and never
 * duplicated. `run` owns its error handling — a rejected build never
 * stops the queue.
 */
export function createRebuildQueue(
  run: (member: string) => Promise<void>,
  debounceMs = 300
): { notify(member: string): void; close(): void } {
  const timers = new Map<string, NodeJS.Timeout>();
  const queue: string[] = [];
  const queued = new Set<string>();
  const redirty = new Set<string>();
  let running: string | null = null;
  let closed = false;

  const enqueue = (member: string): void => {
    if (closed) return;
    if (running === member) {
      redirty.add(member);
      return;
    }
    if (!queued.has(member)) {
      queued.add(member);
      queue.push(member);
    }
    void pump();
  };

  const pump = async (): Promise<void> => {
    if (running !== null || closed) return;
    const next = queue.shift();
    if (next === undefined) return;
    queued.delete(next);
    running = next;
    try {
      await run(next);
    } catch {
      // run() reports its own failures; the queue only sequences.
    } finally {
      running = null;
      if (redirty.delete(next)) enqueue(next);
      void pump();
    }
  };

  return {
    notify(member: string): void {
      if (closed) return;
      const prior = timers.get(member);
      if (prior) clearTimeout(prior);
      timers.set(
        member,
        setTimeout(() => {
          timers.delete(member);
          enqueue(member);
        }, debounceMs)
      );
    },
    close(): void {
      closed = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
