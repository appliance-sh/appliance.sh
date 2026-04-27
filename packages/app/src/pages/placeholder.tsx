import { useSelectedCluster } from '@/hooks/use-selected-cluster';

export function PlaceholderPage({
  title,
  description,
  emptyWhenDisconnected,
}: {
  title: string;
  description?: string;
  emptyWhenDisconnected?: string;
}) {
  const { cluster } = useSelectedCluster();
  const connected = Boolean(cluster);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {description ? <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">{description}</p> : null}
      </div>

      <div className="rounded-md border border-[var(--color-border)] border-dashed p-8 text-center">
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {connected ? 'Nothing here yet.' : (emptyWhenDisconnected ?? 'Connect to a cluster to see content here.')}
        </p>
      </div>
    </div>
  );
}
