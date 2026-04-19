import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { createApplianceClient, type ApplianceClient } from '@appliance.sh/sdk/client';
import { useHost } from '@/providers/host-provider';

/**
 * Memoized ApplianceClient bound to the current host config. Returns
 * null while loading or when no cluster is configured — consumers
 * gate queries on its presence via TanStack Query's `enabled` flag.
 */
export function useApplianceClient(): ApplianceClient | null {
  const host = useHost();
  const { data: config } = useQuery({
    queryKey: ['host', 'config'],
    queryFn: () => host.getConfig(),
  });

  return React.useMemo(() => {
    if (!config?.apiServerUrl || !config.apiKey) return null;
    return createApplianceClient({
      baseUrl: config.apiServerUrl,
      credentials: { keyId: config.apiKey.id, secret: config.apiKey.secret },
    });
  }, [config?.apiServerUrl, config?.apiKey?.id, config?.apiKey?.secret]);
}
