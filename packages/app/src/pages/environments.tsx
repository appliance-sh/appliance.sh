import * as React from 'react';
import { Link } from 'react-router';
import { useQuery, useQueries, useQueryClient, useMutation } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusDot } from '@/components/ui/status-dot';
import { useApplianceClient } from '@/hooks/use-appliance-client';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { relativeTime } from '@/lib/time';
import type { Environment, Project } from '@appliance.sh/sdk/models';

export function EnvironmentsPage() {
  const { cluster } = useSelectedCluster();
  if (!cluster) return <Disconnected />;
  return <ConnectedEnvironments />;
}

interface EnvWithProject {
  env: Environment;
  project: Project;
}

function ConnectedEnvironments() {
  const client = useApplianceClient();
  const queryClient = useQueryClient();

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
      refetchInterval: 10_000,
    })),
  });

  const projectsById = React.useMemo(() => {
    const m = new Map<string, Project>();
    (projectsQuery.data ?? []).forEach((p) => m.set(p.id, p));
    return m;
  }, [projectsQuery.data]);

  const rows: EnvWithProject[] = React.useMemo(() => {
    const out: EnvWithProject[] = [];
    envQueries.forEach((q, i) => {
      const project = (projectsQuery.data ?? [])[i];
      if (!project || !q.data) return;
      q.data.forEach((env) => out.push({ env, project }));
    });
    out.sort((a, b) => (a.env.createdAt < b.env.createdAt ? 1 : -1));
    return out;
  }, [envQueries, projectsQuery.data]);

  const anyLoading = projectsQuery.isLoading || envQueries.some((q) => q.isLoading && !q.data);
  const anyError = projectsQuery.error ?? envQueries.find((q) => q.error)?.error;

  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState('');
  const [projectId, setProjectId] = React.useState('');
  const [mutationError, setMutationError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!projectId && projectsQuery.data?.[0]) setProjectId(projectsQuery.data[0].id);
  }, [projectsQuery.data, projectId]);

  const createMutation = useMutation({
    mutationFn: async (input: { name: string; projectId: string }) => {
      const r = await client!.createEnvironment(input);
      if (!r.success) throw r.error;
      return r.data;
    },
    onSuccess: (env) => {
      setCreating(false);
      setName('');
      setMutationError(null);
      queryClient.invalidateQueries({ queryKey: ['environments', env.projectId] });
    },
    onError: (err) => setMutationError(err instanceof Error ? err.message : String(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: async (env: Environment) => {
      const r = await client!.deleteEnvironment(env.projectId, env.id);
      if (!r.success) throw r.error;
      return env.projectId;
    },
    onSuccess: (projectId) => {
      setMutationError(null);
      queryClient.invalidateQueries({ queryKey: ['environments', projectId] });
    },
    onError: (err) => setMutationError(err instanceof Error ? err.message : String(err)),
  });

  const canCreate = name.length > 0 && projectId.length > 0 && !!projectsQuery.data?.length;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canCreate) return;
    createMutation.mutate({ name, projectId });
  };

  const onDelete = (env: Environment) => {
    const ok = typeof window !== 'undefined' ? window.confirm(`Delete environment "${env.name}"?`) : true;
    if (!ok) return;
    deleteMutation.mutate(env);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold">Environments</h1>
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">Deployment targets across all projects.</p>
        </div>
        {!creating && projectsQuery.data?.length ? (
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> New environment
          </Button>
        ) : null}
      </div>

      {creating ? (
        <form onSubmit={onSubmit} className="space-y-3 rounded-md border border-[var(--color-border)] p-4">
          <h2 className="text-sm font-semibold">New environment</h2>
          <label className="block space-y-1 text-sm">
            <span className="text-[var(--color-muted-foreground)]">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              pattern="[a-z][a-z0-9-]*"
              required
              placeholder="production"
              className={inputCls}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-[var(--color-muted-foreground)]">Project</span>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} required className={inputCls}>
              {(projectsQuery.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-2">
            <Button type="submit" disabled={!canCreate || createMutation.isPending}>
              {createMutation.isPending ? 'Creating…' : 'Create'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setCreating(false);
                setName('');
                setMutationError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {mutationError || anyError ? (
        <div className="rounded-md border border-red-500/50 bg-red-500/5 p-3 text-xs text-red-400">
          {mutationError ?? (anyError instanceof Error ? anyError.message : String(anyError))}
        </div>
      ) : null}

      {!projectsQuery.data?.length && !projectsQuery.isLoading ? (
        <div className="rounded-md border border-dashed border-[var(--color-border)] p-8 text-center text-sm text-[var(--color-muted-foreground)]">
          No projects yet. Create a project first.
        </div>
      ) : anyLoading ? (
        <div className="text-sm text-[var(--color-muted-foreground)]">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-[var(--color-border)] p-8 text-center text-sm text-[var(--color-muted-foreground)]">
          No environments yet.
        </div>
      ) : (
        <ul className="divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
          {rows.map(({ env, project }) => (
            <li key={env.id} className="flex items-center">
              <Link
                to={`/environments/${env.projectId}/${env.id}`}
                className="grid flex-1 grid-cols-[auto_1fr_auto_auto] items-center gap-4 px-4 py-3 hover:bg-[var(--color-muted)]"
              >
                <StatusDot status={env.status} />
                <div className="min-w-0">
                  <div className="text-sm font-medium">{env.name}</div>
                  <div className="text-xs text-[var(--color-muted-foreground)]">
                    {projectsById.get(env.projectId)?.name ?? project.name}
                  </div>
                </div>
                <div className="text-xs text-[var(--color-muted-foreground)]">{env.status}</div>
                <div className="text-xs text-[var(--color-muted-foreground)]">
                  {env.lastDeployedAt ? relativeTime(env.lastDeployedAt) : '—'}
                </div>
              </Link>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onDelete(env)}
                disabled={deleteMutation.isPending}
                aria-label={`Delete ${env.name}`}
                className="mr-2"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Disconnected() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Environments</h1>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">Deployment targets across all projects.</p>
      </div>
      <div className="rounded-md border border-dashed border-[var(--color-border)] p-8 text-center text-sm text-[var(--color-muted-foreground)]">
        Connect to a cluster to see environments.
      </div>
    </div>
  );
}

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]';
