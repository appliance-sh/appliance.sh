import * as React from 'react';

// Persistent recent-folders list for the local-runtime deploy wizard.
// Stored in localStorage so it survives reloads and app restarts —
// the desktop shell can't currently round-trip this through the host,
// and per-shell storage is the simplest place. Capped at 5 entries.

const STORAGE_KEY = 'appliance.recent-deploy-folders';
const MAX_ENTRIES = 5;

export interface RecentFolder {
  path: string;
  /** Project name from the folder's manifest at the time it was used. */
  projectName?: string;
  /** ISO timestamp of the last successful deploy from this folder. */
  lastUsedAt: string;
}

function readStorage(): RecentFolder[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is RecentFolder =>
        entry && typeof entry === 'object' && typeof entry.path === 'string' && typeof entry.lastUsedAt === 'string'
    );
  } catch {
    return [];
  }
}

function writeStorage(entries: RecentFolder[]): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Quota or private-mode failures — silent. Recent folders are a
    // best-effort affordance, not load-bearing state.
  }
}

export function useRecentFolders(): {
  recent: RecentFolder[];
  record(entry: { path: string; projectName?: string }): void;
  forget(path: string): void;
} {
  const [recent, setRecent] = React.useState<RecentFolder[]>(() => readStorage());

  const record = React.useCallback((entry: { path: string; projectName?: string }) => {
    setRecent((prev) => {
      const filtered = prev.filter((p) => p.path !== entry.path);
      const next: RecentFolder[] = [
        { path: entry.path, projectName: entry.projectName, lastUsedAt: new Date().toISOString() },
        ...filtered,
      ].slice(0, MAX_ENTRIES);
      writeStorage(next);
      return next;
    });
  }, []);

  const forget = React.useCallback((path: string) => {
    setRecent((prev) => {
      const next = prev.filter((p) => p.path !== path);
      writeStorage(next);
      return next;
    });
  }, []);

  return { recent, record, forget };
}
