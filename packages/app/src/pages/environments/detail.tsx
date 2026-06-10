import * as React from 'react';
import { Link, useNavigate, useParams, Navigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ExternalLink, Play, Rocket, Trash2 } from 'lucide-react';
import { LiveUrl } from '@/components/ui/live-url';
import { Button } from '@/components/ui/button';
import { CommandSnippet } from '@/components/ui/command-snippet';
import { StatusDot } from '@/components/ui/status-dot';
import { useApplianceClient } from '@/hooks/use-appliance-client';
import { useHost } from '@/providers/host-provider';
import { relativeTime } from '@/lib/time';
import { urlForEnvironment } from '@/lib/deployment';
import type { Environment } from '@appliance.sh/sdk/models';

// "pending" looks like in-flight but is also the initial status a
// freshly-created environment has before any deployment runs, so we
// must NOT lump it in here — otherwise Deploy/Destroy stay disabled
// on a brand-new env forever. Real in-flight work always corresponds
// to a non-terminal Deployment record; the per-deployment polling
// surfaces that.
const ENV_IN_FLIGHT = new Set(['deploying', 'destroying', 'refreshing']);

export function EnvironmentDetailPage() {
  const { projectId, id } = useParams<{ projectId: string; id: string }>();
  const navigate = useNavigate();
  const client = useApplianceClient();
  const queryClient = useQueryClient();
  const host = useHost();
  const canRunDeployWizard = Boolean(host.local?.buildAndImportImage);

  const envQuery = useQuery({
    queryKey: ['environment', projectId, id],
    enabled: !!client && !!projectId && !!id,
    queryFn: async () => {
      const r = await client!.getEnvironment(projectId!, id!);
      if (!r.success) throw r.error;
      return r.data;
    },
    refetchInterval: (query) => {
      const data = query.state.data as Environment | undefined;
      if (!data) return 5_000;
      return ENV_IN_FLIGHT.has(data.status) ? 3_000 : 10_000;
    },
  });

  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    enabled: !!client && !!projectId,
    queryFn: async () => {
      const r = await client!.getProject(projectId!);
      if (!r.success) throw r.error;
      return r.data;
    },
  });

  const deploymentsQuery = useQuery({
    queryKey: ['deployments', 'by-environment', id],
    enabled: !!client && !!id,
    queryFn: async () => {
      const r = await client!.listDeployments({ environmentId: id, limit: 20 });
      if (!r.success) throw r.error;
      return r.data;
    },
    refetchInterval: 5_000,
  });

  const [actionError, setActionError] = React.useState<string | null>(null);

  const invalidateAll = React.useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['environment', projectId, id] });
    queryClient.invalidateQueries({ queryKey: ['deployments', 'by-environment', id] });
    queryClient.invalidateQueries({ queryKey: ['deployments'] });
  }, [queryClient, projectId, id]);

  const deployMutation = useMutation({
    mutationFn: async () => {
      const r = await client!.deploy(id!);
      if (!r.success) throw r.error;
      return r.data;
    },
    onSuccess: (deployment) => {
      setActionError(null);
      invalidateAll();
      navigate(`/deployments/${deployment.id}`);
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : String(err)),
  });

  const destroyMutation = useMutation({
    mutationFn: async () => {
      const r = await client!.destroy(id!);
      if (!r.success) throw r.error;
      return r.data;
    },
    onSuccess: (deployment) => {
      setActionError(null);
      invalidateAll();
      navigate(`/deployments/${deployment.id}`);
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : String(err)),
  });

  if (!projectId || !id) return <Navigate to="/environments" replace />;

  const env = envQuery.data;
  const inFlight = env ? ENV_IN_FLIGHT.has(env.status) : false;
  const busy = deployMutation.isPending || destroyMutation.isPending || inFlight;

  const onDestroy = () => {
    if (!env) return;
    const ok =
      typeof window !== 'undefined'
        ? window.confirm(`Destroy environment "${env.name}"? This tears down its stack.`)
        : true;
    if (!ok) return;
    destroyMutation.mutate();
  };

  return (
    <div className="space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/environments">
            <ChevronLeft className="h-4 w-4" /> Environments
          </Link>
        </Button>
      </div>

      {envQuery.error ? (
        <div className="rounded-md border border-red-500/50 bg-red-500/5 p-3 text-xs text-red-400">
          {envQuery.error instanceof Error ? envQuery.error.message : String(envQuery.error)}
        </div>
      ) : null}

      {!env ? (
        <div className="text-sm text-[var(--color-muted-foreground)]">
          {envQuery.isLoading ? 'Loading…' : 'Not found.'}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <StatusDot status={env.status} size="md" />
              <div>
                <h1 className="text-xl font-semibold">{env.name}</h1>
                <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
                  {projectQuery.data?.name ?? env.projectId}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              {(() => {
                // First-time deploys have no image to redeploy from, so
                // `client.deploy(id)` would fail with "No image available…"
                // on the server. When the desktop's local-runtime wizard
                // is available, route the user there with the env preset
                // so they can build + push an image in one flow. On the
                // web shell the first deploy happens from the CLI — the
                // guidance card below replaces a button that could only
                // ever fail.
                const hasImage = Boolean(env.lastDeployedAt);
                if (!hasImage && canRunDeployWizard) {
                  const target = `/local-runtime/deploy?project=${encodeURIComponent(
                    projectQuery.data?.name ?? env.projectId
                  )}&environment=${encodeURIComponent(env.name)}`;
                  return (
                    <Button asChild disabled={busy}>
                      <Link to={target}>
                        <Rocket className="h-4 w-4" /> Set up first deploy
                      </Link>
                    </Button>
                  );
                }
                if (!hasImage) return null;
                return (
                  <Button onClick={() => deployMutation.mutate()} disabled={busy}>
                    <Play className="h-4 w-4" />
                    {deployMutation.isPending ? 'Starting…' : 'Redeploy'}
                  </Button>
                );
              })()}
              <Button variant="destructive" onClick={onDestroy} disabled={busy}>
                <Trash2 className="h-4 w-4" />
                {destroyMutation.isPending ? 'Starting…' : 'Destroy'}
              </Button>
            </div>
          </div>

          {actionError ? (
            <div className="rounded-md border border-red-500/50 bg-red-500/5 p-3 text-xs text-red-400">
              {actionError}
            </div>
          ) : null}

          {!env.lastDeployedAt && !canRunDeployWizard ? (
            <div className="space-y-2 rounded-md border border-[var(--color-border)] p-4">
              <div className="text-sm font-semibold">Deploy your first build</div>
              <p className="text-xs text-[var(--color-muted-foreground)]">
                This environment has no build yet. Run this from your application directory — it builds, uploads, and
                deploys in one step. Redeploys are available here afterwards.
              </p>
              <CommandSnippet command={`appliance deploy ${projectQuery.data?.name ?? env.projectId} ${env.name}`} />
            </div>
          ) : null}

          {(() => {
            // Prefer the canonical env.url; fall back to the latest
            // deploy's message for environments that predate the field.
            const url = urlForEnvironment(env, deploymentsQuery.data);
            if (!url) return null;
            return (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
                <div className="flex min-w-0 items-center gap-3 text-sm">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-green-400" />
                  <LiveUrl url={url} className="min-w-0 text-sm" />
                </div>
                <Button asChild size="sm">
                  <a href={url} target="_blank" rel="noreferrer">
                    Visit <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </Button>
              </div>
            );
          })()}

          <section className="grid gap-x-6 gap-y-3 rounded-md border border-[var(--color-border)] p-4 sm:grid-cols-2">
            <Row label="Status" value={env.status} />
            <Row label="Stack" value={<code className="font-mono text-xs">{env.stackName}</code>} />
            <Row
              label="Last deployed"
              value={
                env.lastDeployedAt ? (
                  <span title={env.lastDeployedAt}>{relativeTime(env.lastDeployedAt)}</span>
                ) : (
                  <span className="text-[var(--color-muted-foreground)]">never</span>
                )
              }
            />
            <Row label="Created" value={<span title={env.createdAt}>{relativeTime(env.createdAt)}</span>} />
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
                        <div className="font-medium">{d.action}</div>
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
