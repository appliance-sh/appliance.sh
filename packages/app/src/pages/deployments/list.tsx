import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { StatusDot } from '@/components/ui/status-dot';
import { useHost } from '@/providers/host-provider';
import { useApplianceClient } from '@/hooks/use-appliance-client';
import { relativeTime } from '@/lib/time';

export function DeploymentsPage() {
  const host = useHost();
  const client = useApplianceClient();

  const { data: config } = useQuery({
    queryKey: ['host', 'config'],
    queryFn: () => host.getConfig(),
  });

  const deploymentsQuery = useQuery({
    queryKey: ['deployments', 'all'],
    enabled: !!client,
    queryFn: async () => {
      const r = await client!.listDeployments({ limit: 100 });
      if (!r.success) throw r.error;
      return r.data;
    },
    refetchInterval: 5_000,
  });

  if (!config?.apiServerUrl) {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="text-xl font-semibold">Deployments</h1>
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            In-flight and recent deployment runs across all environments.
          </p>
        </div>
        <div className="rounded-md border border-dashed border-[var(--color-border)] p-8 text-center text-sm text-[var(--color-muted-foreground)]">
          Connect to a cluster to see deployments.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Deployments</h1>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          In-flight and recent deployment runs across all environments.
        </p>
      </div>

      {deploymentsQuery.error ? (
        <div className="rounded-md border border-red-500/50 bg-red-500/5 p-3 text-xs text-red-400">
          {deploymentsQuery.error instanceof Error ? deploymentsQuery.error.message : String(deploymentsQuery.error)}
        </div>
      ) : null}

      {deploymentsQuery.isLoading && !deploymentsQuery.data ? (
        <div className="text-sm text-[var(--color-muted-foreground)]">Loading…</div>
      ) : !deploymentsQuery.data || deploymentsQuery.data.length === 0 ? (
        <div className="rounded-md border border-dashed border-[var(--color-border)] p-8 text-center text-sm text-[var(--color-muted-foreground)]">
          No deployments yet.
        </div>
      ) : (
        <ul className="divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
          {deploymentsQuery.data.map((d) => (
            <li key={d.id}>
              <Link
                to={`/deployments/${d.id}`}
                className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-4 px-4 py-3 hover:bg-[var(--color-muted)]"
              >
                <StatusDot status={d.status} />
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    {d.action} · {d.environmentId}
                  </div>
                  {d.message ? (
                    <div className="truncate text-xs text-[var(--color-muted-foreground)]">{d.message}</div>
                  ) : null}
                </div>
                <div className="text-xs text-[var(--color-muted-foreground)]">{d.status}</div>
                <div className="text-xs text-[var(--color-muted-foreground)]">{relativeTime(d.startedAt)}</div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
