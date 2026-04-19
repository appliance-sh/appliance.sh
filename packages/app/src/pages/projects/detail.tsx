import * as React from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusDot } from '@/components/ui/status-dot';
import { useApplianceClient } from '@/hooks/use-appliance-client';
import { relativeTime } from '@/lib/time';

const ENV_IN_FLIGHT = new Set(['deploying', 'destroying', 'pending']);

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const client = useApplianceClient();
  const queryClient = useQueryClient();

  const projectQuery = useQuery({
    queryKey: ['project', id],
    enabled: !!client && !!id,
    queryFn: async () => {
      const r = await client!.getProject(id!);
      if (!r.success) throw r.error;
      return r.data;
    },
  });

  const environmentsQuery = useQuery({
    queryKey: ['environments', id],
    enabled: !!client && !!id,
    queryFn: async () => {
      const r = await client!.listEnvironments(id!);
      if (!r.success) throw r.error;
      return r.data;
    },
    refetchInterval: (query) => {
      const envs = query.state.data as { status: string }[] | undefined;
      if (!envs) return 10_000;
      return envs.some((e) => ENV_IN_FLIGHT.has(e.status)) ? 3_000 : 10_000;
    },
  });

  const deploymentsQuery = useQuery({
    queryKey: ['deployments', 'by-project', id],
    enabled: !!client && !!id,
    queryFn: async () => {
      const r = await client!.listDeployments({ projectId: id, limit: 20 });
      if (!r.success) throw r.error;
      return r.data;
    },
    refetchInterval: 5_000,
  });

  const [actionError, setActionError] = React.useState<string | null>(null);

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const r = await client!.deleteProject(id!);
      if (!r.success) throw r.error;
    },
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      navigate('/projects');
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : String(err)),
  });

  if (!id) return <Navigate to="/projects" replace />;

  const onDelete = () => {
    if (!projectQuery.data) return;
    const ok =
      typeof window !== 'undefined'
        ? window.confirm(`Delete project "${projectQuery.data.name}"? Its environments must already be destroyed.`)
        : true;
    if (!ok) return;
    deleteMutation.mutate();
  };

  const project = projectQuery.data;

  return (
    <div className="space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/projects">
            <ChevronLeft className="h-4 w-4" /> Projects
          </Link>
        </Button>
      </div>

      {projectQuery.error ? (
        <div className="rounded-md border border-red-500/50 bg-red-500/5 p-3 text-xs text-red-400">
          {projectQuery.error instanceof Error ? projectQuery.error.message : String(projectQuery.error)}
        </div>
      ) : null}

      {!project ? (
        <div className="text-sm text-[var(--color-muted-foreground)]">
          {projectQuery.isLoading ? 'Loading…' : 'Not found.'}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold">{project.name}</h1>
              {project.description ? (
                <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">{project.description}</p>
              ) : null}
            </div>
            <div className="flex gap-2">
              <Button variant="destructive" onClick={onDelete} disabled={deleteMutation.isPending}>
                <Trash2 className="h-4 w-4" />
                {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
              </Button>
            </div>
          </div>

          {actionError ? (
            <div className="rounded-md border border-red-500/50 bg-red-500/5 p-3 text-xs text-red-400">
              {actionError}
            </div>
          ) : null}

          <section className="grid gap-x-6 gap-y-3 rounded-md border border-[var(--color-border)] p-4 sm:grid-cols-2">
            <Row label="Status" value={project.status} />
            <Row label="ID" value={<code className="font-mono text-xs">{project.id}</code>} />
            <Row label="Created" value={<span title={project.createdAt}>{relativeTime(project.createdAt)}</span>} />
            <Row label="Updated" value={<span title={project.updatedAt}>{relativeTime(project.updatedAt)}</span>} />
          </section>

          <section className="rounded-md border border-[var(--color-border)]">
            <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
              <h2 className="text-sm font-semibold">Environments</h2>
              <Button asChild variant="outline" size="sm">
                <Link to="/environments">Manage</Link>
              </Button>
            </div>
            {environmentsQuery.isLoading && !environmentsQuery.data ? (
              <div className="px-4 py-3 text-xs text-[var(--color-muted-foreground)]">Loading…</div>
            ) : !environmentsQuery.data || environmentsQuery.data.length === 0 ? (
              <div className="px-4 py-3 text-xs text-[var(--color-muted-foreground)]">No environments yet.</div>
            ) : (
              <ul className="divide-y divide-[var(--color-border)]">
                {environmentsQuery.data.map((env) => (
                  <li key={env.id}>
                    <Link
                      to={`/environments/${env.projectId}/${env.id}`}
                      className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-4 px-4 py-2 hover:bg-[var(--color-muted)]"
                    >
                      <StatusDot status={env.status} />
                      <div className="min-w-0 text-sm font-medium">{env.name}</div>
                      <div className="text-xs text-[var(--color-muted-foreground)]">{env.status}</div>
                      <div className="text-xs text-[var(--color-muted-foreground)]">
                        {env.lastDeployedAt ? relativeTime(env.lastDeployedAt) : '—'}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-md border border-[var(--color-border)]">
            <div className="border-b border-[var(--color-border)] px-4 py-3">
              <h2 className="text-sm font-semibold">Recent deployments</h2>
            </div>
            {deploymentsQuery.isLoading && !deploymentsQuery.data ? (
              <div className="px-4 py-3 text-xs text-[var(--color-muted-foreground)]">Loading…</div>
            ) : !deploymentsQuery.data || deploymentsQuery.data.length === 0 ? (
              <div className="px-4 py-3 text-xs text-[var(--color-muted-foreground)]">No deployments yet.</div>
            ) : (
              <ul className="divide-y divide-[var(--color-border)]">
                {deploymentsQuery.data.map((d) => (
                  <li key={d.id}>
                    <Link
                      to={`/deployments/${d.id}`}
                      className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-2 hover:bg-[var(--color-muted)]"
                    >
                      <StatusDot status={d.status} />
                      <div className="min-w-0 text-sm">
                        <div className="font-medium">
                          {d.action} · {d.environmentId}
                        </div>
                        {d.message ? (
                          <div className="truncate text-xs text-[var(--color-muted-foreground)]">{d.message}</div>
                        ) : null}
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
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[auto_1fr] items-baseline gap-3">
      <dt className="text-xs text-[var(--color-muted-foreground)]">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}
