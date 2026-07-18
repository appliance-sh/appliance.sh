import * as React from 'react';
import { createApplianceClient, type ApplianceClient } from '@appliance.sh/sdk/client';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';

/**
 * Memoized ApplianceClient bound to the currently selected cluster — the
 * RESOLVED selection from useSelectedCluster, so an alias of a running
 * local VM binds as the VM's own `microvm*` cluster, never the alias.
 * Returns null while loading, when no cluster is selected, when the
 * selected cluster's key is missing, or while an alias rebind is still
 * converging — `config.apiKey` is denormalised for the STORED selection,
 * so binding it before the stored id matches the resolved id would sign
 * requests with the wrong (possibly absent) key. Consumers gate queries
 * on its presence via TanStack Query's `enabled` flag.
 */
export function useApplianceClient(): ApplianceClient | null {
  const { config, cluster } = useSelectedCluster();
  const storedId = config?.selectedClusterId ?? null;
  const keyId = config?.apiKey?.id ?? null;
  const secret = config?.apiKey?.secret ?? null;

  return React.useMemo(() => {
    if (!cluster || !keyId || !secret) return null;
    if (cluster.id !== storedId) return null; // rebind not yet persisted
    return createApplianceClient({
      baseUrl: cluster.apiServerUrl,
      credentials: { keyId, secret },
    });
  }, [cluster, storedId, keyId, secret]);
}
