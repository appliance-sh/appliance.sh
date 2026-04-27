import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { createApplianceClient, type ApplianceClient } from '@appliance.sh/sdk/client';
import { useHost } from '@/providers/host-provider';

/**
 * Memoized ApplianceClient bound to the currently selected cluster.
 * Returns null while loading, when no cluster is selected, or when the
 * selected cluster's key is missing — consumers gate queries on its
 * presence via TanStack Query's `enabled` flag.
 */
export function useApplianceClient(): ApplianceClient | null {
  const host = useHost();
  const { data: config } = useQuery({
    queryKey: ['host', 'config'],
    queryFn: () => host.getConfig(),
  });

  const selected = React.useMemo(
    () => config?.clusters.find((c) => c.id === config.selectedClusterId) ?? null,
    [config?.clusters, config?.selectedClusterId]
  );

  return React.useMemo(() => {
    if (!selected || !config?.apiKey) return null;
    return createApplianceClient({
      baseUrl: selected.apiServerUrl,
      credentials: { keyId: config.apiKey.id, secret: config.apiKey.secret },
    });
  }, [selected, config?.apiKey?.id, config?.apiKey?.secret]);
}
