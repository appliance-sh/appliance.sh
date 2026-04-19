import { useQuery } from '@tanstack/react-query';
import { useHost } from '@/providers/host-provider';

export function PlaceholderPage({
  title,
  description,
  emptyWhenDisconnected,
}: {
  title: string;
  description?: string;
  emptyWhenDisconnected?: string;
}) {
  const host = useHost();
  const { data: config } = useQuery({
    queryKey: ['host', 'config'],
    queryFn: () => host.getConfig(),
  });

  const connected = Boolean(config?.apiServerUrl);

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
