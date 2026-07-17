import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useHost } from '@/providers/host-provider';
import { couldBeDevMachineAlias, resolveDevMachineTargets } from '@/lib/dev-machine-targets';
import type { Cluster, HostConfig } from '@/lib/host';

interface UseSelectedClusterResult {
  config?: HostConfig;
  /** The RESOLVED selection — an alias of a running local VM reads as
   *  the VM's own `microvm*` cluster, never the alias entry. */
  cluster: Cluster | null;
  hasClusters: boolean;
  isLoading: boolean;
}

// Rebind bookkeeping, module-scoped so the many concurrently mounted
// copies of this hook share one attempt instead of racing selectCluster.
// `rebindFailed` remembers alias ids whose rebind rejected (e.g. the twin
// couldn't be selected) — those fall back to behaving as plain clusters
// for the rest of the session rather than retrying every render.
let rebindInFlight = false;
const rebindFailed = new Set<string>();

/**
 * Common pattern: read the host config and resolve the selected
 * cluster. Pages use this to gate "connect to a cluster first" empty
 * states without each one re-implementing the lookup.
 *
 * Alias REBIND (see lib/dev-machine-targets.ts): a stored selection can
 * be a CLI-profile alias of a running local VM — same machine, second
 * cluster entry. The alias is a broken identity to stay bound to: the
 * desktop's credential sync only maintains keychain secrets for
 * `microvm*` ids, and readiness gating would read the VM as a cloud. So
 * this hook — the one choke point every selection consumer goes through —
 * resolves the alias to its `microvm*` twin and persists that as the
 * stored selection (selectCluster), after which config.apiKey is the
 * twin's key and the top-bar check mark lands on the surviving row.
 *
 * Loading semantics: ONLY a plausible alias (non-microvm id, loopback
 * URL, VM engine present) gains a dependency on the VM inventory; while
 * that inventory hasn't answered, the hook reports loading rather than
 * flashing the alias identity. Every other selection resolves exactly as
 * before, with no new loading gate.
 */
export function useSelectedCluster(): UseSelectedClusterResult {
  const host = useHost();
  const queryClient = useQueryClient();
  const { data: config, isLoading } = useQuery({
    queryKey: ['host', 'config'],
    queryFn: () => host.getConfig(),
  });

  const stored = config?.clusters.find((c) => c.id === config.selectedClusterId) ?? null;
  const aliasCandidate =
    stored !== null && Boolean(host.vm) && !rebindFailed.has(stored.id) && couldBeDevMachineAlias(stored);

  // Same query key as every other VM-inventory consumer (Machine page,
  // switcher, deploy wizard) so the cache is shared; those poll, so this
  // stays fresh without its own interval.
  const vmListQuery = useQuery({
    queryKey: ['microvm', 'list'],
    enabled: aliasCandidate,
    queryFn: () => host.vm!.list(),
  });

  let cluster = stored;
  let resolving = false;
  if (aliasCandidate && config) {
    if (vmListQuery.data) {
      const twinId = resolveDevMachineTargets(config.clusters, vmListQuery.data).aliasToMicroVm.get(stored.id);
      if (twinId) cluster = config.clusters.find((c) => c.id === twinId) ?? stored;
    } else if (!vmListQuery.isError) {
      // Inventory hasn't answered yet — we don't know whether this entry
      // is the Dev Machine or a real standalone server, so don't flash
      // the alias identity; report loading instead. (On inventory ERROR
      // the alias stands as a plain cluster — degraded, not blank.)
      cluster = null;
      resolving = true;
    }
  }

  // Persist the rebind: make the resolved twin the STORED selection too.
  // config.apiKey (the denormalised signing key useApplianceClient binds)
  // always belongs to the stored id, so until this converges the client
  // stays null; afterwards everything — credentials, queries, the
  // switcher's check mark — follows the microvm identity.
  const aliasId = stored?.id ?? null;
  const rebindTarget = aliasCandidate && cluster && cluster.id !== aliasId ? cluster.id : null;
  React.useEffect(() => {
    if (!rebindTarget || !aliasId || rebindInFlight) return;
    rebindInFlight = true;
    host
      .selectCluster(rebindTarget)
      .catch(() => {
        rebindFailed.add(aliasId);
      })
      .finally(() => {
        rebindInFlight = false;
        void queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
      });
  }, [rebindTarget, aliasId, host, queryClient]);

  return {
    config,
    cluster,
    hasClusters: (config?.clusters.length ?? 0) > 0,
    isLoading: isLoading || resolving,
  };
}
