import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { useHost } from '@/providers/host-provider';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { microVmNameFromClusterId } from '@/lib/host';
import { CloudClusterDetail } from './cloud-detail';
import { RuntimeDetail } from './runtime-detail';

// ② Cluster detail — the single ADAPTIVE route (docs/desktop-ia.md §8 Q1).
// One `/clusters/:id` dispatches on cluster KIND:
//   · microVM cluster id  → local-runtime management (tabbed RuntimeDetail)
//   · cloud cluster        → lifecycle ops (CloudClusterDetail)
// No separate `/clusters/runtimes/:name` namespace.
export function ClusterDetailPage() {
  const { id = '' } = useParams();
  const host = useHost();
  const { config, isLoading } = useSelectedCluster();

  const vmName = microVmNameFromClusterId(id);
  const isRuntime = vmName !== null;
  // A microVM may not be a registered cluster yet (not started), so resolve
  // its display name from the id rather than requiring a config entry.
  const cloudCluster = config?.clusters.find((c) => c.id === id) ?? null;

  // Local runtimes are desktop-only (host.vm). On the web shell a microVM id
  // can't resolve to anything manageable.
  const runtimeUnsupported = isRuntime && !host.vm;

  const title = isRuntime ? (vmName ?? id) : (cloudCluster?.name ?? id);

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <Link
          to="/clusters"
          className="inline-flex items-center gap-1.5 text-xs text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Clusters
        </Link>
        <h1 className="mt-2 truncate text-xl font-semibold">{title}</h1>
      </div>

      {isRuntime ? (
        runtimeUnsupported ? (
          <p className="rounded-md border border-dashed border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-muted-foreground)]">
            Local runtimes are only available in the desktop app.
          </p>
        ) : (
          <RuntimeDetail name={vmName!} clusterId={id} />
        )
      ) : isLoading ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">Loading…</p>
      ) : cloudCluster ? (
        <CloudClusterDetail cluster={cloudCluster} />
      ) : (
        <p className="rounded-md border border-dashed border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-muted-foreground)]">
          No cluster with id <code className="font-mono">{id}</code> is connected.{' '}
          <Link to="/clusters" className="underline">
            Back to clusters
          </Link>
          .
        </p>
      )}
    </div>
  );
}
