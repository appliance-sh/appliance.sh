import type { QueryClient } from '@tanstack/react-query';
import type { AuthFailureCause } from '@appliance.sh/sdk';
import { clearAuthFailure, reportAuthFailure } from '@/lib/auth-signal';
import { isMicroVmClusterId, microVmNameFromClusterId, type ConsoleHost } from '@/lib/host';

// Self-heal for microVM credentials. A microVM's api-server keeps its
// key store on the VM's data disk, so recreating the VM invalidates
// every credential the desktop holds — historically a permanent,
// opaque 401. When the query cache sees an auth-shaped error and the
// selected cluster is a local microVM, we ask the host to re-mint via
// the VM's on-disk bootstrap token instead of (or before) showing the
// "connection expired" banner. The host side enforces its own
// single-flight + cooldown; this module's guards just keep the render
// path from stampeding the bridge.

/** Set by the Console root; the query cache's error handler runs
 *  outside React so it can't use hooks to reach the host. */
let healHost: ConsoleHost | null = null;
let healQueryClient: QueryClient | null = null;

export function registerAuthHeal(host: ConsoleHost, queryClient: QueryClient): void {
  healHost = host;
  healQueryClient = queryClient;
}

let inflight: Promise<boolean> | null = null;
let lastSettledAt = 0;
let lastHealedAt = 0;
/** Client-side spacing between heal attempts; the host has its own
 *  (longer) mint cooldown — this only stops a burst of failing
 *  queries from queueing bridge calls back-to-back. */
const RETRY_SPACING_MS = 15_000;
/** Right after a successful heal, stragglers signed with the old key
 *  can still land as errors — swallow them while the refetch wave
 *  settles instead of raising the banner we just avoided. */
const POST_HEAL_GRACE_MS = 10_000;

/**
 * Entry point for the query cache's error handler: try to self-heal,
 * and only raise the auth-expired banner when healing isn't possible
 * or didn't work. Fire-and-forget — errors degrade to the banner.
 *
 * `cause` is the server's machine-readable 401 classification when it
 * sent one; the host bridge uses it to pick the recovery (re-mint vs
 * clock sync vs nothing). A recurring failure (clock sync didn't take)
 * lands inside the retry spacing and raises the banner.
 */
export function handleAuthShapedError(cause?: AuthFailureCause): void {
  if (inflight) return; // a heal is deciding the outcome already
  if (Date.now() - lastHealedAt < POST_HEAL_GRACE_MS) return;
  if (Date.now() - lastSettledAt < RETRY_SPACING_MS) {
    reportAuthFailure();
    return;
  }
  inflight = attemptHeal(cause)
    .catch(() => false)
    .then((healed) => {
      inflight = null;
      lastSettledAt = Date.now();
      if (healed) lastHealedAt = lastSettledAt;
      else reportAuthFailure();
      return healed;
    });
}

async function attemptHeal(cause?: AuthFailureCause): Promise<boolean> {
  const host = healHost;
  const queryClient = healQueryClient;
  if (!host || !queryClient) return false;

  const config = await host.getConfig();
  const selected = config.clusters.find((c) => c.id === config.selectedClusterId);
  if (!selected || !isMicroVmClusterId(selected.id)) return false;
  const vmName = microVmNameFromClusterId(selected.id);
  if (!vmName) return false;

  const instance = host.vm?.instance(vmName);
  if (!instance?.healCredentials) return false;

  const healed = await instance.healCredentials(config.apiKey?.id, cause);
  if (!healed) return false;

  // Fresh credentials are on disk: rebuild the client (the config
  // query carries the key) and refetch everything that failed.
  clearAuthFailure();
  await queryClient.invalidateQueries();
  return true;
}
