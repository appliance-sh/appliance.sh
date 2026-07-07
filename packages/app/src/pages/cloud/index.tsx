import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, Cloud as CloudIcon, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { useHost } from '@/providers/host-provider';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { isMicroVmClusterId } from '@/lib/host';
import type { Cluster } from '@/lib/host';

// The Cloud area — every cloud installation this shell is connected to
// (bootstrapped AWS installations and manually-added clusters). Switch /
// remove / manage from here; per-installation lifecycle lives at
// /cloud/:id. The Dev Machine is NOT listed here — it has its own page at
// /machine.
export function CloudPage() {
  const host = useHost();
  const canBootstrap = Boolean(host.bootstrap);
  const { config, isLoading } = useSelectedCluster();
  const selectedId = config?.selectedClusterId ?? null;

  // Cloud clusters only — the Dev Machine's auto-registered entry lives
  // on /machine, so we don't list it twice.
  const cloudClusters = (config?.clusters ?? []).filter((c) => !isMicroVmClusterId(c.id));

  return (
    <div className="max-w-3xl space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Cloud</h1>
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            The cloud installations this shell can deploy to — your own AWS installations and servers your team runs.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button asChild variant="outline">
            {/* Canonical add-cloud surface (§5.2 dedup) — one form. */}
            <Link to="/setup/connect">
              <Plus className="h-4 w-4" /> Add cloud
            </Link>
          </Button>
          {canBootstrap ? (
            <Button asChild variant="outline">
              <Link to="/cloud/bootstrap">New installation</Link>
            </Button>
          ) : null}
        </div>
      </div>

      <section className="space-y-3">
        {isLoading ? (
          <p className="text-xs text-[var(--color-muted-foreground)]">Loading…</p>
        ) : cloudClusters.length === 0 ? (
          <EmptyState
            icon={CloudIcon}
            title="No cloud connected"
            description="Connect to an existing Appliance installation, or bootstrap a new one on your AWS account."
            action={
              <Button asChild>
                <Link to="/setup/connect">
                  <Plus className="h-4 w-4" /> Add cloud
                </Link>
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
            {cloudClusters.map((c) => (
              <CloudRow key={c.id} cluster={c} isSelected={c.id === selectedId} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// One connected cloud installation. The whole row links to its detail;
// Switch is a sibling action so we don't nest a button inside the link.
function CloudRow({ cluster, isSelected }: { cluster: Cluster; isSelected: boolean }) {
  const host = useHost();
  const queryClient = useQueryClient();
  const selectMutation = useMutation({
    mutationFn: async () => host.selectCluster(cluster.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['host', 'config'] }),
  });

  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <div className="w-4 shrink-0">{isSelected ? <Check className="h-4 w-4 text-[var(--color-accent)]" /> : null}</div>
      <Link to={`/cloud/${cluster.id}`} className="group min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium group-hover:underline">{cluster.name}</span>
          <span className="shrink-0 rounded bg-[var(--color-muted)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-muted-foreground)]">
            cloud
          </span>
        </div>
        <div className="truncate font-mono text-xs text-[var(--color-muted-foreground)]">{cluster.apiServerUrl}</div>
      </Link>
      <div className="flex shrink-0 items-center gap-1">
        {!isSelected ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => selectMutation.mutate()}
            disabled={selectMutation.isPending}
          >
            Switch
          </Button>
        ) : null}
        <RemoveCloudButton cluster={cluster} />
        <Button asChild variant="ghost" size="icon" aria-label={`Manage ${cluster.name}`}>
          <Link to={`/cloud/${cluster.id}`}>
            <ChevronRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>
    </li>
  );
}

// Forget a connected cloud installation — drop its saved URL + key from
// this device. Deliberately NOT a teardown: no infrastructure is touched,
// so this is a low-key ghost action (an `X`, not the red Trash2 the
// Destroy panel uses) with a non-destructive confirm. Available on any
// row regardless of selection, since forgetting is a pure local-registry
// op (the host's removeCluster re-points selection to a survivor).
function RemoveCloudButton({ cluster }: { cluster: Cluster }) {
  const host = useHost();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { toast } = useToast();
  const removeMutation = useMutation({
    mutationFn: async () => host.removeCluster(cluster.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
      toast(`Removed "${cluster.name}"`);
    },
    onError: (err) => toast(err instanceof Error ? err.message : String(err), { variant: 'error' }),
  });

  const onClick = async () => {
    const ok = await confirm({
      title: `Remove "${cluster.name}"?`,
      description:
        'Forgets this installation’s saved URL and API key on this device. It does NOT destroy any cloud ' +
        'infrastructure — you can re-add it later from Add cloud. To tear down the AWS resources instead, open the ' +
        'installation and use Destroy.',
      confirmLabel: 'Remove',
      destructive: false,
    });
    if (!ok) return;
    removeMutation.mutate();
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`Remove ${cluster.name} from this device`}
      title="Remove from this device"
      onClick={onClick}
      disabled={removeMutation.isPending}
    >
      <X className="h-4 w-4" />
    </Button>
  );
}
