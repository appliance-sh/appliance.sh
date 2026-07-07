import * as React from 'react';

// Global auth-expiry signal: a tiny module-level store the query cache's
// error handler feeds when any query fails with an auth-shaped error
// (401/403, invalid signature, expired key). The AppShell observes it and
// shows a dismissible "connection expired" banner with a Reconnect CTA —
// so a stale key surfaces once, at the top, instead of as scattered raw
// 401s on every panel.

let expired = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** Flag that the server rejected the stored credential. Idempotent. */
export function reportAuthFailure(): void {
  if (expired) return;
  expired = true;
  emit();
}

/** Clear the flag (banner dismissed, or the user reconnected). */
export function clearAuthFailure(): void {
  if (!expired) return;
  expired = false;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): boolean {
  return expired;
}

/** Whether an auth failure has been reported since the last clear. */
export function useAuthExpired(): boolean {
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
