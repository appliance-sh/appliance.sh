import * as React from 'react';
import { useQuery, useQueries } from '@tanstack/react-query';
import type { Environment, Project } from '@appliance.sh/sdk/models';
import { useApplianceClient } from './use-appliance-client';

/**
 * Id → Project map backed by the shared `['projects']` query. Safe to
 * call from multiple pages; TanStack Query dedupes the fetch.
 */
export function useProjectsMap(): Map<string, Project> {
  const client = useApplianceClient();
  const { data } = useQuery({
    queryKey: ['projects'],
    enabled: !!client,
    queryFn: async () => {
      const r = await client!.listProjects();
      if (!r.success) throw r.error;
      return r.data;
    },
  });
  return React.useMemo(() => new Map((data ?? []).map((p) => [p.id, p])), [data]);
}

/**
 * Id → Environment map. Fans out `listEnvironments(projectId)` across
 * every project, reusing the per-project `['environments', projectId]`
 * queries already fired from other pages. One extra cold fetch per
 * project on first load; cached thereafter.
 */
export function useEnvironmentsMap(): Map<string, Environment> {
  const client = useApplianceClient();

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    enabled: !!client,
    queryFn: async () => {
      const r = await client!.listProjects();
      if (!r.success) throw r.error;
      return r.data;
    },
  });

  const envQueries = useQueries({
    queries: (projectsQuery.data ?? []).map((p) => ({
      queryKey: ['environments', p.id],
      enabled: !!client,
      queryFn: async () => {
        const r = await client!.listEnvironments(p.id);
        if (!r.success) throw r.error;
        return r.data;
      },
    })),
  });

  return React.useMemo(() => {
    const m = new Map<string, Environment>();
    envQueries.forEach((q) => (q.data ?? []).forEach((e) => m.set(e.id, e)));
    return m;
  }, [envQueries]);
}
