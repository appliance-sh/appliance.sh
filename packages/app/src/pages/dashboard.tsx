import { Link } from 'react-router';
import { useQuery, useQueries } from '@tanstack/react-query';
import { Rocket, Folder, Box, Plug, Wand } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusDot } from '@/components/ui/status-dot';
import { EntityLabel } from '@/components/ui/entity-label';
import { useHost } from '@/providers/host-provider';
import { useApplianceClient } from '@/hooks/use-appliance-client';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { useEnvironmentsMap } from '@/hooks/use-lookups';
import { relativeTime } from '@/lib/time';

export function DashboardPage() {
  const host = useHost();
  const canBootstrap = Boolean(host.bootstrap);
  const { cluster, isLoading } = useSelectedCluster();

  if (isLoading) return null;
  if (!cluster) return <GetStarted canBootstrap={canBootstrap} />;

  return <ConnectedDashboard serverUrl={cluster.apiServerUrl} clusterName={cluster.name} />;
}

function ConnectedDashboard({ serverUrl, clusterName }: { serverUrl: string; clusterName: string }) {
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

  const environmentQueries = useQueries({
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

  const deploymentsQuery = useQuery({
    queryKey: ['deployments', 'recent'],
    enabled: !!client,
    queryFn: async () => {
      const r = await client!.listDeployments({ limit: 10 });
      if (!r.success) throw r.error;
      return r.data;
    },
    refetchInterval: 5_000,
  });

  const environmentCount = environmentQueries.reduce((sum, q) => sum + (q.data?.length ?? 0), 0);
  const environmentsLoading = environmentQueries.some((q) => q.isLoading);

  const error = projectsQuery.error ?? environmentQueries.find((q) => q.error)?.error ?? deploymentsQuery.error;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          {clusterName} · <code className="font-mono">{serverUrl}</code>
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-red-500/50 bg-red-500/5 p-3 text-xs text-red-400">
          {error instanceof Error ? error.message : String(error)}
        </div>
      ) : null}

      <div className="grid grid-cols-3 gap-3">
        <Stat
          label="Projects"
          value={projectsQuery.isLoading ? '…' : error ? '—' : String(projectsQuery.data?.length ?? 0)}
          icon={Folder}
        />
        <Stat
          label="Environments"
          value={environmentsLoading || projectsQuery.isLoading ? '…' : error ? '—' : String(environmentCount)}
          icon={Box}
        />
        <Stat
          label="Deployments"
          value={deploymentsQuery.isLoading ? '…' : error ? '—' : String(deploymentsQuery.data?.length ?? 0)}
          icon={Rocket}
        />
      </div>

      <RecentActivity deployments={deploymentsQuery.data} loading={deploymentsQuery.isLoading} />
    </div>
  );
}

function RecentActivity({
  deployments,
  loading,
}: {
  deployments: import('@appliance.sh/sdk/models').Deployment[] | undefined;
  loading: boolean;
}) {
  const envs = useEnvironmentsMap();
  return (
    <section className="rounded-md border border-[var(--color-border)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
        <h2 className="text-sm font-semibold">Recent activity</h2>
      </div>
      {loading && !deployments ? (
        <div className="px-4 py-3 text-xs text-[var(--color-muted-foreground)]">Loading…</div>
      ) : !deployments || deployments.length === 0 ? (
        <div className="px-4 py-3 text-xs text-[var(--color-muted-foreground)]">
          No deployments yet. Runs triggered from the CLI or this shell will show up here.
        </div>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {deployments.map((d) => (
            <li key={d.id}>
              <Link
                to={`/deployments/${d.id}`}
                className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-2 hover:bg-[var(--color-muted)]"
              >
                <StatusDot status={d.status} />
                <div className="min-w-0 text-sm">
                  <div className="font-medium">
                    {d.action} · <EntityLabel id={d.environmentId} name={envs.get(d.environmentId)?.name} />
                  </div>
                  <div className="truncate text-xs text-[var(--color-muted-foreground)]">{d.message ?? '—'}</div>
                </div>
                <div className="text-right text-xs text-[var(--color-muted-foreground)]">
                  {relativeTime(d.startedAt)}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function GetStarted({ canBootstrap }: { canBootstrap: boolean }) {
  return (
    <div className="mx-auto max-w-2xl space-y-6 pt-8">
      <div>
        <h1 className="text-2xl font-semibold">Welcome to Appliance</h1>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          Install and run applications on the cloud. Pick a starting point below.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {canBootstrap ? (
          <ActionCard
            icon={Wand}
            title="Bootstrap a new installation"
            body="Provision the base AWS infrastructure from this machine using your current credentials."
            cta="Start wizard"
            to="/bootstrap"
            primary
          />
        ) : null}
        <ActionCard
          icon={Plug}
          title="Connect to an existing cluster"
          body="Point this shell at an api-server you already have by entering its URL and an API key."
          cta="Connect"
          to="/connect"
          primary={!canBootstrap}
        />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="rounded-md border border-[var(--color-border)] p-4">
      <div className="flex items-center justify-between text-xs uppercase tracking-wide text-[var(--color-muted-foreground)]">
        <span>{label}</span>
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
    </div>
  );
}

function ActionCard({
  icon: Icon,
  title,
  body,
  cta,
  to,
  primary,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
  cta: string;
  to: string;
  primary?: boolean;
}) {
  return (
    <div className="flex flex-col rounded-md border border-[var(--color-border)] p-4">
      <Icon className="h-5 w-5 text-[var(--color-muted-foreground)]" />
      <h2 className="mt-3 text-sm font-semibold">{title}</h2>
      <p className="mt-1 flex-1 text-xs text-[var(--color-muted-foreground)]">{body}</p>
      <Button asChild variant={primary ? 'default' : 'outline'} className="mt-4 self-start">
        <Link to={to}>{cta}</Link>
      </Button>
    </div>
  );
}
