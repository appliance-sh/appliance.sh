import * as React from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, Plus, Server } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { useHost } from '@/providers/host-provider';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { cn } from '@/lib/utils';
import { isMicroVmClusterId, microVmClusterId } from '@/lib/host';
import type { Cluster, MicroVmSummary } from '@/lib/host';

// ② Clusters — the list (docs/desktop-ia.md §3). One surface for every
// deploy target: the connected CLOUD clusters (the old Settings "Clusters"
// section) plus the LOCAL RUNTIMES (microVMs), each tagged by kind. Select /
// switch / add from here; per-cluster management lives at `/clusters/:id`.
// The header keeps the `ClusterSwitcher` (selection is always one click
// away) — this page is the fuller list + entry to detail.
export function ClustersPage() {
  const host = useHost();
  const canBootstrap = Boolean(host.bootstrap);
  const showRuntimes = Boolean(host.vm);
  const { config, isLoading } = useSelectedCluster();
  const selectedId = config?.selectedClusterId ?? null;

  // Cloud clusters only — microVM-backed clusters surface in the Local
  // runtimes section below (by VM, not by their registered cluster row), so
  // we don't list them twice.
  const cloudClusters = (config?.clusters ?? []).filter((c) => !isMicroVmClusterId(c.id));

  return (
    <div className="max-w-3xl space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Clusters</h1>
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            Every place you can deploy — cloud clusters this shell is connected to, and local runtimes sandboxed on this
            machine.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button asChild variant="outline">
            {/* Canonical add-cluster surface (§5.2 dedup) — one form. */}
            <Link to="/setup/connect">
              <Plus className="h-4 w-4" /> Add cluster
            </Link>
          </Button>
          {canBootstrap ? (
            <Button asChild variant="outline">
              <Link to="/setup/bootstrap">Bootstrap</Link>
            </Button>
          ) : null}
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-[var(--color-muted-foreground)]">Connected clusters</h2>
        {isLoading ? (
          <p className="text-xs text-[var(--color-muted-foreground)]">Loading…</p>
        ) : cloudClusters.length === 0 ? (
          <EmptyState
            icon={Server}
            title="No cloud clusters connected"
            description="Connect to an existing Appliance cluster, or bootstrap a new installation on AWS."
            action={
              <Button asChild>
                <Link to="/setup/connect">
                  <Plus className="h-4 w-4" /> Add cluster
                </Link>
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
            {cloudClusters.map((c) => (
              <ClusterRow key={c.id} cluster={c} isSelected={c.id === selectedId} />
            ))}
          </ul>
        )}
      </section>

      {showRuntimes ? <LocalRuntimesSection selectedId={selectedId} registered={config?.clusters ?? []} /> : null}
    </div>
  );
}

// One connected (cloud / BYO) cluster. The whole row links to its detail;
// Switch is a sibling action so we don't nest a button inside the link.
function ClusterRow({ cluster, isSelected }: { cluster: Cluster; isSelected: boolean }) {
  const host = useHost();
  const queryClient = useQueryClient();
  const selectMutation = useMutation({
    mutationFn: async () => host.selectCluster(cluster.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['host', 'config'] }),
  });

  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <div className="w-4 shrink-0">{isSelected ? <Check className="h-4 w-4 text-[var(--color-accent)]" /> : null}</div>
      <Link to={`/clusters/${cluster.id}`} className="group min-w-0 flex-1">
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
        <Button asChild variant="ghost" size="icon" aria-label={`Manage ${cluster.name}`}>
          <Link to={`/clusters/${cluster.id}`}>
            <ChevronRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>
    </li>
  );
}

// Local runtimes (microVMs). Always surface the default `appliance` VM (even
// before it's created, so the first-run Start is reachable from detail),
// then any VMs the engine reports, then still-pending additions. Each row
// links to its `/clusters/:id` detail; the heavy lifecycle/egress/creds
// management lives there, not inline.
function LocalRuntimesSection({ selectedId, registered }: { selectedId: string | null; registered: Cluster[] }) {
  const host = useHost();
  const navigate = useNavigate();
  const [pending, setPending] = React.useState<string[]>([]);

  const vmListQuery = useQuery({
    queryKey: ['microvm', 'list'],
    queryFn: () => host.vm!.list(),
    refetchInterval: 8_000,
  });
  const vms = vmListQuery.data ?? [];

  const names = React.useMemo(() => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const n of ['appliance', ...vms.map((v) => v.name), ...pending]) {
      if (!seen.has(n)) {
        seen.add(n);
        ordered.push(n);
      }
    }
    return ordered;
  }, [vms, pending]);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-[var(--color-muted-foreground)]">Local runtimes</h2>
        <NewVmButton
          existing={names}
          onAdd={(n) => {
            setPending((p) => [...p, n]);
            // The VM doesn't exist on the engine until its detail's Start
            // boots it; the detail page handles a not-yet-created VM.
            navigate(`/clusters/${microVmClusterId(n)}`);
          }}
        />
      </div>

      {vmListQuery.isLoading && vms.length === 0 ? (
        <p className="text-xs text-[var(--color-muted-foreground)]">Loading VMs…</p>
      ) : null}

      <ul className="divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
        {names.map((name) => {
          const clusterId = microVmClusterId(name);
          return (
            <RuntimeRow
              key={name}
              name={name}
              clusterId={clusterId}
              summary={vms.find((v) => v.name === name)}
              isSelected={clusterId === selectedId}
              isRegistered={registered.some((c) => c.id === clusterId)}
            />
          );
        })}
      </ul>
    </section>
  );
}

function RuntimeRow({
  name,
  clusterId,
  summary,
  isSelected,
  isRegistered,
}: {
  name: string;
  clusterId: string;
  summary?: MicroVmSummary;
  isSelected: boolean;
  isRegistered: boolean;
}) {
  const host = useHost();
  const queryClient = useQueryClient();
  const selectMutation = useMutation({
    mutationFn: async () => host.selectCluster(clusterId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['host', 'config'] }),
  });

  // Compact status straight off the `list` summary — no per-VM status poll
  // in the list (the detail page owns the live state machine).
  const state = !summary
    ? 'not created'
    : summary.running
      ? summary.clusterReady
        ? 'running'
        : summary.phase === 'failed'
          ? 'failed'
          : 'starting…'
      : 'stopped';

  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <div className="w-4 shrink-0">{isSelected ? <Check className="h-4 w-4 text-[var(--color-accent)]" /> : null}</div>
      <Link to={`/clusters/${clusterId}`} className="group min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-sm font-medium group-hover:underline">{name}</span>
          <span className="shrink-0 rounded bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-medium text-cyan-300">
            local runtime
          </span>
          {name === 'appliance' ? (
            <span className="shrink-0 rounded bg-[var(--color-muted)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-muted-foreground)]">
              default
            </span>
          ) : null}
        </div>
        <div className="font-mono text-xs text-[var(--color-muted-foreground)]">{clusterId}</div>
      </Link>
      <span
        className={cn(
          'shrink-0 rounded-md px-2 py-1 text-xs font-medium',
          state === 'running'
            ? 'border border-green-500/40 bg-green-500/15 text-green-300'
            : state === 'starting…'
              ? 'border border-cyan-500/40 bg-cyan-500/15 text-cyan-300'
              : state === 'failed'
                ? 'border border-red-500/40 bg-red-500/15 text-red-300'
                : 'bg-[var(--color-muted)] text-[var(--color-muted-foreground)]'
        )}
      >
        {state}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        {isRegistered && !isSelected ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => selectMutation.mutate()}
            disabled={selectMutation.isPending}
          >
            Switch
          </Button>
        ) : null}
        <Button asChild variant="ghost" size="icon" aria-label={`Manage ${name}`}>
          <Link to={`/clusters/${clusterId}`}>
            <ChevronRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>
    </li>
  );
}

// Name a new VM, then jump to its detail. The VM doesn't exist on the engine
// until the detail's Start boots it — this just validates the name.
function NewVmButton({ existing, onAdd }: { existing: string[]; onAdd: (name: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [err, setErr] = React.useState<string | null>(null);

  const submit = () => {
    const n = name.trim();
    if (!n) return;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(n)) {
      setErr('Use lowercase letters, digits, and dashes (e.g. "traffic").');
      return;
    }
    if (existing.includes(n)) {
      setErr(`A VM named "${n}" already exists.`);
      return;
    }
    onAdd(n);
    setOpen(false);
    setName('');
    setErr(null);
  };

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> New VM
      </Button>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <input
          autoFocus
          type="text"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={name}
          onChange={(e) => {
            setName(e.target.value.toLowerCase());
            setErr(null);
          }}
          placeholder="vm name, e.g. traffic"
          className="w-40 rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1 font-mono text-xs"
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') setOpen(false);
          }}
        />
        <Button size="sm" disabled={!name.trim()} onClick={submit}>
          Add
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {err ? <p className="text-[10px] text-red-300">{err}</p> : null}
    </div>
  );
}
