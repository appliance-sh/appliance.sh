import * as React from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Check, Plus } from 'lucide-react';
import { useHost } from '@/providers/host-provider';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { cn } from '@/lib/utils';
import {
  devMachineLabel,
  isMicroVmClusterId,
  microVmClusterId,
  microVmNameBehindUrl,
  microVmNameFromClusterId,
} from '@/lib/host';
import type { Cluster, MicroVmSummary } from '@/lib/host';

/** Display name for a deploy target: anything backed by the local VM —
 *  its own `microvm*` cluster, or a CLI profile pointing at the VM's
 *  forwarded api-server port — shows as the Dev Machine; cloud
 *  installations keep their given name. */
function targetName(cluster: Cluster, vms: MicroVmSummary[]): string {
  const vm = vmBehindCluster(cluster, vms);
  return vm ? devMachineLabel(vm) : cluster.name;
}

/** The local VM a cluster entry represents, whether registered by the
 *  VM itself (`microvm*` id) or ingested from a CLI profile that points
 *  at the VM's forwarded api-server endpoint. Null for real clouds. */
function vmBehindCluster(cluster: Cluster, vms: MicroVmSummary[]): string | null {
  return microVmNameFromClusterId(cluster.id) ?? microVmNameBehindUrl(cluster.apiServerUrl, vms);
}

function EngineBadge({ local }: { local: boolean }) {
  if (!local) return null;
  return (
    <span className="shrink-0 rounded bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-medium text-cyan-300">
      this computer
    </span>
  );
}

export function ClusterSwitcher() {
  const host = useHost();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { config, cluster } = useSelectedCluster();
  const clusters = config?.clusters ?? [];

  // Local VM inventory (ports) so profile-derived duplicates of the Dev
  // Machine can be recognised by endpoint. Same query key the Machine
  // page and deploy wizard poll — the cache is shared.
  const vmListQuery = useQuery({
    queryKey: ['microvm', 'list'],
    enabled: Boolean(host.vm),
    queryFn: () => host.vm!.list(),
  });
  const vms = vmListQuery.data ?? [];

  // Presentation-only dedupe (see microVmNameBehindUrl): a CLI profile
  // whose URL points at a local VM's forwarded api-server port IS that
  // VM — one machine must not list as two targets. When both entries are
  // registered, render one row: the duplicate yields to its `microvm*`
  // twin unless the duplicate is the current selection (then the twin
  // yields, so the check mark never vanishes). Clicking the surviving
  // row still selects exactly the cluster it always did — nothing about
  // selection or the SDK client's binding changes.
  const visibleClusters = clusters.filter((c) => {
    const vm = vmBehindCluster(c, vms);
    if (!vm) return true;
    if (isMicroVmClusterId(c.id)) {
      // The VM's own row: yield only to a selected profile duplicate.
      return !(cluster && cluster.id !== c.id && vmBehindCluster(cluster, vms) === vm);
    }
    // Profile duplicate: hide when the VM's own row is also listed,
    // unless this duplicate is the current selection.
    return !clusters.some((t) => t.id === microVmClusterId(vm)) || c.id === cluster?.id;
  });

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
      // Deep-linked rows (a project, an environment, a deployment)
      // belong to the previous cluster and would 404 after the switch —
      // those reset to the landing. Top-level sections carry no
      // per-cluster ids and just refetch, so stay put instead of
      // yanking the user off the page they were reading.
      const segments = window.location.pathname.split('/').filter(Boolean);
      const stayable = ['projects', 'machine', 'cloud', 'settings', 'agents', 'deployments'];
      if (segments.length !== 1 || !stayable.includes(segments[0])) {
        navigate('/');
      }
      setOpen(false);
    },
  });

  if (clusters.length === 0) {
    return <div className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]">Not connected</div>;
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
        <span className="font-medium">{cluster ? targetName(cluster, vms) : 'Select target'}</span>
        {cluster ? <EngineBadge local={vmBehindCluster(cluster, vms) !== null} /> : null}
        <ChevronDown className="h-3.5 w-3.5 text-[var(--color-muted-foreground)]" />
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-10 mt-1 w-72 rounded-md border border-[var(--color-border)] bg-[var(--color-background)] shadow-lg">
          <ul className="max-h-72 overflow-auto py-1">
            {visibleClusters.map((c) => {
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
                      <div className="flex items-center gap-1.5 font-medium">
                        {targetName(c, vms)} <EngineBadge local={vmBehindCluster(c, vms) !== null} />
                      </div>
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
              // Canonical add-cloud surface (§5.2 dedup / Devon nit) —
              // the onboarding Connect form, not the old bare /connect.
              to="/setup/connect"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-[var(--color-muted)]"
            >
              <Plus className="h-4 w-4" />
              Add cloud
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
