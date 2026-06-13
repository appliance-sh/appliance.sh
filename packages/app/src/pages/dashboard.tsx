import * as React from 'react';
import { Link } from 'react-router';
import { useQuery, useQueries } from '@tanstack/react-query';
import { Plug, Wand, Laptop, Plus, Search, Server } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CommandSnippet } from '@/components/ui/command-snippet';
import { EntityLabel } from '@/components/ui/entity-label';
import { LiveUrl } from '@/components/ui/live-url';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusDot } from '@/components/ui/status-dot';
import { useHost } from '@/providers/host-provider';
import { useApplianceClient } from '@/hooks/use-appliance-client';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { useEnvironmentsMap, useProjectsMap } from '@/hooks/use-lookups';
import { relativeTime } from '@/lib/time';
import { extractDeploymentUrl } from '@/lib/deployment';
import type { Environment, Project } from '@appliance.sh/sdk/models';

export function DashboardPage() {
  const host = useHost();
  const canBootstrap = Boolean(host.bootstrap);
  const canBootstrapLocal = Boolean(host.local?.startRuntime);
  const canBootstrapMicroVm = Boolean(host.vm);
  const { cluster, isLoading } = useSelectedCluster();

  if (isLoading) return null;
  if (!cluster)
    return (
      <GetStarted
        canBootstrap={canBootstrap}
        canBootstrapLocal={canBootstrapLocal}
        canBootstrapMicroVm={canBootstrapMicroVm}
      />
    );

  return <Overview clusterName={cluster.name} serverUrl={cluster.apiServerUrl} />;
}

// ---- the project grid (Vercel-style home) -------------------------------

function Overview({ clusterName, serverUrl }: { clusterName: string; serverUrl: string }) {
  const client = useApplianceClient();
  const [filter, setFilter] = React.useState('');

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    enabled: !!client,
    queryFn: async () => {
      const r = await client!.listProjects();
      if (!r.success) throw r.error;
      return r.data;
    },
    refetchInterval: 10_000,
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
      refetchInterval: 10_000,
    })),
  });

  // Shares the deployments-list page's query key so navigation between
  // the two never double-fetches.
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

  const error = projectsQuery.error ?? environmentQueries.find((q) => q.error)?.error ?? deploymentsQuery.error;
  const loading = projectsQuery.isLoading;
  const projects = projectsQuery.data ?? [];
  const envsByProject = new Map<string, Environment[]>();
  projects.forEach((p, i) => envsByProject.set(p.id, environmentQueries[i]?.data ?? []));

  const visible = filter.trim()
    ? projects.filter((p) => p.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : projects;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
          <p className="mt-0.5 text-sm text-[var(--color-muted-foreground)]">
            {clusterName} · <span className="font-mono text-xs">{serverUrl}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-muted-foreground)]" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search projects…"
              className="h-9 w-56 rounded-md border border-[var(--color-border)] bg-transparent pl-8 pr-3 text-sm placeholder:text-[var(--color-muted-foreground)] focus:border-[var(--color-border-strong)] focus:outline-none"
            />
          </div>
          <Button asChild>
            <Link to="/projects">
              <Plus className="h-4 w-4" /> New Project
            </Link>
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-red-500/50 bg-red-500/5 p-3 text-xs text-red-400">
          {error instanceof Error ? error.message : String(error)}
        </div>
      ) : null}

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="space-y-3 rounded-lg border border-[var(--color-border)] p-5">
              <Skeleton className="h-5 w-2/5" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          ))}
        </div>
      ) : projects.length === 0 ? (
        <EmptyProjects />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((project) => (
            <ProjectCard key={project.id} project={project} environments={envsByProject.get(project.id) ?? []} />
          ))}
          {visible.length === 0 ? (
            <p className="col-span-full py-12 text-center text-sm text-[var(--color-muted-foreground)]">
              No projects match “{filter.trim()}”.
            </p>
          ) : null}
        </div>
      )}

      {projects.length > 0 ? (
        <RecentActivity deployments={deploymentsQuery.data?.slice(0, 8)} loading={deploymentsQuery.isLoading} />
      ) : null}
    </div>
  );
}

function ProjectCard({ project, environments }: { project: Project; environments: Environment[] }) {
  // Card status mirrors the "worst interesting" environment state:
  // anything failed wins, else in-flight, else deployed.
  const status = environments.some((e) => e.status === 'failed')
    ? 'failed'
    : environments.some((e) => ['deploying', 'destroying'].includes(e.status))
      ? 'deploying'
      : environments.some((e) => e.status === 'deployed')
        ? 'deployed'
        : 'pending';
  const live = environments.find((e) => e.status === 'deployed' && e.url);
  const deployedAts = environments
    .map((e) => e.lastDeployedAt)
    .filter((v): v is string => Boolean(v))
    .sort();
  const lastDeployed = deployedAts[deployedAts.length - 1];

  return (
    <Link
      to={`/projects/${project.id}`}
      className="group flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5 transition-colors hover:border-[var(--color-border-strong)]"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium">{project.name}</span>
        <StatusDot status={status} />
      </div>
      <div className="min-h-5 text-sm">
        {live?.url ? (
          <LiveUrl url={live.url} />
        ) : (
          <span className="text-[var(--color-muted-foreground)]">No live deployment</span>
        )}
      </div>
      <div className="mt-auto flex items-center justify-between text-xs text-[var(--color-muted-foreground)]">
        <span>
          {environments.length} environment{environments.length === 1 ? '' : 's'}
        </span>
        <span>{lastDeployed ? `Updated ${relativeTime(lastDeployed)}` : 'Never deployed'}</span>
      </div>
    </Link>
  );
}

function EmptyProjects() {
  return (
    <div className="mx-auto max-w-md space-y-4 py-16 text-center">
      <h2 className="text-lg font-semibold">Deploy your first project</h2>
      <p className="text-sm text-[var(--color-muted-foreground)]">
        Run this from an application directory with an <code className="font-mono">appliance.json</code> — it creates
        the project, builds, and deploys in one step.
      </p>
      <CommandSnippet command="appliance deploy" className="text-left" />
      <p className="text-xs text-[var(--color-muted-foreground)]">The deployed app appears here with its live URL.</p>
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
  const projects = useProjectsMap();
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold text-[var(--color-muted-foreground)]">Recent activity</h2>
      {loading && !deployments ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : !deployments || deployments.length === 0 ? (
        <p className="text-xs text-[var(--color-muted-foreground)]">
          No deployments yet. Runs triggered from the CLI or this console show up here.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
          {deployments.map((d) => {
            const env = envs.get(d.environmentId);
            const url = env?.url ?? extractDeploymentUrl(d.message);
            return (
              <li key={d.id}>
                <Link
                  to={`/deployments/${d.id}`}
                  className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-2.5 transition-colors hover:bg-[var(--color-accent)]"
                >
                  <StatusDot status={d.status} />
                  <div className="min-w-0 text-sm">
                    <span className="font-medium">
                      <EntityLabel id={d.projectId} name={projects.get(d.projectId)?.name} />
                      <span className="text-[var(--color-muted-foreground)]">/</span>
                      <EntityLabel id={d.environmentId} name={env?.name} />
                    </span>
                    <span className="ml-2 text-xs text-[var(--color-muted-foreground)]">
                      {d.action}
                      {url ? (
                        <>
                          {' · '}
                          <span className="font-mono">{url.replace(/^https?:\/\//, '')}</span>
                        </>
                      ) : null}
                    </span>
                  </div>
                  <span className="text-right text-xs text-[var(--color-muted-foreground)]">
                    {relativeTime(d.startedAt)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---- first-run (no cluster) ----------------------------------------------

function GetStarted({
  canBootstrap,
  canBootstrapLocal,
  canBootstrapMicroVm,
}: {
  canBootstrap: boolean;
  canBootstrapLocal: boolean;
  canBootstrapMicroVm: boolean;
}) {
  // Local engines are the recommended starting point — zero cloud cost,
  // no AWS credentials, run on the operator's own machine. When
  // available we promote them to primary and let AWS / Connect sit
  // alongside as alternatives. k3d and the microVM are peers.
  const anyLocal = canBootstrapLocal || canBootstrapMicroVm;
  return (
    <div className="mx-auto max-w-3xl space-y-6 pt-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome to Appliance</h1>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          Install and run applications on a cluster. Start a local engine on this device, provision an AWS cluster, or
          connect to one you already have.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {canBootstrapLocal ? (
          <ActionCard
            icon={Laptop}
            title="Start a local runtime"
            body="A k3d cluster + api-server on this device. Apps publish at *.appliance.localhost. No cloud account needed."
            cta="Start"
            to="/bootstrap?mode=local"
            primary
          />
        ) : null}
        {canBootstrapMicroVm ? (
          <ActionCard
            icon={Server}
            title="Start a microVM"
            body="An isolated VM Appliance boots itself — stronger isolation, no docker provider for the cluster. Same local dev loop."
            cta="Start"
            to="/bootstrap?mode=microvm"
            primary={!canBootstrapLocal}
          />
        ) : null}
        {canBootstrap ? (
          <ActionCard
            icon={Wand}
            title="Bootstrap on AWS"
            body="Provision the base AWS infrastructure from this machine using your current credentials."
            cta="Start wizard"
            to="/bootstrap?mode=aws"
            primary={!anyLocal}
          />
        ) : null}
        <ActionCard
          icon={Plug}
          title="Connect to existing"
          body="Point this console at an api-server you already have by entering its URL and an API key."
          cta="Connect"
          to="/connect"
          primary={!canBootstrap && !anyLocal}
        />
      </div>
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
    <div className="flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <Icon className="h-5 w-5 text-[var(--color-muted-foreground)]" />
      <h2 className="mt-3 text-sm font-semibold">{title}</h2>
      <p className="mt-1 flex-1 text-xs text-[var(--color-muted-foreground)]">{body}</p>
      <Button asChild variant={primary ? 'default' : 'outline'} className="mt-4 self-start">
        <Link to={to}>{cta}</Link>
      </Button>
    </div>
  );
}
