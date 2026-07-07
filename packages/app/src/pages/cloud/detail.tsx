import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { CloudClusterDetail } from './panels';

// /cloud/:id — one cloud installation's management page. Resolves the
// cluster from the shell's registry and hands off to the lifecycle
// panels (Advanced disclosure + Destroy). MicroVM ids never land here —
// the router's /clusters/:id redirect sends those to /machine.
export function CloudDetailPage() {
  const { id = '' } = useParams();
  const { config, isLoading } = useSelectedCluster();
  const cluster = config?.clusters.find((c) => c.id === id) ?? null;

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <Link
          to="/cloud"
          className="inline-flex items-center gap-1.5 text-xs text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Cloud
        </Link>
        <h1 className="mt-2 truncate text-xl font-semibold">{cluster?.name ?? id}</h1>
      </div>

      {isLoading ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">Loading…</p>
      ) : cluster ? (
        <CloudClusterDetail cluster={cluster} />
      ) : (
        <p className="rounded-md border border-dashed border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-muted-foreground)]">
          No cloud installation with id <code className="font-mono">{id}</code> is connected.{' '}
          <Link to="/cloud" className="underline">
            Back to Cloud
          </Link>
          .
        </p>
      )}
    </div>
  );
}
