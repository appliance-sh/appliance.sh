import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { EnvironmentHealth } from '@appliance.sh/sdk/models';
import { useApplianceClient } from '@/hooks/use-appliance-client';

/**
 * Live workload health for a single environment (readiness + restart
 * state, and CPU/mem when the cluster's metrics-server is present).
 *
 * `enabled` lets callers gate the fetch on whether the environment is
 * even deployed — there's no point polling health for a brand-new env
 * that has never deployed. The server already degrades gracefully
 * (returns `status: unknown` instead of erroring) on non-Kubernetes
 * bases / unreachable clusters, and a 404 from an older api-server is
 * surfaced as a query error the caller can ignore.
 */
export function useEnvironmentHealth(
  projectId: string | undefined,
  environmentId: string | undefined,
  enabled = true
): UseQueryResult<EnvironmentHealth> {
  const client = useApplianceClient();
  return useQuery({
    queryKey: ['environment-health', projectId, environmentId],
    enabled: !!client && !!projectId && !!environmentId && enabled,
    queryFn: async () => {
      const r = await client!.getEnvironmentHealth(projectId!, environmentId!);
      if (!r.success) throw r.error;
      return r.data;
    },
    // Health is cheap to read and changes on its own (restarts, OOM
    // kills, rollouts) without a deploy, so poll on a short cadence.
    refetchInterval: 10_000,
    // A missing route on an older api-server shouldn't spam retries.
    retry: false,
  });
}
