import * as React from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  FileText,
  FolderOpen,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Square,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useHost } from '@/providers/host-provider';
import { cn } from '@/lib/utils';
import { microVmClusterId } from '@/lib/host';
import { TerminalDrawer } from './terminal-drawer';
import type {
  EgressEvent,
  EgressPolicy,
  LocalDeploymentInfo,
  LocalPodInfo,
  LocalPreflightCheck,
  LocalRuntimeStatus,
  LocalServiceInfo,
  MicroVmInstanceHost,
  MicroVmStatus,
  MicroVmSummary,
} from '@/lib/host';

// Docker Desktop-style overview page for the local k3d-backed
// container runtime. Drives three things in one place:
//   * Cluster + api-server lifecycle (Start / Stop / Delete).
//   * Resolved configuration the runtime is using (cluster name,
//     namespace, ports, data dir) for ops debugging.
//   * Live workloads (Deployments / Pods / Services) in the
//     appliance namespace, with per-pod log tails.
//
// All wiring goes through `host.local.*` — implemented today by the
// Tauri shell (web host can't shell out to k3d/kubectl).
export function LocalRuntimePage() {
  const host = useHost();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const local = host.local;
  const supported = Boolean(local?.runtimeStatus);

  const statusQuery = useQuery({
    queryKey: ['local-runtime', 'status'],
    enabled: supported,
    queryFn: () => local!.runtimeStatus(),
    // Snappy refresh while a transition is in flight, lazier when idle.
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!data) return 3_000;
      const running = data.cluster.running && data.apiServer.running;
      return running ? 5_000 : 2_000;
    },
  });

  // Preflight: ask the host which of docker/k3d/kubectl are installed.
  // The runtime itself shells out to all three; if any are missing the
  // first Start click would surface a cryptic "failed to spawn" error.
  // We render an actionable install panel instead and disable Start
  // until everything checks out. Polled lazily so installing a tool in
  // a separate terminal is reflected within a few seconds without
  // requiring a page reload.
  const preflightQuery = useQuery({
    queryKey: ['local-runtime', 'preflight'],
    enabled: supported && Boolean(local?.preflight),
    queryFn: () => local!.preflight(),
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!data) return 5_000;
      // Keep polling while anything's not ready — including docker
      // installed-but-daemon-down — so starting a tool or the runtime
      // in another window clears the panel within a few seconds.
      return data.every(checkReady) ? false : 5_000;
    },
  });
  const preflightChecks = preflightQuery.data ?? [];
  const preflightReady = preflightChecks.length === 0 || preflightChecks.every(checkReady);

  const startMutation = useMutation({
    mutationFn: () => local!.startRuntime(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['local-runtime'] }),
  });
  const stopMutation = useMutation({
    mutationFn: () => local!.stopRuntime(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['local-runtime'] }),
  });
  const deleteMutation = useMutation({
    mutationFn: () => local!.deleteRuntime(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['local-runtime'] });
      // Removing the auto-registered cluster also nudges host config.
      queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
    },
  });

  const status = statusQuery.data;
  const phase = derivePhase(status, startMutation.isPending, stopMutation.isPending, deleteMutation.isPending);

  // The header's Deploy button serves every engine — the wizard
  // targets the selected cluster, so it's useful as soon as the k3d
  // runtime or any microVM is up. The VM list drives both the deploy
  // gate and the per-VM panels below.
  const vmListQuery = useQuery({
    queryKey: ['microvm', 'list'],
    enabled: Boolean(host.vm),
    queryFn: () => host.vm!.list(),
    refetchInterval: 8_000,
  });
  const vms = vmListQuery.data ?? [];
  const anyVmRunning = vms.some((v) => v.running);
  const canDeploy = phase === 'running' || anyVmRunning;
  // The default VM shares host port 8081 with the k3d runtime — only
  // one can hold it. Named VMs get their own ports, so they never
  // conflict. Gate k3d Start on the *default* VM running.
  const microVmHoldsPort = vms.some((v) => v.name === 'appliance' && v.running);

  if (!supported) {
    return (
      <div className="max-w-2xl space-y-4">
        <h1 className="text-xl font-semibold">Local Runtime</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          This shell can&rsquo;t drive a local k3d runtime — Local Runtime is only available in the desktop app.
        </p>
      </div>
    );
  }

  const onDelete = async () => {
    const ok = await confirm({
      title: 'Delete the local runtime?',
      description:
        'This stops the api-server, deletes the k3d cluster, and forgets the registered Console cluster + API key. The data dir is left on disk.',
      confirmLabel: 'Delete runtime',
    });
    if (!ok) return;
    deleteMutation.mutate();
  };

  // The host-side k3d runtime — the unsandboxed option, a peer of every
  // sandboxed microVM card below it, not a privileged "primary runtime".
  const k3dCard = (
    <EngineCard
      name={status?.config.clusterName ?? 'appliance-local'}
      engine="k3d"
      statusPill={<PhaseBadge phase={phase} />}
      description="Runs k3d directly on this host via the docker provider — not sandboxed. Registers as a regular cluster."
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => startMutation.mutate()}
          disabled={
            !preflightReady ||
            phase === 'running' ||
            phase === 'starting' ||
            startMutation.isPending ||
            microVmHoldsPort
          }
          title={
            !preflightReady
              ? 'Install the prerequisites listed above to enable Start'
              : microVmHoldsPort && phase !== 'running'
                ? 'Stop the default microVM first — both engines publish on host port 8081'
                : undefined
          }
        >
          <Play className="h-4 w-4" /> {phase === 'running' ? 'Running' : phase === 'starting' ? 'Starting…' : 'Start'}
        </Button>
        <Button
          variant="outline"
          onClick={() => stopMutation.mutate()}
          disabled={phase === 'stopped' || phase === 'stopping' || stopMutation.isPending}
        >
          <Square className="h-4 w-4" /> {phase === 'stopping' ? 'Stopping…' : 'Stop'}
        </Button>
        <Button variant="destructive" onClick={onDelete} disabled={deleteMutation.isPending}>
          <Trash2 className="h-4 w-4" /> {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh"
          onClick={() => statusQuery.refetch()}
          disabled={statusQuery.isFetching}
        >
          <RefreshCw className={cn('h-4 w-4', statusQuery.isFetching && 'animate-spin')} />
        </Button>
      </div>

      <MutationErrors errors={[startMutation.error, stopMutation.error, deleteMutation.error]} />

      {status ? <RuntimeOverview status={status} /> : null}

      {status?.cluster.running && status?.apiServer.running ? <WorkloadsPanel /> : null}
    </EngineCard>
  );

  return (
    <div className="max-w-4xl space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Local runtime</h1>
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            Run appliances on this machine — sandboxed in a virtual machine (recommended) or directly on the host. Each
            registers as a regular cluster you can deploy to and switch between.
          </p>
        </div>
        {canDeploy ? (
          <Button asChild variant="outline">
            <Link to="/local-runtime/deploy">
              <Rocket className="h-4 w-4" /> Deploy application
            </Link>
          </Button>
        ) : (
          // `disabled` on an asChild Button renders an anchor, and
          // anchors ignore it — the wizard stayed reachable with the
          // runtime down. A real <button> actually gates.
          <Button variant="outline" disabled title="Start the local runtime to deploy applications">
            <Rocket className="h-4 w-4" /> Deploy application
          </Button>
        )}
      </header>

      <PreflightPanel
        checks={preflightChecks}
        loading={preflightQuery.isLoading}
        onRefresh={() => preflightQuery.refetch()}
        canInstall={Boolean(local?.installPrereq)}
        onInstall={async (tool) => {
          if (!local?.installPrereq) return;
          await local.installPrereq([tool], () => {});
          preflightQuery.refetch();
        }}
        canStartRuntime={Boolean(local?.startContainerRuntime)}
        onStartRuntime={async () => {
          if (!local?.startContainerRuntime) return;
          await local.startContainerRuntime();
          preflightQuery.refetch();
        }}
      />

      <EnginesSection showMicroVm={Boolean(host.vm)} vms={vms} loading={vmListQuery.isLoading} leadingPanel={k3dCard} />
    </div>
  );
}

// A consistent card shell for every local engine — k3d and each
// microVM render with identical chrome (name + engine tag + status
// pill), so no engine reads as more "primary" than another.
function EngineCard({
  name,
  engine,
  statusPill,
  description,
  headerTag,
  children,
}: {
  name: string;
  engine: 'k3d' | 'microVM';
  statusPill: React.ReactNode;
  description?: React.ReactNode;
  headerTag?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-md border border-[var(--color-border)] p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <code className="font-mono text-sm font-semibold text-[var(--color-foreground)]">{name}</code>
            <EngineTag engine={engine} />
            {headerTag}
          </div>
          {description ? <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">{description}</p> : null}
        </div>
        <div className="shrink-0">{statusPill}</div>
      </header>
      {children}
    </section>
  );
}

// How the runtime is hosted — sandboxed in a VM vs directly on the
// host. Informational framing of the one choice (sandbox or not),
// never a hierarchy. The prop stays engine-keyed so callers don't have
// to translate; only the label reflects the sandbox framing.
function EngineTag({ engine }: { engine: 'k3d' | 'microVM' }) {
  const label = engine === 'microVM' ? 'sandboxed' : 'on host';
  return <span className="rounded bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-medium text-cyan-300">{label}</span>;
}

// ---- engines (k3d + microVMs, presented as peers) -----------------------
//
// One unified list of local engines: the k3d runtime card first, then a
// card per microVM. Appliance can run several microVMs at once — e.g.
// one for interactive development and another dedicated to traffic
// testing — each its own isolated VM on its own host ports, registered
// as its own cluster. The default "appliance" VM is always surfaced
// (even before it's created) and a New VM control adds more.
function EnginesSection({
  vms,
  loading,
  showMicroVm,
  leadingPanel,
}: {
  vms: MicroVmSummary[];
  loading: boolean;
  showMicroVm: boolean;
  leadingPanel: React.ReactNode;
}) {
  // VMs added through the UI but not yet in `list` (their spec lands
  // only once Start boots them). Tracked locally so the panel appears
  // immediately, then folds into the list view once it materializes.
  const [pending, setPending] = React.useState<string[]>([]);

  // Always surface the default "appliance" VM, even when nothing is
  // defined yet, so the first-run Start affordance is present. Then any
  // VMs from `list`, then still-pending additions.
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
      <header className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-[var(--color-muted-foreground)]">Runtimes</h2>
        {showMicroVm ? <NewVmButton existing={names} onAdd={(n) => setPending((p) => [...p, n])} /> : null}
      </header>

      {leadingPanel}

      {showMicroVm ? (
        <>
          {loading && vms.length === 0 ? (
            <p className="text-xs text-[var(--color-muted-foreground)]">Loading VMs…</p>
          ) : null}
          {names.map((name) => (
            <MicroVmPanel key={name} name={name} summary={vms.find((v) => v.name === name)} />
          ))}
        </>
      ) : null}
    </section>
  );
}

// Name a new VM. It doesn't exist on the engine until its panel's Start
// boots it (which allocates ports + bootstraps), so this just validates
// the name and surfaces a panel for it — the Start there streams boot
// progress, exactly like the default VM.
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

// ---- a single microVM engine --------------------------------------------

// One microVM: an isolated VM Appliance boots itself (appliance-vm)
// instead of renting the docker provider's. Each VM registers as a
// regular cluster (id "microvm" / "microvm-<name>" — also its CLI
// profile name) on its own host ports, so the deploy wizard, cluster
// switcher, and workload views treat it like any other target. Rendered
// in the same EngineCard chrome as the k3d runtime — a peer, not an
// add-on.
function MicroVmPanel({ name, summary }: { name: string; summary?: MicroVmSummary }) {
  const host = useHost();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const vm = React.useMemo(() => host.vm!.instance(name), [host, name]);
  const isDefault = name === 'appliance';

  const statusQuery = useQuery({
    queryKey: ['microvm', name, 'status'],
    queryFn: () => vm.status(),
    refetchInterval: (q) => {
      const data = q.state.data as MicroVmStatus | undefined;
      if (!data?.available) return 30_000;
      return data.running ? 8_000 : 4_000;
    },
  });

  // Mirror of the page-level port gate, in the other direction: a
  // running k3d cluster holds host port 8081, so the *default* microVM
  // (which shares that port) can't boot until it stops. Named VMs get
  // their own ports and aren't gated. Shares the page's query key
  // (cache-deduped).
  const k3dQuery = useQuery({
    queryKey: ['local-runtime', 'status'],
    enabled: isDefault && Boolean(host.local?.runtimeStatus),
    queryFn: () => host.local!.runtimeStatus(),
    refetchInterval: 30_000,
  });
  const k3dHoldsPort = isDefault && Boolean(k3dQuery.data?.cluster.running);

  const [busy, setBusy] = React.useState<'install' | 'up' | 'stop' | 'delete' | null>(null);
  const [log, setLog] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  // Whether the next Start should provision a dev environment. Forced on
  // once the VM is already a dev VM (the engine flag is one-way).
  const [devMode, setDevMode] = React.useState(false);
  // Host folder to share into /persist/workspace on the next dev boot.
  const [mountPath, setMountPath] = React.useState<string | null>(null);
  const [shellOpen, setShellOpen] = React.useState(false);
  const logRef = React.useRef<HTMLPreElement | null>(null);

  React.useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['microvm', name] });
    queryClient.invalidateQueries({ queryKey: ['microvm', 'list'] });
  };

  const run = async (kind: 'install' | 'up' | 'stop' | 'delete', action: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    if (kind === 'up') setLog([]);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      refresh();
      // `up` registers the microVM cluster, `delete` removes it —
      // nudge the cluster list (switcher, wizard target) either way.
      if (kind === 'up' || kind === 'delete') {
        queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
      }
    }
  };

  // Deploy into this engine: make its cluster the selected one (the
  // wizard targets the selection), then open the wizard. The cluster
  // is guaranteed registered by the time the CTA renders — status
  // reports ready only after the Rust side synced the registration.
  const clusterId = microVmClusterId(name);
  const deployHere = async () => {
    try {
      const cfg = await host.getConfig();
      if (cfg.selectedClusterId !== clusterId) {
        await host.selectCluster(clusterId);
        queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
      }
    } catch {
      // Selection is a convenience — the wizard surfaces the actual
      // target either way.
    }
    navigate('/local-runtime/deploy');
  };

  const onDelete = async () => {
    const ok = await confirm({
      title: `Delete the "${name}" microVM?`,
      description: 'In-VM state (projects, images, deployments) is destroyed.',
      confirmLabel: 'Delete microVM',
    });
    if (!ok) return;
    void run('delete', () => vm.remove());
  };

  const status = statusQuery.data;

  // The Rust side registers the microVM as a regular cluster once it's
  // ready (sync_microvm_cluster, run from microvm_status). That can
  // happen on a passive status poll — e.g. the VM was started from the
  // CLI, or came up after the desktop launched — in which case nothing
  // has told the cluster switcher to refetch. Nudge the host-config
  // query once per ready transition so the freshly-registered cluster
  // becomes selectable without a desktop restart.
  const microVmReady = Boolean(status?.running && status?.kubeconfigReady);
  const refreshedForReady = React.useRef(false);
  React.useEffect(() => {
    if (microVmReady && !refreshedForReady.current) {
      refreshedForReady.current = true;
      queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
    } else if (!microVmReady) {
      refreshedForReady.current = false;
    }
  }, [microVmReady, queryClient]);

  const state = !status
    ? 'checking…'
    : !status.available
      ? busy === 'install'
        ? 'installing…'
        : status.installable
          ? 'not installed'
          : 'unavailable'
      : busy === 'up'
        ? 'starting…'
        : status.running
          ? 'running'
          : status.exists
            ? 'stopped'
            : 'not created';

  const statusPill = (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-md px-2 py-1 text-xs font-medium',
        state === 'running'
          ? 'border border-green-500/40 bg-green-500/15 text-green-300'
          : state === 'starting…'
            ? 'border border-cyan-500/40 bg-cyan-500/15 text-cyan-300'
            : 'bg-[var(--color-muted)] text-[var(--color-muted-foreground)]'
      )}
    >
      {state}
    </span>
  );

  return (
    <EngineCard
      name={name}
      engine="microVM"
      statusPill={statusPill}
      headerTag={
        isDefault ? (
          <span className="rounded bg-[var(--color-muted)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-muted-foreground)]">
            default
          </span>
        ) : null
      }
      description={
        <>
          Deploys use the <code className="font-mono">{clusterId}</code> profile.
        </>
      }
    >
      {status && !status.available ? (
        status.installable ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--color-border)] px-3 py-2">
            <p className="text-xs text-[var(--color-muted-foreground)]">
              The engine binary (<code className="font-mono">appliance-vm</code>) isn't installed yet — Appliance
              installs it into <code className="font-mono">~/.appliance/bin</code>.
            </p>
            <Button onClick={() => run('install', () => host.vm!.install())} disabled={busy !== null}>
              <Download className="h-4 w-4" /> {busy === 'install' ? 'Installing…' : 'Install engine'}
            </Button>
          </div>
        ) : (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
            {status.message ?? 'appliance-vm is not installed on this machine.'}
          </p>
        )
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => {
              const onLog = (e: { message: string }) => setLog((prev) => [...prev.slice(-199), e.message]);
              // Dev once dev: the engine flag is one-way, so a dev VM
              // always re-provisions through `dev up`.
              const wantDev = devMode || status?.dev === true;
              void run('up', () => (wantDev ? vm.devUp(onLog, { mount: mountPath ?? undefined }) : vm.up(onLog)));
            }}
            disabled={busy !== null || status?.running === true || (k3dHoldsPort && !status?.running)}
            title={
              k3dHoldsPort && !status?.running
                ? 'Stop the k3d runtime first — both engines publish on host port 8081'
                : undefined
            }
          >
            <Play className="h-4 w-4" />{' '}
            {busy === 'up'
              ? 'Starting…'
              : status?.running
                ? 'Running'
                : devMode || status?.dev
                  ? 'Start dev env'
                  : 'Start'}
          </Button>
          <Button
            variant="outline"
            onClick={() => run('stop', () => vm.stop())}
            disabled={busy !== null || !status?.running}
          >
            <Square className="h-4 w-4" /> {busy === 'stop' ? 'Stopping…' : 'Stop'}
          </Button>
          <Button variant="destructive" onClick={onDelete} disabled={busy !== null || !status?.exists}>
            <Trash2 className="h-4 w-4" /> {busy === 'delete' ? 'Deleting…' : 'Delete'}
          </Button>
          {status?.dev ? (
            <span className="inline-flex items-center gap-1 rounded bg-violet-500/15 px-2 py-1 text-xs text-violet-300">
              <TerminalIcon className="h-3.5 w-3.5" /> dev environment
            </span>
          ) : !status?.running ? (
            <label
              className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-[var(--color-muted-foreground)]"
              title="Provision a dev toolchain + a persistent /persist/workspace you can shell into"
            >
              <input
                type="checkbox"
                checked={devMode}
                onChange={(e) => setDevMode(e.target.checked)}
                disabled={busy !== null}
              />
              dev environment
            </label>
          ) : null}
          {(devMode || status?.dev) && !status?.running && host.local?.pickDirectory ? (
            <div className="inline-flex items-center gap-1.5 text-xs">
              <button
                type="button"
                onClick={async () => {
                  const picked = await host.local?.pickDirectory();
                  if (picked) setMountPath(picked);
                }}
                disabled={busy !== null}
                className="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 hover:bg-[var(--color-muted)]"
                title="Share a host folder into /persist/workspace (edit on host, run in VM)"
              >
                <FolderOpen className="h-3.5 w-3.5" /> {mountPath ? 'Change folder' : 'Share a folder…'}
              </button>
              {mountPath ? (
                <span className="inline-flex items-center gap-1 text-[var(--color-muted-foreground)]" title={mountPath}>
                  <span className="max-w-[14rem] truncate font-mono">{mountPath}</span>
                  <button
                    type="button"
                    onClick={() => setMountPath(null)}
                    className="hover:text-[var(--color-foreground)]"
                    title="Stop sharing this folder"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      {error ? (
        <div className="whitespace-pre-wrap rounded-md border border-red-500/40 bg-red-500/10 p-3 font-mono text-xs text-red-300">
          {error}
        </div>
      ) : null}

      {busy === 'up' || log.length > 0 ? (
        <pre
          ref={logRef}
          className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-black/40 p-3 font-mono text-[11px] leading-relaxed"
        >
          {log.join('\n') || 'Starting…'}
        </pre>
      ) : null}

      {status?.running && status.kubeconfigReady ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Registered as the{' '}
              <span className="font-medium text-[var(--color-foreground)]">{microVmClusterLabel(name)}</span> cluster
            </p>
            <div className="flex items-center gap-2">
              {host.terminal ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShellOpen(true)}
                  disabled={busy !== null}
                  title={
                    status.dev
                      ? 'Open a shell in the dev workspace (/persist/workspace)'
                      : 'Open a root shell on the microVM host'
                  }
                >
                  <TerminalIcon className="h-4 w-4" /> {status.dev ? 'Open dev shell' : 'Open shell'}
                </Button>
              ) : null}
              <Button variant="outline" size="sm" onClick={() => void deployHere()} disabled={busy !== null}>
                <Rocket className="h-4 w-4" /> Deploy application
              </Button>
            </div>
          </div>
          <MicroVmFacts apiServerUrl={status.apiServerUrl} clusterId={clusterId} summary={summary} />
        </>
      ) : null}

      {status?.running && status.kubeconfigReady ? <EgressPanel vm={vm} name={name} /> : null}
      {status?.running && status.kubeconfigReady ? <CredentialsPanel vm={vm} name={name} /> : null}
      {status?.running && status.kubeconfigReady ? <WorkloadsPanel engine="microvm" vmName={name} /> : null}

      {shellOpen ? (
        <TerminalDrawer
          target={name}
          engine="microvm"
          clusterName={name}
          mode={status?.dev ? 'dev' : 'host'}
          onClose={() => setShellOpen(false)}
        />
      ) : null}
    </EngineCard>
  );
}

// Compact at-a-glance facts for a running microVM — Kubernetes URL,
// cluster id, and its allocated host ports — so a VM carries the same
// weight of detail as the k3d runtime's overview cards.
function MicroVmFacts({
  apiServerUrl,
  clusterId,
  summary,
}: {
  apiServerUrl: string;
  clusterId: string;
  summary?: MicroVmSummary;
}) {
  const facts: Array<[string, React.ReactNode]> = [
    ['Kubernetes', <code className="font-mono">{apiServerUrl}</code>],
    ['Cluster id', <code className="font-mono">{clusterId}</code>],
  ];
  if (summary) {
    facts.push([
      'Ports',
      <code className="font-mono">
        ingress :{summary.hostPort} · k8s :{summary.apiPort} · registry :{summary.registryPort} · egress :
        {summary.egressPort}
      </code>,
    ]);
  }
  return (
    <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 rounded-md border border-[var(--color-border)] px-3 py-2">
      {facts.map(([label, value]) => (
        <React.Fragment key={label}>
          <dt className="text-[11px] text-[var(--color-muted-foreground)]">{label}</dt>
          <dd className="min-w-0 truncate text-[11px]">{value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/** Human label for a VM's registered cluster — mirrors
 *  microvm_cluster_label in the desktop's lib.rs. */
function microVmClusterLabel(name: string): string {
  return name === 'appliance' ? 'MicroVM Runtime' : `MicroVM Runtime (${name})`;
}

// Outbound-traffic control for the microVM: a desktop surface over the
// egress proxy's allow/deny policy + optional TLS interception. The
// engine enforces it (packages/vm egress.rs); this just edits the
// policy the proxy reloads live.
function EgressPanel({ vm, name }: { vm: MicroVmInstanceHost; name: string }) {
  const queryClient = useQueryClient();
  const egress = vm.egress;
  const [host_, setHost] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const policyQuery = useQuery({
    queryKey: ['microvm', name, 'egress'],
    queryFn: () => egress.get(),
    refetchInterval: 15_000,
  });
  const policy = policyQuery.data;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['microvm', name, 'egress'] });

  // Live traffic feed — the proxy records every request decision.
  const trafficQuery = useQuery({
    queryKey: ['microvm', name, 'egress', 'log'],
    queryFn: () => egress.log(200),
    refetchInterval: 4_000,
  });
  const events = trafficQuery.data ?? [];

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const addRule = (action: 'allow' | 'deny') => {
    const h = host_.trim();
    if (!h) return;
    setHost('');
    void act(() => egress.addRule(action, h));
  };

  return (
    <details className="rounded-md border border-[var(--color-border)] p-3">
      <summary className="cursor-pointer text-xs font-medium">
        Outbound traffic
        {policy ? (
          <span className="ml-2 text-[10px] text-[var(--color-muted-foreground)]">
            default {policy.default}
            {policy.mitm ? ' · TLS interception on' : ''}
          </span>
        ) : null}
      </summary>

      <p className="mt-2 text-[10px] text-[var(--color-muted-foreground)]">
        The microVM routes workload egress through a proxy that enforces this policy. Deny wins over allow. TLS
        interception lets the proxy see (and filter) decrypted HTTPS — workloads must trust the VM&rsquo;s CA.
      </p>

      {policy ? (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs">Default:</span>
            <div className="inline-flex overflow-hidden rounded-md border border-[var(--color-border)]">
              {(['allow', 'deny'] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  disabled={busy}
                  onClick={() => policy.default !== a && void act(() => egress.setDefault(a))}
                  className={cn(
                    'px-2 py-1 text-xs',
                    policy.default === a
                      ? a === 'deny'
                        ? 'bg-red-500/20 text-red-200'
                        : 'bg-green-500/20 text-green-200'
                      : 'text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)]'
                  )}
                >
                  {a}
                </button>
              ))}
            </div>
            <label className="ml-2 inline-flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={policy.mitm}
                disabled={busy}
                onChange={(e) => void act(() => egress.setMitm(e.target.checked))}
              />
              TLS interception
            </label>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act(() => egress.reset())}>
              Reset
            </Button>
          </div>

          {policy.mitm && policy.caPath ? (
            <p className="rounded-md border border-cyan-500/30 bg-cyan-500/5 px-2 py-1 font-mono text-[10px] text-cyan-200">
              CA: {policy.caPath} — inject into workloads to trust the interceptor
            </p>
          ) : null}

          <div className="flex items-center gap-2">
            <input
              type="text"
              value={host_}
              onChange={(e) => setHost(e.target.value)}
              placeholder="host suffix, e.g. github.com"
              className="flex-1 rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1 font-mono text-xs"
              onKeyDown={(e) => {
                if (e.key === 'Enter') addRule('allow');
              }}
            />
            <Button variant="outline" size="sm" disabled={busy || !host_.trim()} onClick={() => addRule('allow')}>
              Allow
            </Button>
            <Button variant="outline" size="sm" disabled={busy || !host_.trim()} onClick={() => addRule('deny')}>
              Deny
            </Button>
          </div>

          <RuleList label="Allowed" hosts={policy.allow} tone="green" />
          <RuleList label="Denied" hosts={policy.deny} tone="red" />

          <TrafficView
            events={events}
            policy={policy}
            busy={busy}
            onAllow={(h) => void act(() => egress.addRule('allow', h))}
            onBlock={(h) => void act(() => egress.addRule('deny', h))}
            onClear={() =>
              void egress
                .clearLog()
                .then(() => queryClient.invalidateQueries({ queryKey: ['microvm', name, 'egress', 'log'] }))
            }
          />
        </div>
      ) : (
        <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">Loading policy…</p>
      )}

      {err ? <p className="mt-2 text-xs text-red-300">{err}</p> : null}
    </details>
  );
}

// Docker-Desktop-style live traffic feed: most-recent requests the
// proxy saw, each allow/deny/mitm-tagged, with one-click allow or block
// per host that updates the policy live.
function TrafficView({
  events,
  policy,
  busy,
  onAllow,
  onBlock,
  onClear,
}: {
  events: EgressEvent[];
  policy: EgressPolicy;
  busy: boolean;
  onAllow: (host: string) => void;
  onBlock: (host: string) => void;
  onClear: () => void;
}) {
  // Newest first, capped so the panel stays compact.
  const rows = [...events].reverse().slice(0, 40);
  const tone = (d: EgressEvent['decision']) =>
    d === 'deny' ? 'text-red-300' : d === 'mitm' ? 'text-cyan-300' : 'text-green-300';
  const ruled = (host: string) =>
    policy.deny.some((s) => hostMatches(host, s))
      ? 'denied'
      : policy.allow.some((s) => hostMatches(host, s))
        ? 'allowed'
        : null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted-foreground)]">Live traffic</div>
        {events.length > 0 ? (
          <button
            type="button"
            onClick={onClear}
            className="text-[10px] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
          >
            Clear
          </button>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-[var(--color-border)] px-2 py-1.5 text-[11px] text-[var(--color-muted-foreground)]">
          No traffic yet. Requests appear here as workloads make them.
        </p>
      ) : (
        <ul className="max-h-56 space-y-0.5 overflow-auto rounded-md border border-[var(--color-border)] p-1">
          {rows.map((e, i) => {
            const status = ruled(e.host);
            return (
              <li key={`${e.ts}-${i}`} className="flex items-center gap-2 px-1 py-0.5 text-[11px]">
                <span className="w-8 shrink-0 text-right font-mono text-[10px] text-[var(--color-muted-foreground)]">
                  {relativeAge(new Date(e.ts).toISOString())}
                </span>
                <span className={cn('w-9 shrink-0 font-mono uppercase', tone(e.decision))}>{e.decision}</span>
                <span className="min-w-0 flex-1 truncate font-mono">
                  <span className="text-[var(--color-muted-foreground)]">{e.method} </span>
                  {e.host}
                  {e.path ? <span className="text-[var(--color-muted-foreground)]">{e.path}</span> : null}
                </span>
                {status === 'allowed' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onBlock(e.host)}
                    className="shrink-0 rounded border border-red-500/40 px-1.5 text-[10px] text-red-200 hover:bg-red-500/10 disabled:opacity-50"
                  >
                    Block
                  </button>
                ) : status === 'denied' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onAllow(e.host)}
                    className="shrink-0 rounded border border-green-500/40 px-1.5 text-[10px] text-green-200 hover:bg-green-500/10 disabled:opacity-50"
                  >
                    Allow
                  </button>
                ) : (
                  <span className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onAllow(e.host)}
                      className="rounded border border-green-500/40 px-1.5 text-[10px] text-green-200 hover:bg-green-500/10 disabled:opacity-50"
                    >
                      Allow
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onBlock(e.host)}
                      className="rounded border border-red-500/40 px-1.5 text-[10px] text-red-200 hover:bg-red-500/10 disabled:opacity-50"
                    >
                      Block
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Mirror of the Rust host-suffix match (egress.rs): exact host or a
 *  dot-suffix. Used to show whether a row's host is already ruled. */
function hostMatches(host: string, suffix: string): boolean {
  const h = host.trim().replace(/\.$/, '').toLowerCase();
  const s = suffix.trim().replace(/^\./, '').replace(/\.$/, '').toLowerCase();
  return s !== '' && (h === s || h.endsWith('.' + s));
}

// Per-host credential capture/injection (apiKeyHelper): the proxy can
// lift a credential header off a workload's request into a host-side
// store and/or inject it onto outbound requests, so secrets live
// outside the VM. Requires TLS interception (the proxy must see
// decrypted headers).
function CredentialsPanel({ vm, name }: { vm: MicroVmInstanceHost; name: string }) {
  const queryClient = useQueryClient();
  const creds = vm.creds;
  const egress = vm.egress;
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  // New-rule form.
  const [ruleHost, setRuleHost] = React.useState('');
  const [capture, setCapture] = React.useState(true);
  const [inject, setInject] = React.useState(true);
  const [header, setHeader] = React.useState('authorization');
  const [helper, setHelper] = React.useState('');

  const credsQuery = useQuery({
    queryKey: ['microvm', name, 'creds'],
    queryFn: () => creds.list(),
    refetchInterval: 15_000,
  });
  const policyQuery = useQuery({
    queryKey: ['microvm', name, 'egress'],
    queryFn: () => egress.get(),
    refetchInterval: 15_000,
  });
  const data = credsQuery.data;
  const mitmOn = policyQuery.data?.mitm ?? false;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['microvm', name, 'creds'] });

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const addRule = () => {
    const h = ruleHost.trim();
    if (!h) return;
    const helperCmd = helper.trim();
    setRuleHost('');
    setHelper('');
    void act(() =>
      creds.add({ host: h, capture, inject, header: header.trim() || 'authorization', helper: helperCmd || undefined })
    );
  };

  return (
    <details className="rounded-md border border-[var(--color-border)] p-3">
      <summary className="cursor-pointer text-xs font-medium">
        Credentials
        {data ? (
          <span className="ml-2 text-[10px] text-[var(--color-muted-foreground)]">
            {data.rules.length} rule{data.rules.length === 1 ? '' : 's'} · {data.secrets.length} stored
          </span>
        ) : null}
      </summary>

      <p className="mt-2 text-[10px] text-[var(--color-muted-foreground)]">
        Per host, capture a credential header into a host-side store (outside the VM) and/or inject it onto outbound
        requests — so workloads never hold the secret. Injection can source from a stored secret or an{' '}
        <code className="font-mono">apiKeyHelper</code> command. Requires TLS interception.
      </p>

      {!mitmOn ? (
        <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-2 py-1 text-[11px] text-amber-200">
          TLS interception is off — enable it under Outbound traffic for capture/injection to take effect.
        </p>
      ) : null}

      <div className="mt-3 space-y-3">
        {/* Add-rule form */}
        <div className="space-y-2 rounded-md border border-[var(--color-border)] p-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={ruleHost}
              onChange={(e) => setRuleHost(e.target.value)}
              placeholder="host, e.g. api.openai.com"
              className="flex-1 rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1 font-mono text-xs"
            />
            <input
              type="text"
              value={header}
              onChange={(e) => setHeader(e.target.value)}
              placeholder="header"
              className="w-28 rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1 font-mono text-xs"
            />
          </div>
          <input
            type="text"
            value={helper}
            onChange={(e) => setHelper(e.target.value)}
            placeholder="apiKeyHelper command (optional) — stdout is the credential"
            className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1 font-mono text-xs"
          />
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={capture} onChange={(e) => setCapture(e.target.checked)} /> Capture
            </label>
            <label className="inline-flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={inject} onChange={(e) => setInject(e.target.checked)} /> Inject
            </label>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              disabled={busy || !ruleHost.trim()}
              onClick={addRule}
            >
              <Plus className="h-3.5 w-3.5" /> Add rule
            </Button>
          </div>
        </div>

        {/* Rules */}
        {data && data.rules.length > 0 ? (
          <ul className="space-y-1">
            {data.rules.map((r) => (
              <li
                key={r.host}
                className="flex items-center gap-2 rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px]"
              >
                <span className="min-w-0 flex-1 truncate font-mono">{r.host}</span>
                <span className="shrink-0 font-mono text-[10px] text-[var(--color-muted-foreground)]">{r.header}</span>
                {r.capture ? (
                  <span className="shrink-0 rounded bg-cyan-500/15 px-1 text-[10px] text-cyan-300">capture</span>
                ) : null}
                {r.inject ? (
                  <span className="shrink-0 rounded bg-green-500/15 px-1 text-[10px] text-green-300">inject</span>
                ) : null}
                {r.helper ? (
                  <span className="shrink-0 rounded bg-[var(--color-muted)] px-1 text-[10px]">helper</span>
                ) : null}
                <button
                  type="button"
                  aria-label={`Remove ${r.host}`}
                  disabled={busy}
                  onClick={() => void act(() => creds.remove(r.host))}
                  className="shrink-0 rounded p-0.5 text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] disabled:opacity-50"
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {/* Stored secrets */}
        {data && data.secrets.length > 0 ? (
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wide text-[var(--color-muted-foreground)]">
                Stored secrets
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(() => creds.forget())}
                className="text-[10px] text-[var(--color-muted-foreground)] hover:text-red-300"
              >
                Forget all
              </button>
            </div>
            <ul className="space-y-0.5">
              {data.secrets.map((s) => (
                <li key={`${s.host}:${s.header}`} className="flex items-center gap-2 px-1 text-[11px]">
                  <span className="min-w-0 flex-1 truncate font-mono">{s.host}</span>
                  <span className="font-mono text-[10px] text-[var(--color-muted-foreground)]">{s.header}</span>
                  <span className="font-mono text-[10px] text-cyan-300">{s.masked}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {err ? <p className="mt-2 text-xs text-red-300">{err}</p> : null}
    </details>
  );
}

function RuleList({ label, hosts, tone }: { label: string; hosts: string[]; tone: 'green' | 'red' }) {
  if (hosts.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-muted-foreground)]">{label}</div>
      <ul className="flex flex-wrap gap-1.5">
        {hosts.map((h) => (
          <li
            key={h}
            className={cn(
              'rounded-md border px-1.5 py-0.5 font-mono text-[11px]',
              tone === 'green' ? 'border-green-500/30 text-green-200' : 'border-red-500/30 text-red-200'
            )}
          >
            {h}
          </li>
        ))}
      </ul>
    </div>
  );
}

type Phase = 'unknown' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error' | 'partial';

// A prerequisite is "ready" when it's installed AND — for docker — its
// daemon is actually reachable. `daemonRunning` is undefined for tools
// with no daemon (k3d, kubectl), so `!== false` leaves those as ready
// on install alone.
function checkReady(c: LocalPreflightCheck): boolean {
  return c.installed && c.daemonRunning !== false;
}

function PreflightPanel({
  checks,
  loading,
  onRefresh,
  canInstall,
  onInstall,
  canStartRuntime,
  onStartRuntime,
}: {
  checks: LocalPreflightCheck[];
  loading: boolean;
  onRefresh: () => void;
  canInstall: boolean;
  onInstall: (tool: string) => Promise<void>;
  canStartRuntime: boolean;
  onStartRuntime: () => Promise<void>;
}) {
  // While preflight is in flight (and we have no cached result), keep
  // the panel out of the layout — the controls below already render a
  // disabled Start button, and a flicker of "Checking…" before the
  // first result tends to be more noisy than informative.
  if (loading && checks.length === 0) return null;
  if (checks.length === 0) return null;
  const notReady = checks.filter((c) => !checkReady(c));
  // When everything's installed and the only thing wrong is a stopped
  // daemon, the panel is about starting the runtime, not installing —
  // reword the heading so it doesn't tell the user to install tools
  // they already have.
  const onlyDaemonDown = notReady.length > 0 && notReady.every((c) => c.installed);
  if (notReady.length === 0) {
    return (
      <section className="flex items-center justify-between gap-3 rounded-md border border-green-500/40 bg-green-500/10 px-3 py-2 text-xs text-green-300">
        <span className="inline-flex items-center gap-2">
          <Check className="h-3.5 w-3.5" />
          Prerequisites ready: {checks.map((c) => c.tool).join(', ')}
        </span>
        <Button variant="ghost" size="icon" aria-label="Re-check prerequisites" onClick={onRefresh}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </Button>
      </section>
    );
  }
  return (
    <section className="space-y-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-300" />
          <div>
            <h2 className="text-sm font-semibold text-amber-200">
              {onlyDaemonDown ? 'Start the container runtime' : 'Install required tools'}
            </h2>
            <p className="mt-0.5 text-xs text-amber-200/80">
              {onlyDaemonDown
                ? 'The local runtime needs a running Docker daemon. Start it below, then re-check.'
                : 'The local runtime drives a real Docker + k3d + kubectl stack. Install the missing tools below, then re-check.'}
            </p>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onRefresh}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /> Re-check
        </Button>
      </header>
      <ul className="space-y-2">
        {checks.map((c) => (
          <PreflightRow
            key={c.tool}
            check={c}
            canInstall={canInstall && c.autoInstallable}
            onInstall={onInstall}
            canStartRuntime={canStartRuntime}
            onStartRuntime={onStartRuntime}
          />
        ))}
      </ul>
    </section>
  );
}

function PreflightRow({
  check,
  canInstall,
  onInstall,
  canStartRuntime,
  onStartRuntime,
}: {
  check: LocalPreflightCheck;
  canInstall: boolean;
  onInstall: (tool: string) => Promise<void>;
  canStartRuntime: boolean;
  onStartRuntime: () => Promise<void>;
}) {
  const [copied, setCopied] = React.useState(false);
  const [installing, setInstalling] = React.useState(false);
  const [installError, setInstallError] = React.useState<string | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [startError, setStartError] = React.useState<string | null>(null);

  const ready = checkReady(check);
  // Installed CLI, but no reachable daemon — the "start your runtime"
  // state, distinct from "not installed".
  const daemonDown = check.installed && check.daemonRunning === false;

  const onCopy = async () => {
    if (!check.installHint || typeof navigator === 'undefined' || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(check.installHint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard permission denied or unavailable — leave the hint
      // visible and let the user copy it manually.
    }
  };

  const onClickInstall = async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      await onInstall(check.tool);
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };

  const onClickStart = async () => {
    setStarting(true);
    setStartError(null);
    try {
      await onStartRuntime();
    } catch (err) {
      // Surfaces the backend's actionable message (e.g. colima failed,
      // or this runtime can't be auto-started).
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  return (
    <li
      className={cn(
        'rounded-md border px-3 py-2 text-xs',
        ready ? 'border-green-500/30 bg-green-500/5' : 'border-amber-500/30 bg-amber-500/10'
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 font-medium">
            {ready ? <Check className="h-3.5 w-3.5 text-green-300" /> : <X className="h-3.5 w-3.5 text-amber-300" />}
            <code className="font-mono">{check.tool}</code>
            {check.version ? <span className="text-[var(--color-muted-foreground)]">— {check.version}</span> : null}
            {daemonDown ? <span className="text-amber-300">— not running</span> : null}
          </div>
          <p className="mt-1 text-[var(--color-muted-foreground)]">{check.purpose}</p>
          {daemonDown ? (
            <div className="mt-2 space-y-2">
              {canStartRuntime && check.daemonStartable ? (
                <Button onClick={onClickStart} disabled={starting} size="sm">
                  <Play className={cn('h-3.5 w-3.5', starting && 'animate-pulse')} />
                  {starting ? 'Starting…' : 'Start runtime'}
                </Button>
              ) : null}
              {check.error ? <p className="text-[var(--color-muted-foreground)]">{check.error}</p> : null}
              {startError ? <p className="font-mono text-[10px] text-red-300">{startError}</p> : null}
            </div>
          ) : null}
          {!check.installed ? (
            <div className="mt-2 space-y-2">
              {canInstall ? (
                <div>
                  <Button onClick={onClickInstall} disabled={installing} size="sm">
                    <Download className={cn('h-3.5 w-3.5', installing && 'animate-pulse')} />
                    {installing ? 'Installing…' : `Install ${check.tool}`}
                  </Button>
                  <p className="mt-1 text-[10px] text-[var(--color-muted-foreground)]">
                    Downloads from the upstream release into <code>~/.appliance/bin/</code>. No admin password needed.
                  </p>
                </div>
              ) : null}
              {check.installHint ? (
                <div>
                  {canInstall ? (
                    <p className="text-[10px] uppercase tracking-wide text-[var(--color-muted-foreground)]">
                      Or install manually:
                    </p>
                  ) : null}
                  <div className="mt-1 flex items-center gap-2">
                    <code className="block flex-1 overflow-x-auto rounded bg-black/40 px-2 py-1 font-mono text-[11px]">
                      {check.installHint}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={onCopy}
                      aria-label={`Copy install command for ${check.tool}`}
                    >
                      <Copy className="h-3 w-3" />
                      {copied ? 'Copied' : 'Copy'}
                    </Button>
                  </div>
                </div>
              ) : null}
              {installError ? (
                <p className="font-mono text-[10px] text-red-300">{installError}</p>
              ) : check.error ? (
                <p className="font-mono text-[10px] text-amber-200/80">{check.error}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function derivePhase(
  status: LocalRuntimeStatus | undefined,
  starting: boolean,
  stopping: boolean,
  deleting: boolean
): Phase {
  if (starting) return 'starting';
  if (stopping || deleting) return 'stopping';
  if (!status) return 'unknown';
  const clusterUp = status.cluster.exists && status.cluster.running;
  const serverUp = status.apiServer.running;
  if (clusterUp && serverUp) return 'running';
  if (!clusterUp && !serverUp) return 'stopped';
  if (status.cluster.message || status.apiServer.message) return 'error';
  return 'partial';
}

function PhaseBadge({ phase }: { phase: Phase }) {
  const meta: Record<Phase, { label: string; tone: string }> = {
    unknown: { label: 'Unknown', tone: 'bg-[var(--color-muted)] text-[var(--color-muted-foreground)]' },
    starting: { label: 'Starting', tone: 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/40' },
    running: { label: 'Running', tone: 'bg-green-500/15 text-green-300 border border-green-500/40' },
    stopping: { label: 'Stopping', tone: 'bg-amber-500/15 text-amber-300 border border-amber-500/40' },
    stopped: { label: 'Stopped', tone: 'bg-[var(--color-muted)] text-[var(--color-muted-foreground)]' },
    error: { label: 'Error', tone: 'bg-red-500/15 text-red-300 border border-red-500/40' },
    partial: { label: 'Degraded', tone: 'bg-amber-500/15 text-amber-300 border border-amber-500/40' },
  };
  const m = meta[phase];
  return (
    <span className={cn('inline-flex items-center rounded-md px-2 py-1 text-xs font-medium', m.tone)}>{m.label}</span>
  );
}

function MutationErrors({ errors }: { errors: Array<unknown> }) {
  const visible = errors.filter(Boolean) as Error[];
  if (visible.length === 0) return null;
  return (
    <div className="space-y-1 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">
      {visible.map((e, i) => (
        <div key={i} className="whitespace-pre-wrap font-mono">
          {e.message ?? String(e)}
        </div>
      ))}
    </div>
  );
}

function RuntimeOverview({ status }: { status: LocalRuntimeStatus }) {
  const { cluster, apiServer, config, clusterId } = status;
  return (
    <section className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <Card title="Cluster">
        <Row label="Status" value={cluster.running ? 'Running' : cluster.exists ? 'Stopped' : 'Not created'} />
        <Row label="Name" value={<code className="font-mono text-xs">{cluster.clusterName}</code>} />
        <Row label="Host port" value={<code className="font-mono text-xs">:{config.hostPort}</code>} />
        <Row
          label="NodePort range"
          value={
            <code className="font-mono text-xs">
              {config.nodePortMin}-{config.nodePortMax}
            </code>
          }
        />
        {cluster.message ? (
          <Row label="Message" value={<span className="text-amber-300">{cluster.message}</span>} />
        ) : null}
      </Card>

      <Card title="API server">
        <Row label="Status" value={apiServer.running ? 'Running' : 'Stopped'} />
        <Row label="URL" value={<code className="font-mono text-xs">{config.apiServerUrl}</code>} />
        {apiServer.pid !== undefined ? (
          <Row label="PID" value={<code className="font-mono text-xs">{apiServer.pid}</code>} />
        ) : null}
        {apiServer.startedAt ? (
          <Row
            label="Started"
            value={<span className="text-xs">{new Date(apiServer.startedAt).toLocaleString()}</span>}
          />
        ) : null}
        {apiServer.logPath ? (
          <Row label="Log" value={<code className="truncate font-mono text-xs">{apiServer.logPath}</code>} />
        ) : null}
        {apiServer.message ? (
          <Row label="Message" value={<span className="text-amber-300">{apiServer.message}</span>} />
        ) : null}
      </Card>

      <Card title="Storage">
        <Row label="Data dir" value={<code className="break-all font-mono text-xs">{config.dataDir}</code>} />
        <Row label="Namespace" value={<code className="font-mono text-xs">{config.namespace}</code>} />
      </Card>

      <Card title="Console wiring">
        <Row
          label="Cluster id"
          value={
            clusterId ? (
              <code className="font-mono text-xs">{clusterId}</code>
            ) : (
              <span className="text-[var(--color-muted-foreground)]">Not registered yet — press Start</span>
            )
          }
        />
        <Row label="Bound to" value={<code className="font-mono text-xs">{config.apiServerUrl}</code>} />
      </Card>
    </section>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-md border border-[var(--color-border)] p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      <dl className="space-y-2">{children}</dl>
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] items-baseline gap-3">
      <dt className="text-xs text-[var(--color-muted-foreground)]">{label}</dt>
      <dd className="min-w-0 text-sm">{value}</dd>
    </div>
  );
}

function WorkloadsPanel({ engine, vmName }: { engine?: 'microvm'; vmName?: string }) {
  const host = useHost();
  const [activePod, setActivePod] = React.useState<LocalPodInfo | null>(null);
  const [shellPod, setShellPod] = React.useState<LocalPodInfo | null>(null);
  // For the microVM engine, clusterName carries the VM name so the host
  // resolves that VM's kubeconfig (multiple VMs run concurrently).
  const workloadsQuery = useQuery({
    queryKey: ['local-runtime', 'workloads', engine ?? 'k3d', vmName ?? ''],
    queryFn: () => host.local!.listWorkloads(engine ? { engine, clusterName: vmName } : undefined),
    refetchInterval: 5_000,
  });

  const data = workloadsQuery.data;
  const empty = data && data.deployments.length === 0 && data.pods.length === 0 && data.services.length === 0;

  return (
    <>
      <section className="space-y-3 rounded-md border border-[var(--color-border)] p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            {engine === 'microvm' ? `Workloads · ${vmName ?? 'appliance'}` : 'Workloads'}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh workloads"
            onClick={() => workloadsQuery.refetch()}
            disabled={workloadsQuery.isFetching}
          >
            <RefreshCw className={cn('h-4 w-4', workloadsQuery.isFetching && 'animate-spin')} />
          </Button>
        </div>

        {workloadsQuery.isLoading ? (
          <p className="text-xs text-[var(--color-muted-foreground)]">Loading…</p>
        ) : workloadsQuery.isError ? (
          <p className="text-xs text-red-300">{(workloadsQuery.error as Error).message}</p>
        ) : empty ? (
          <p className="text-xs text-[var(--color-muted-foreground)]">
            No workloads yet. Deploy an appliance via Projects → Deployments to see it here.
          </p>
        ) : data ? (
          <div className="space-y-5">
            <DeploymentsTable deployments={data.deployments} />
            <PodsTable pods={data.pods} onLogs={setActivePod} onShell={host.terminal ? setShellPod : undefined} />
            <ServicesTable services={data.services} />
          </div>
        ) : null}
      </section>

      {activePod ? (
        <PodLogsDrawer pod={activePod} engine={engine} vmName={vmName} onClose={() => setActivePod(null)} />
      ) : null}
      {shellPod ? (
        <TerminalDrawer target={shellPod.name} engine={engine} clusterName={vmName} onClose={() => setShellPod(null)} />
      ) : null}
    </>
  );
}

function DeploymentsTable({ deployments }: { deployments: LocalDeploymentInfo[] }) {
  if (deployments.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-[var(--color-muted-foreground)]">Deployments</div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-[var(--color-muted-foreground)]">
          <tr>
            <th className="py-1 pr-3">Name</th>
            <th className="py-1 pr-3">Image</th>
            <th className="py-1 pr-3">Replicas</th>
            <th className="py-1 pr-3">Age</th>
          </tr>
        </thead>
        <tbody>
          {deployments.map((d) => (
            <tr key={d.name} className="border-t border-[var(--color-border)]">
              <td className="py-1.5 pr-3 font-medium">{d.name}</td>
              <td className="py-1.5 pr-3 font-mono text-xs">{d.image ?? <em>—</em>}</td>
              <td className="py-1.5 pr-3">
                <span className={d.ready === d.desired ? 'text-green-300' : 'text-amber-300'}>
                  {d.ready}/{d.desired}
                </span>
              </td>
              <td className="py-1.5 pr-3 text-xs text-[var(--color-muted-foreground)]">{relativeAge(d.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PodsTable({
  pods,
  onLogs,
  onShell,
}: {
  pods: LocalPodInfo[];
  onLogs: (pod: LocalPodInfo) => void;
  onShell?: (pod: LocalPodInfo) => void;
}) {
  if (pods.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-[var(--color-muted-foreground)]">Pods</div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-[var(--color-muted-foreground)]">
          <tr>
            <th className="py-1 pr-3">Name</th>
            <th className="py-1 pr-3">Phase</th>
            <th className="py-1 pr-3">Ready</th>
            <th className="py-1 pr-3">Restarts</th>
            <th className="py-1 pr-3">Age</th>
            <th className="py-1 pr-3" />
          </tr>
        </thead>
        <tbody>
          {pods.map((p) => (
            <tr key={p.name} className="border-t border-[var(--color-border)]">
              <td className="py-1.5 pr-3 font-medium">{p.name}</td>
              <td className="py-1.5 pr-3">
                <span className={p.phase === 'Running' ? 'text-green-300' : 'text-amber-300'}>{p.phase}</span>
              </td>
              <td className="py-1.5 pr-3">{p.ready ? '✓' : '—'}</td>
              <td className="py-1.5 pr-3">{p.restartCount}</td>
              <td className="py-1.5 pr-3 text-xs text-[var(--color-muted-foreground)]">{relativeAge(p.createdAt)}</td>
              <td className="py-1.5 pr-3 text-right">
                <div className="flex items-center justify-end gap-1">
                  {onShell && p.phase === 'Running' ? (
                    <Button variant="ghost" size="sm" onClick={() => onShell(p)}>
                      <TerminalIcon className="h-3.5 w-3.5" /> Shell
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="sm" onClick={() => onLogs(p)}>
                    <FileText className="h-3.5 w-3.5" /> Logs
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ServicesTable({ services }: { services: LocalServiceInfo[] }) {
  if (services.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-[var(--color-muted-foreground)]">Services</div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-[var(--color-muted-foreground)]">
          <tr>
            <th className="py-1 pr-3">Name</th>
            <th className="py-1 pr-3">Type</th>
            <th className="py-1 pr-3">Cluster IP</th>
            <th className="py-1 pr-3">NodePort</th>
            <th className="py-1 pr-3">URL</th>
          </tr>
        </thead>
        <tbody>
          {services.map((s) => {
            const url = s.nodePort ? `http://localhost:${s.nodePort}` : null;
            return (
              <tr key={s.name} className="border-t border-[var(--color-border)]">
                <td className="py-1.5 pr-3 font-medium">{s.name}</td>
                <td className="py-1.5 pr-3 text-xs">{s.serviceType}</td>
                <td className="py-1.5 pr-3 font-mono text-xs">{s.clusterIp ?? '—'}</td>
                <td className="py-1.5 pr-3 font-mono text-xs">{s.nodePort ?? '—'}</td>
                <td className="py-1.5 pr-3 font-mono text-xs">
                  {url ? (
                    <a
                      className="underline hover:text-[var(--color-accent)]"
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {url}
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PodLogsDrawer({
  pod,
  engine,
  vmName,
  onClose,
}: {
  pod: LocalPodInfo;
  engine?: 'microvm';
  vmName?: string;
  onClose: () => void;
}) {
  const host = useHost();
  const logsQuery = useQuery({
    queryKey: ['local-runtime', 'logs', engine ?? 'k3d', vmName ?? '', pod.name],
    queryFn: () => host.local!.tailPodLogs({ podName: pod.name, tailLines: 500, engine, clusterName: vmName }),
  });
  const logs = logsQuery.data ?? '';

  const copy = async () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(logs);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-4 md:items-center"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex h-[70vh] w-full max-w-4xl flex-col overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-background)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Logs for ${pod.name}`}
      >
        <header className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2">
          <div>
            <div className="text-sm font-semibold">Pod logs</div>
            <div className="font-mono text-xs text-[var(--color-muted-foreground)]">{pod.name}</div>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" onClick={() => logsQuery.refetch()} disabled={logsQuery.isFetching}>
              <RefreshCw className={cn('h-3.5 w-3.5', logsQuery.isFetching && 'animate-spin')} /> Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={copy}>
              <Copy className="h-3.5 w-3.5" /> Copy
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </header>
        <pre className="flex-1 overflow-auto whitespace-pre-wrap bg-black/40 p-3 font-mono text-xs leading-relaxed">
          {logsQuery.isLoading
            ? 'Loading…'
            : logsQuery.isError
              ? (logsQuery.error as Error).message
              : logs || <span className="text-[var(--color-muted-foreground)]">No log lines yet.</span>}
        </pre>
      </div>
    </div>
  );
}

function relativeAge(iso?: string): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}
