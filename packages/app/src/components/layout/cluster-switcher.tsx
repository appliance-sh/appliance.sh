import * as React from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Check, Plus } from 'lucide-react';
import { useHost } from '@/providers/host-provider';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { cn } from '@/lib/utils';

export function ClusterSwitcher() {
  const host = useHost();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { config, cluster } = useSelectedCluster();
  const clusters = config?.clusters ?? [];

  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selectMutation = useMutation({
    mutationFn: async (id: string) => host.selectCluster(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
      // Cluster-scoped data is going to be refetched. Reset to dashboard
      // so deep-linked rows for the previous cluster don't 404.
      navigate('/');
      setOpen(false);
    },
  });

  if (clusters.length === 0) {
    return (
      <div className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]">No cluster connected</div>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex items-center gap-2 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-sm hover:bg-[var(--color-muted)]',
          open && 'bg-[var(--color-muted)]'
        )}
      >
        <span className="font-medium">{cluster?.name ?? 'Select cluster'}</span>
        <ChevronDown className="h-3.5 w-3.5 text-[var(--color-muted-foreground)]" />
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-10 mt-1 w-72 rounded-md border border-[var(--color-border)] bg-[var(--color-background)] shadow-lg">
          <ul className="max-h-72 overflow-auto py-1">
            {clusters.map((c) => {
              const isSelected = c.id === cluster?.id;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => {
                      if (!isSelected) selectMutation.mutate(c.id);
                      else setOpen(false);
                    }}
                    disabled={selectMutation.isPending}
                    className={cn(
                      'grid w-full grid-cols-[auto_1fr] items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-muted)]',
                      isSelected && 'bg-[var(--color-muted)]'
                    )}
                  >
                    <div className="w-4">
                      {isSelected ? <Check className="h-4 w-4 text-[var(--color-accent)]" /> : null}
                    </div>
                    <div className="min-w-0">
                      <div className="font-medium">{c.name}</div>
                      <div className="truncate font-mono text-xs text-[var(--color-muted-foreground)]">
                        {c.apiServerUrl}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-[var(--color-border)] p-1">
            <Link
              to="/connect"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-[var(--color-muted)]"
            >
              <Plus className="h-4 w-4" />
              Add cluster
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
