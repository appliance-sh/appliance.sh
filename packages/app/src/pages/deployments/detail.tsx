import { Link, Navigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusDot } from '@/components/ui/status-dot';
import { useApplianceClient } from '@/hooks/use-appliance-client';
import { durationMs, relativeTime } from '@/lib/time';
import type { Deployment } from '@appliance.sh/sdk/models';

const TERMINAL = new Set(['succeeded', 'failed']);

export function DeploymentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const client = useApplianceClient();

  const deploymentQuery = useQuery({
    queryKey: ['deployment', id],
    enabled: !!client && !!id,
    queryFn: async () => {
      const r = await client!.getDeployment(id!);
      if (!r.success) throw r.error;
      return r.data;
    },
    // Poll while the deployment is still running. Stop polling once
    // a terminal status is reached to avoid extra noise.
    refetchInterval: (query) => {
      const data = query.state.data as Deployment | undefined;
      if (!data) return 3_000;
      return TERMINAL.has(data.status) ? false : 3_000;
    },
  });

  if (!id) return <Navigate to="/deployments" replace />;

  const d = deploymentQuery.data;

  return (
    <div className="space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/deployments">
            <ChevronLeft className="h-4 w-4" /> Deployments
          </Link>
        </Button>
      </div>

      {deploymentQuery.error ? (
        <div className="rounded-md border border-red-500/50 bg-red-500/5 p-3 text-xs text-red-400">
          {deploymentQuery.error instanceof Error ? deploymentQuery.error.message : String(deploymentQuery.error)}
        </div>
      ) : null}

      {!d && deploymentQuery.isLoading ? (
        <div className="text-sm text-[var(--color-muted-foreground)]">Loading…</div>
      ) : !d ? (
        <div className="text-sm text-[var(--color-muted-foreground)]">Not found.</div>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <StatusDot status={d.status} size="md" />
            <div>
              <h1 className="text-xl font-semibold">
                {d.action} · {d.environmentId}
              </h1>
              <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
                <code className="font-mono">{d.id}</code>
              </p>
            </div>
          </div>

          {d.message ? (
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-muted)] p-3 text-xs">
              {d.message}
            </div>
          ) : null}

          <section className="grid gap-x-6 gap-y-3 rounded-md border border-[var(--color-border)] p-4 sm:grid-cols-2">
            <Row label="Status" value={d.status} />
            <Row label="Action" value={d.action} />
            <Row label="Project" value={<code className="font-mono text-xs">{d.projectId}</code>} />
            <Row label="Environment" value={<code className="font-mono text-xs">{d.environmentId}</code>} />
            {d.buildId ? <Row label="Build" value={<code className="font-mono text-xs">{d.buildId}</code>} /> : null}
            {d.idempotentNoop ? <Row label="Idempotent" value="yes (no-op)" /> : null}
            <Row
              label="Started"
              value={
                <span title={d.startedAt}>
                  {relativeTime(d.startedAt)} · {new Date(d.startedAt).toLocaleTimeString()}
                </span>
              }
            />
            <Row
              label="Completed"
              value={
                d.completedAt ? (
                  <span title={d.completedAt}>
                    {relativeTime(d.completedAt)} · {new Date(d.completedAt).toLocaleTimeString()}
                  </span>
                ) : (
                  <span className="text-[var(--color-muted-foreground)]">—</span>
                )
              }
            />
            <Row label="Duration" value={durationMs(d.startedAt, d.completedAt) ?? '—'} />
          </section>

          <p className="text-xs text-[var(--color-muted-foreground)]">
            {TERMINAL.has(d.status) ? 'Run complete.' : 'Polling every 3s until the run reaches a terminal status.'}
          </p>
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
