import * as React from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useHost } from '@/providers/host-provider';
import { useApplianceClient } from '@/hooks/use-appliance-client';
import type { Project } from '@appliance.sh/sdk/models';

export function ProjectsPage() {
  const host = useHost();
  const { data: config } = useQuery({
    queryKey: ['host', 'config'],
    queryFn: () => host.getConfig(),
  });
  const connected = Boolean(config?.apiServerUrl);

  if (!connected) {
    return <Disconnected />;
  }

  return <ConnectedProjects />;
}

function ConnectedProjects() {
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
    onSuccess: () => {
      setCreating(false);
      setName('');
      setDescription('');
      setMutationError(null);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (err) => setMutationError(err instanceof Error ? err.message : String(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const r = await client!.deleteProject(id);
      if (!r.success) throw r.error;
    },
    onSuccess: () => {
      setMutationError(null);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (err) => setMutationError(err instanceof Error ? err.message : String(err)),
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name) return;
    createMutation.mutate({ name, description: description || undefined });
  };

  const onDelete = (p: Project) => {
    const ok = typeof window !== 'undefined' ? window.confirm(`Delete project "${p.name}"?`) : true;
    if (!ok) return;
    deleteMutation.mutate(p.id);
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
              pattern="[a-z][a-z0-9-]*"
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
        <div className="text-sm text-[var(--color-muted-foreground)]">Loading…</div>
      ) : !projectsQuery.data || projectsQuery.data.length === 0 ? (
        <div className="rounded-md border border-dashed border-[var(--color-border)] p-8 text-center text-sm text-[var(--color-muted-foreground)]">
          No projects yet. Create one above or via{' '}
          <code className="rounded bg-[var(--color-muted)] px-1.5 py-0.5">appliance</code> on the CLI.
        </div>
      ) : (
        <ul className="divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
          {projectsQuery.data.map((p) => (
            <li key={p.id} className="flex items-center">
              <Link
                to={`/projects/${p.id}`}
                className="grid flex-1 grid-cols-[1fr_auto] items-center gap-4 px-4 py-3 hover:bg-[var(--color-muted)]"
              >
                <div>
                  <div className="text-sm font-medium">{p.name}</div>
                  {p.description ? (
                    <div className="text-xs text-[var(--color-muted-foreground)]">{p.description}</div>
                  ) : null}
                </div>
                <div className="text-xs text-[var(--color-muted-foreground)]">{p.status}</div>
              </Link>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onDelete(p)}
                disabled={deleteMutation.isPending}
                aria-label={`Delete ${p.name}`}
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
