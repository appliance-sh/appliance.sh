import * as React from 'react';
import { Link } from 'react-router';
import { useQueries, useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { ExternalLink, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ListSkeleton } from '@/components/ui/skeleton';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { useApplianceClient } from '@/hooks/use-appliance-client';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { urlMapForEnvironments } from '@/lib/deployment';
import type { Project } from '@appliance.sh/sdk/models';

export function ProjectsPage() {
  const { cluster } = useSelectedCluster();

  if (!cluster) {
    return <Disconnected />;
  }

  return <ConnectedProjects />;
}

function ConnectedProjects() {
  const client = useApplianceClient();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { toast } = useToast();

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    enabled: !!client,
    queryFn: async () => {
      const r = await client!.listProjects();
      if (!r.success) throw r.error;
      return r.data;
    },
  });

  // Per-project deployments + environments queries so each row can
  // surface the live URL of every env that has been deployed
  // successfully. Same pattern used by the environments + dashboard
  // pages — N+1 only kicks in for large project counts, and the page
  // is already iterating per project for the listing.
  const projectIds = (projectsQuery.data ?? []).map((p) => p.id);
  const deploymentsByProject = useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: ['deployments', 'by-project', projectId],
      enabled: !!client,
      queryFn: async () => {
        const r = await client!.listDeployments({ projectId, limit: 50 });
        if (!r.success) throw r.error;
        return r.data;
      },
      refetchInterval: 15_000,
    })),
  });
  const environmentsByProject = useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: ['environments', projectId],
      enabled: !!client,
      queryFn: async () => {
        const r = await client!.listEnvironments(projectId);
        if (!r.success) throw r.error;
        return r.data;
      },
    })),
  });

  const liveUrlsByProject = React.useMemo(() => {
    const out = new Map<string, Array<{ envName: string; url: string }>>();
    projectIds.forEach((projectId, idx) => {
      const deployments = deploymentsByProject[idx]?.data;
      const envs = environmentsByProject[idx]?.data;
      if (!envs) return;
      const envNameById = new Map(envs.map((e) => [e.id, e.name]));
      const urls = urlMapForEnvironments(envs, deployments);
      const entries: Array<{ envName: string; url: string }> = [];
      for (const [envId, url] of urls) {
        const envName = envNameById.get(envId);
        if (!envName) continue;
        entries.push({ envName, url });
      }
      if (entries.length > 0) out.set(projectId, entries);
    });
    return out;
  }, [projectsQuery.data, deploymentsByProject, environmentsByProject]);

  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [mutationError, setMutationError] = React.useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: async (input: { name: string; description?: string }) => {
      const r = await client!.createProject(input);
      if (!r.success) throw r.error;
      return r.data;
    },
    onSuccess: (project) => {
      setCreating(false);
      setName('');
      setDescription('');
      setMutationError(null);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast(`Project "${project.name}" created`);
    },
    onError: (err) => setMutationError(err instanceof Error ? err.message : String(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: async (p: Project) => {
      const r = await client!.deleteProject(p.id);
      if (!r.success) throw r.error;
      return p;
    },
    onSuccess: (p) => {
      setMutationError(null);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast(`Project "${p.name}" deleted`);
    },
    onError: (err) => setMutationError(err instanceof Error ? err.message : String(err)),
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name) return;
    createMutation.mutate({ name, description: description || undefined });
  };

  const onDelete = async (p: Project) => {
    const ok = await confirm({
      title: `Delete project "${p.name}"?`,
      description: 'Its environments must already be destroyed.',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    deleteMutation.mutate(p);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold">Projects</h1>
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            Logical groupings of environments and deployments.
          </p>
        </div>
        {!creating ? (
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> New project
          </Button>
        ) : null}
      </div>

      {creating ? (
        <form onSubmit={onSubmit} className="space-y-3 rounded-md border border-[var(--color-border)] p-4">
          <h2 className="text-sm font-semibold">New project</h2>
          <label className="block space-y-1 text-sm">
            <span className="text-[var(--color-muted-foreground)]">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              pattern="[a-z][a-z0-9\-]*"
              required
              placeholder="my-project"
              className={inputCls}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-[var(--color-muted-foreground)]">Description (optional)</span>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={inputCls}
            />
          </label>
          <div className="flex gap-2">
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? 'Creating…' : 'Create'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setCreating(false);
                setName('');
                setDescription('');
                setMutationError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {mutationError || projectsQuery.error ? (
        <div className="rounded-md border border-red-500/50 bg-red-500/5 p-3 text-xs text-red-400">
          {mutationError ??
            (projectsQuery.error instanceof Error ? projectsQuery.error.message : String(projectsQuery.error))}
        </div>
      ) : null}

      {projectsQuery.isLoading ? (
        <ListSkeleton />
      ) : !projectsQuery.data || projectsQuery.data.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description={
            <>
              Create one with the button above, or via{' '}
              <code className="rounded bg-[var(--color-muted)] px-1.5 py-0.5">appliance</code> on the CLI.
            </>
          }
        />
      ) : (
        <ul className="divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
          {projectsQuery.data.map((p) => {
            const urls = liveUrlsByProject.get(p.id) ?? [];
            return (
              <li
                key={p.id}
                className="grid flex-1 grid-cols-[1fr_auto_auto] items-center gap-4 px-4 py-3 hover:bg-[var(--color-muted)]"
              >
                <div className="min-w-0">
                  <Link to={`/projects/${p.id}`} className="block text-sm font-medium hover:underline">
                    {p.name}
                  </Link>
                  {p.description ? (
                    <div className="text-xs text-[var(--color-muted-foreground)]">{p.description}</div>
                  ) : null}
                  {urls.length > 0 ? (
                    <ul className="mt-1 space-y-0.5">
                      {urls.map(({ envName, url }) => (
                        <li key={envName + url}>
                          <a
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1.5 font-mono text-[11px] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] hover:underline"
                            title={`${envName} — open deployed URL`}
                          >
                            <span className="text-[var(--color-muted-foreground)]">{envName}</span>
                            <span aria-hidden>→</span>
                            <span>{url}</span>
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <div className="text-xs text-[var(--color-muted-foreground)]">{p.status}</div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onDelete(p)}
                  disabled={deleteMutation.isPending}
                  aria-label={`Delete ${p.name}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Disconnected() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Projects</h1>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          Logical groupings of environments and deployments.
        </p>
      </div>
      <div className="rounded-md border border-dashed border-[var(--color-border)] p-8 text-center text-sm text-[var(--color-muted-foreground)]">
        Connect to a cluster to see projects.
      </div>
    </div>
  );
}

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]';
