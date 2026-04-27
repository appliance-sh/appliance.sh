import { useQuery } from '@tanstack/react-query';
import { useHost } from '@/providers/host-provider';
import type { Cluster, HostConfig } from '@/lib/host';

interface UseSelectedClusterResult {
  config?: HostConfig;
  cluster: Cluster | null;
  hasClusters: boolean;
  isLoading: boolean;
}

/**
 * Common pattern: read the host config and resolve the selected
 * cluster. Pages use this to gate "connect to a cluster first" empty
 * states without each one re-implementing the lookup.
 */
export function useSelectedCluster(): UseSelectedClusterResult {
  const host = useHost();
  const { data: config, isLoading } = useQuery({
    queryKey: ['host', 'config'],
    queryFn: () => host.getConfig(),
  });

  const cluster = config?.clusters.find((c) => c.id === config.selectedClusterId) ?? null;
  return {
    config,
    cluster,
    hasClusters: (config?.clusters.length ?? 0) > 0,
    isLoading,
  };
}
