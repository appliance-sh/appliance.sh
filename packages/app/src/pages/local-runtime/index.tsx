import * as React from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Bot,
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
import { createApplianceClient, type ApplianceClient } from '@appliance.sh/sdk/client';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { AgentLoginPanel } from '@/components/agent-login';
import { useHost } from '@/providers/host-provider';
import { useTerminalSessions, mintAgentSessionId, agentSessionKey } from '@/providers/terminal-sessions-provider';
import { useApplianceClient } from '@/hooks/use-appliance-client';
import { cn } from '@/lib/utils';
import { microVmClusterId, NETSTACK_BAKED_ALLOWLIST } from '@/lib/host';
import type {
  AgentAuthStatus,
  EgressEvent,
  EgressPolicy,
  LocalDeploymentInfo,
  LocalPodInfo,
  LocalPreflightCheck,
  LocalServiceInfo,
  MicroVmInstanceHost,
  MicroVmStatus,
  MicroVmSummary,
} from '@/lib/host';

// Docker Desktop-style overview page for the local runtime, sandboxed
// in a microVM Appliance boots itself. Surfaces the prerequisite
// preflight, then a card per microVM (lifecycle, egress, credentials,
// and live workloads with per-pod log tails). All wiring goes through
// `host.vm.*` + `host.local.*` — implemented by the Tauri shell (the
// web host can't shell out).
export function LocalRuntimePage() {
  const host = useHost();
  const local = host.local;
  const supported = Boolean(host.vm);

  // Preflight: ask the host which of docker/kubectl are installed.
  // Image builds shell out to docker and workload/log reads to kubectl;
  // if either is missing the relevant action would surface a cryptic
  // "failed to spawn" error. We render an actionable install panel
  // instead. Polled lazily so installing a tool in a separate terminal
  // is reflected within a few seconds without requiring a page reload.
  const preflightQuery = useQuery({
    queryKey: ['local-runtime', 'preflight'],
    enabled: supported && Boolean(local?.preflight),
    queryFn: () => local!.preflight(),
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!data) return 5_000;
      // Keep polling while anything's not ready — including docker
      // installed-but-daemon-down — so starting a tool in another
      // window clears the panel within a few seconds.
      return data.every(checkReady) ? false : 5_000;
    },
  });
  const preflightChecks = preflightQuery.data ?? [];

  // The header's Deploy button serves every microVM — the wizard
  // targets the selected cluster, so it's useful as soon as any VM is
  // up. The VM list drives both the deploy gate and the per-VM panels.
  const vmListQuery = useQuery({
    queryKey: ['microvm', 'list'],
    enabled: Boolean(host.vm),
    queryFn: () => host.vm!.list(),
    refetchInterval: 8_000,
  });
  const vms = vmListQuery.data ?? [];
  const anyVmRunning = vms.some((v) => v.running);
  const canDeploy = anyVmRunning;

  if (!supported) {
    return (
      <div className="max-w-2xl space-y-4">
        <h1 className="text-xl font-semibold">Local Runtime</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          This shell can&rsquo;t drive a local runtime — it&rsquo;s only available in the desktop app.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Local runtime</h1>
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            Run appliances on this machine, sandboxed in a virtual machine. Each VM registers as a regular cluster you
            can deploy to and switch between.
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

      <EnginesSection showMicroVm={Boolean(host.vm)} vms={vms} loading={vmListQuery.isLoading} />
    </div>
  );
}

// A consistent card shell for every microVM — name + engine tag +
// status pill, rendered with identical chrome.
function EngineCard({
  name,
  engine,
  statusPill,
  description,
  headerTag,
  children,
}: {
  name: string;
  engine: 'microVM';
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

// How the runtime is hosted — sandboxed in a VM. Informational framing;
// the prop stays engine-keyed so callers don't have to translate.
function EngineTag({ engine: _engine }: { engine: 'microVM' }) {
  return <span className="rounded bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-medium text-cyan-300">sandboxed</span>;
}

// ---- engines (microVMs) -------------------------------------------------
//
// One card per microVM. Appliance can run several microVMs at once —
// e.g. one for interactive development and another dedicated to traffic
// testing — each its own isolated VM on its own host ports, registered
// as its own cluster. The default "appliance" VM is always surfaced
// (even before it's created) and a New VM control adds more.
function EnginesSection({
  vms,
  loading,
  showMicroVm,
}: {
  vms: MicroVmSummary[];
  loading: boolean;
  showMicroVm: boolean;
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
// switcher, and workload views treat it like any other target.
function MicroVmPanel({ name, summary }: { name: string; summary?: MicroVmSummary }) {
  const host = useHost();
  const terminals = useTerminalSessions();
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

  const [busy, setBusy] = React.useState<'install' | 'up' | 'stop' | 'delete' | null>(null);
  const [log, setLog] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  // Whether the next Start should provision a dev environment. Forced on
  // once the VM is already a dev VM (the engine flag is one-way).
  const [devMode, setDevMode] = React.useState(false);
  // Host folder to share into /persist/workspace on the next dev boot.
  const [mountPath, setMountPath] = React.useState<string | null>(null);
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

  // Cluster-ready probe: the engine's `kubeconfigReady` says the VM's
  // host process is up and k3s answers, but "ready" for the console
  // means the in-VM api-server is actually serving — that's what every
  // other view reads through. Probe its unauthenticated `/healthz` (a
  // base-URL HTTP check, no kubectl) once the VM reports ready; the
  // badge reads `running` only when both agree. healthz is unsigned, so
  // a bare client over the VM's apiServerUrl suffices.
  const healthClient = React.useMemo(
    () => (status?.apiServerUrl ? createApplianceClient({ baseUrl: status.apiServerUrl }) : null),
    [status?.apiServerUrl]
  );
  const healthzQuery = useQuery({
    queryKey: ['microvm', name, 'healthz', status?.apiServerUrl ?? ''],
    enabled: Boolean(healthClient) && microVmReady,
    queryFn: async () => {
      const res = await healthClient!.healthz();
      return res.success;
    },
    // Poll quickly until the api-server answers, then back off.
    refetchInterval: (q) => (q.state.data === true ? 15_000 : 3_000),
  });
  const clusterServing = microVmReady && healthzQuery.data === true;

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
          ? // The host process being up is not the same as the cluster
            // being ready: k3s may still be coming up, the in-VM
            // api-server may not be serving yet, or bring-up may have
            // errored. Reflect that instead of a blunt "running".
            status.phase === 'failed'
            ? 'failed'
            : clusterServing
              ? 'running'
              : 'starting…'
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
            : state === 'failed'
              ? 'border border-red-500/40 bg-red-500/15 text-red-300'
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
            disabled={busy !== null || status?.running === true}
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
                  onClick={() =>
                    terminals.openSession({
                      target: name,
                      engine: 'microvm',
                      clusterName: name,
                      mode: status.dev ? 'dev' : 'host',
                    })
                  }
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
              {host.terminal && host.vm ? (
                <LaunchAgentButton
                  name={name}
                  // Agents run in (and write their registry to) the shared
                  // workspace, so a VM without one can't host them. Rather
                  // than omit the control (and make the feature undiscoverable),
                  // render it disabled with the reason — start the VM as a dev
                  // environment with a shared folder to enable it.
                  disabledReason={
                    status.devMount ? null : 'VM has no shared workspace — start it as a dev environment to run agents'
                  }
                />
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
      {clusterServing ? <WorkloadsPanel clusterId={clusterId} vmName={name} /> : null}
    </EngineCard>
  );
}

// "Launch agent" (Phase 5, A5): spawn a Claude Code agent into the VM's
// shared workspace and attach it as an agent-typed dock tab to observe +
// steer it. The Anthropic key is brokered host-side and never enters the
// VM — run `appliance agent login` once to store it. The detached,
// broker-wired `agent-<id>` tmux session is created first (so it exists),
// then the observe tab attaches to it via the reattachable host-shell
// transport. Only rendered for dev VMs with a shared workspace folder.
function LaunchAgentButton({ name, disabledReason }: { name: string; disabledReason?: string | null }) {
  const host = useHost();
  const terminals = useTerminalSessions();
  const agentAuth = host.agentAuth;
  const [open, setOpen] = React.useState(false);
  const [task, setTask] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  // Host-side credential status (L3). Null while unknown (still loading, or
  // the web shell has no `agentAuth`); when the desktop reports `configured:
  // false`, the launcher shows the in-app login affordance instead of the
  // task input — so a desktop-only user can authenticate without a terminal
  // rather than hitting the keyless 502.
  const [authStatus, setAuthStatus] = React.useState<AgentAuthStatus | null>(null);
  // Synchronous re-entrancy latch: the `busy` state in the keydown closure
  // is stale within the same tick, so a rapid double-Enter could fire two
  // launches before the first re-render disables the input. The ref flips
  // before any await, so the second Enter is dropped.
  const launchingRef = React.useRef(false);

  // Refresh the credential status when the launcher opens (and after a login
  // or a keyless failure), so the gate reflects the live host store.
  const refreshAuth = React.useCallback(() => {
    if (!agentAuth) return;
    void agentAuth
      .status()
      .then(setAuthStatus)
      .catch(() => setAuthStatus(null));
  }, [agentAuth]);
  React.useEffect(() => {
    if (open) refreshAuth();
  }, [open, refreshAuth]);

  const needsLogin = Boolean(agentAuth) && authStatus !== null && !authStatus.configured;

  const launch = async () => {
    if (launchingRef.current) return;
    launchingRef.current = true;
    setBusy(true);
    setErr(null);
    try {
      const sessionId = mintAgentSessionId();
      const t = task.trim() || undefined;
      // Spawn the agent FIRST so its tmux session exists, then attach the
      // observe tab — attaching first would create an empty shell session
      // under the agent id instead of reattaching the agent.
      await host.vm!.instance(name).agent.start({ type: 'claude-code', task: t, sessionId });
      terminals.openSession({
        target: name,
        engine: 'microvm',
        clusterName: name,
        mode: 'host',
        // Distinct de-dupe namespace so a plain "Open shell" on this VM
        // can't focus/steal the agent tab (and vice versa).
        sessionKey: agentSessionKey(sessionId),
        sessionId,
        // The desktop launcher only spawns interactive agents — tag the mode
        // so the tab badge shows a steady "attached" glyph instead of the
        // perpetual "working" spinner reserved for autonomous runs.
        agent: { type: 'claude-code', status: 'running', mode: 'interactive' },
        title: t ? `Agent · ${t}` : 'Agent · claude-code',
      });
      setOpen(false);
      setTask('');
    } catch (e) {
      // Surfaces the CLI's stderr verbatim — most often "No Anthropic key
      // configured". Re-check the host store so a keyless failure flips the
      // launcher to the in-app login affordance.
      setErr(e instanceof Error ? e.message : String(e));
      refreshAuth();
    } finally {
      setBusy(false);
      launchingRef.current = false;
    }
  };

  if (!open) {
    // Gating-off: when the VM has no shared workspace the agent can't run,
    // but keep the control visible (disabled) so the feature stays
    // discoverable rather than silently absent — AND make the reason
    // genuinely reachable (Devon). `buttonVariants` sets
    // `disabled:pointer-events-none`, so a disabled button swallows hover:
    // its native `title` tooltip never fires and it can't be focused or
    // announced. So (a) wrap it in a `<span title>` that keeps
    // pointer-events (the tooltip now fires on the span), and (b) render
    // the reason as adjacent muted text so it reaches everyone regardless.
    if (disabledReason) {
      return (
        <span className="inline-flex items-center gap-2" title={disabledReason}>
          <Button variant="outline" size="sm" disabled>
            <Bot className="h-4 w-4" /> Run agent
          </Button>
          <span role="note" className="max-w-[18rem] text-[11px] leading-snug text-[var(--color-muted-foreground)]">
            {disabledReason}
          </span>
        </span>
      );
    }
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        title="Run a Claude Code agent in the workspace and observe it in a tab"
      >
        <Bot className="h-4 w-4" /> Run agent
      </Button>
    );
  }
  // Keyless gate (L3): the desktop reports no stored credential, so offer the
  // in-app login (API key OR Sign in with Claude) right here instead of
  // letting the launch fail at the broker. The credential is brokered in and
  // never enters the VM.
  if (needsLogin) {
    return (
      <div className="flex max-w-md flex-col items-start gap-2">
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Sign in to run agents — your Anthropic credential is stored on this machine and brokered in; it never enters
          the VM.
        </p>
        <AgentLoginPanel onAuthenticated={setAuthStatus} />
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex items-center gap-2">
        <input
          autoFocus
          type="text"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="task (optional) — e.g. fix the failing test"
          className="w-64 rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1 text-xs"
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void launch();
            if (e.key === 'Escape') setOpen(false);
          }}
        />
        <Button size="sm" onClick={() => void launch()} disabled={busy}>
          <Bot className={cn('h-3.5 w-3.5', busy && 'animate-pulse')} /> {busy ? 'Starting…' : 'Run'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
      {/* A keyless failure flips the launcher to the login affordance above;
          any other error shows here as an alert. */}
      {err ? (
        <p role="alert" className="max-w-[28rem] font-mono text-[10px] text-red-300">
          {err}
        </p>
      ) : null}
      <p className="text-[10px] text-[var(--color-muted-foreground)]">
        Runs <code className="font-mono">claude</code> in the shared workspace — your Anthropic credential is brokered
        in and never enters the VM.{' '}
        {agentAuth ? (
          authStatus?.configured ? (
            <>
              Signed in
              {authStatus.kind ? ` (${authStatus.kind === 'oauth' ? 'Claude subscription' : 'API key'})` : ''} — manage
              in Settings.
            </>
          ) : null
        ) : (
          <>
            Store your key once with <code className="font-mono">appliance agent login</code>.
          </>
        )}
      </p>
      {/* Honest-limits caveat (Parker): the key is brokered, but the
          workspace is not. Surface the blast radius where the user launches
          so a throwaway sandbox isn't mistaken for a security jail. */}
      <p className="text-[10px] text-amber-300/90">
        ⚠ Sandbox is throwaway, not a jail — the agent can read/write your mounted workspace.
      </p>
    </div>
  );
}

// Compact at-a-glance facts for a running microVM — Kubernetes URL,
// cluster id, and its allocated host ports.
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

// Guest egress firewall surface (egress-firewall F4): show whether the
// VM's egress is the host-enforced boundary (net_link=Netstack →
// default-DENY + allowlist) or the cooperative NAT proxy, the effective
// policy (baked + operator rules), the denied attempts, and a one-click
// allow for a blocked host. The engine enforces it (packages/vm
// egress.rs / netstack); this is read + incremental edits only — it never
// writes the whole effective policy back (see the host bridge's addRule).
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

  // Live traffic feed — the boundary records every request decision
  // (allow/deny/mitm). The denied-attempts view rolls up the deny records.
  const trafficQuery = useQuery({
    queryKey: ['microvm', name, 'egress', 'log'],
    queryFn: () => egress.log(200),
    refetchInterval: 4_000,
  });
  const events = trafficQuery.data ?? [];

  const enforced = !!policy?.enforced;
  // For a Netstack VM the effective `allow` merges the baked allowlist with
  // the operator's rules; partition it back so the UI shows what's inherited
  // (always-on) vs what the operator added — mirrors render_effective_policy.
  const operatorAllow = React.useMemo(() => {
    if (!policy) return [] as string[];
    return policy.enforced ? policy.allow.filter((h) => !isBaked(h)) : policy.allow;
  }, [policy]);

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
        Egress firewall
        {policy ? (
          <span className="ml-2 text-[10px] text-[var(--color-muted-foreground)]">
            {enforced ? 'enforced · default DENY' : `cooperative · default ${policy.default}`}
            {policy.mitm ? ' · TLS interception on' : ''}
          </span>
        ) : null}
      </summary>

      {policy ? (
        <div className="mt-3 space-y-3">
          {/* Firewall status: is the host netstack the enforced boundary
              (net_link=Netstack), or the cooperative NAT proxy? */}
          <div
            className={cn(
              'rounded-md border px-2.5 py-2 text-[11px]',
              enforced ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-amber-500/30 bg-amber-500/5'
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn('font-medium', enforced ? 'text-emerald-200' : 'text-amber-200')}>
                {enforced ? 'Enforced boundary' : 'Cooperative proxy'}
              </span>
              <span className="font-mono text-[10px] text-[var(--color-muted-foreground)]">
                net_link={policy.netLink ?? (enforced ? 'netstack' : 'nat')}
              </span>
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-[var(--color-muted-foreground)]">
              {enforced ? (
                <>
                  The host netstack is the only path off-box: egress is{' '}
                  <span className="text-emerald-200">default-DENY</span> plus an allowlist, enforced even for a rooted
                  guest that drops the proxy env or dials a raw IP. The rules below are the effective policy. Deny wins
                  over allow.
                </>
              ) : (
                <>
                  Egress is unconfined at the link — this policy is a{' '}
                  <span className="text-amber-200">cooperative</span> proxy a workload can bypass (raw IP, dropped{' '}
                  <code className="font-mono">HTTPS_PROXY</code>). Recreate the VM on{' '}
                  <code className="font-mono">net_link=Netstack</code> to make it the enforced boundary. Deny wins over
                  allow.
                </>
              )}
            </p>
          </div>

          {/* Controls. A Netstack VM's default is host-enforced DENY, so we
              show it read-only (toggling it would persist into the file and
              mis-enforce under NAT); a NAT VM keeps the allow/deny toggle. */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs">Default:</span>
            {enforced ? (
              <span className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-xs text-red-200">
                deny <span className="text-[10px] text-[var(--color-muted-foreground)]">host-enforced</span>
              </span>
            ) : (
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
            )}
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
              Reset rules
            </Button>
          </div>

          {policy.mitm && policy.caPath ? (
            <p className="rounded-md border border-cyan-500/30 bg-cyan-500/5 px-2 py-1 font-mono text-[10px] text-cyan-200">
              CA: {policy.caPath} — inject into workloads to trust the interceptor
            </p>
          ) : null}

          {/* Add a rule. Both Allow and Deny go through the incremental
              addRule bridge → `egress allow|deny <host>` (load→add→save on
              the PERSISTED policy); never a whole effective-policy write-back. */}
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

          {/* Effective policy. For a Netstack VM the baked allowlist is
              always-on; operator rules are shown apart so it's clear what's
              inherited vs what you added. */}
          {enforced ? <BakedAllowlist deny={policy.deny} /> : null}
          <RuleList label={enforced ? 'Operator allow' : 'Allowed'} hosts={operatorAllow} tone="green" />
          <RuleList label={enforced ? 'Operator deny (wins over allow)' : 'Denied'} hosts={policy.deny} tone="red" />

          <DeniedAttempts
            events={events}
            policy={policy}
            busy={busy}
            onAllow={(h) => void act(() => egress.addRule('allow', h))}
          />

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

/** Is `host` one of the baked, always-on Netstack allowlist entries? Used
 *  to partition the effective `allow` into baked vs operator rules. */
function isBaked(host: string): boolean {
  const h = host.trim().replace(/\.$/, '').toLowerCase();
  return NETSTACK_BAKED_ALLOWLIST.some((b) => b.toLowerCase() === h);
}

/** The baked allowlist for a Netstack VM — always-on (§5 of the design),
 *  shown read-only. A baked host an operator deny rule overrides is struck
 *  through, mirroring the engine's effective-policy report. */
function BakedAllowlist({ deny }: { deny: string[] }) {
  const overridden = (h: string) => deny.some((d) => hostMatches(h, d));
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-muted-foreground)]">
        Baked allowlist <span className="normal-case opacity-70">(always-on for Netstack VMs)</span>
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {NETSTACK_BAKED_ALLOWLIST.map((h) => {
          const off = overridden(h);
          return (
            <li
              key={h}
              title={off ? 'overridden by an operator deny rule' : undefined}
              className={cn(
                'rounded-md border px-1.5 py-0.5 font-mono text-[11px]',
                off ? 'border-red-500/30 text-red-300 line-through' : 'border-emerald-500/30 text-emerald-200'
              )}
            >
              {h}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** One destination's denied-egress roll-up — mirrors DeniedHost in
 *  packages/vm/src/traffic.rs. */
interface DeniedHost {
  host: string;
  port: number;
  count: number;
  lastSeen: number;
}

/** Aggregate the `deny` records in the traffic feed into per-(host, port)
 *  summaries, most-recently-seen first. Mirror of traffic.rs::aggregate_denied
 *  so the desktop roll-up matches the CLI's `egress denied` view. */
function aggregateDenied(events: EgressEvent[]): DeniedHost[] {
  const byDest = new Map<string, DeniedHost>();
  for (const e of events) {
    if (e.decision !== 'deny') continue;
    const key = `${e.host} ${e.port}`;
    const cur = byDest.get(key);
    if (cur) {
      cur.count += 1;
      cur.lastSeen = Math.max(cur.lastSeen, e.ts);
    } else {
      byDest.set(key, { host: e.host, port: e.port, count: 1, lastSeen: e.ts });
    }
  }
  return [...byDest.values()].sort((a, b) => b.lastSeen - a.lastSeen || a.host.localeCompare(b.host));
}

// Denied-attempts view (egress-firewall F4): the blocked→allow loop in the
// GUI. Rolls up the boundary's deny records into host:port / count / last-
// seen, most-recent-first, each with a one-click Allow that adds an
// incremental allow rule (never a whole-policy write-back).
function DeniedAttempts({
  events,
  policy,
  busy,
  onAllow,
}: {
  events: EgressEvent[];
  policy: EgressPolicy;
  busy: boolean;
  onAllow: (host: string) => void;
}) {
  const denied = aggregateDenied(events);
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted-foreground)]">Denied attempts</div>
      {denied.length === 0 ? (
        <p className="rounded-md border border-dashed border-[var(--color-border)] px-2 py-1.5 text-[11px] text-[var(--color-muted-foreground)]">
          Nothing blocked yet. Egress the boundary denies shows up here — allow a host in one click.
        </p>
      ) : (
        <ul className="max-h-44 space-y-0.5 overflow-auto rounded-md border border-[var(--color-border)] p-1">
          {denied.map((d) => {
            const allowed = policy.allow.some((s) => hostMatches(d.host, s));
            return (
              <li key={`${d.host}:${d.port}`} className="flex items-center gap-2 px-1 py-0.5 text-[11px]">
                <span className="w-8 shrink-0 text-right font-mono text-[10px] text-[var(--color-muted-foreground)]">
                  {relativeAge(new Date(d.lastSeen).toISOString())}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-red-200">
                  {d.host}
                  <span className="text-[var(--color-muted-foreground)]">:{d.port}</span>
                </span>
                <span className="shrink-0 font-mono text-[10px] text-[var(--color-muted-foreground)]">×{d.count}</span>
                {allowed ? (
                  <span className="shrink-0 text-[10px] text-green-300">allowed</span>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onAllow(d.host)}
                    className="shrink-0 rounded border border-green-500/40 px-1.5 text-[10px] text-green-200 hover:bg-green-500/10 disabled:opacity-50"
                  >
                    Allow
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
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

// A prerequisite is "ready" when it's installed AND — for docker — its
// daemon is actually reachable. `daemonRunning` is undefined for tools
// with no daemon (kubectl), so `!== false` leaves those as ready on
// install alone.
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
                : 'Image builds need Docker; pod shells and deploys need kubectl. Install the missing tools below, then re-check.'}
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

function WorkloadsPanel({ clusterId, vmName }: { clusterId: string; vmName?: string }) {
  const host = useHost();
  const terminals = useTerminalSessions();
  const queryClient = useQueryClient();
  const [activePod, setActivePod] = React.useState<LocalPodInfo | null>(null);

  // Workloads + pod logs now read through the in-VM api-server (the same
  // signed ApplianceClient that powers projects/deployments) instead of
  // a kubectl shell-out. The client is bound to the *active* cluster, so
  // we can only read this VM's workloads when it is the selected one;
  // otherwise we'd surface another cluster's state under this card.
  const client = useApplianceClient();
  const { data: config } = useQuery({ queryKey: ['host', 'config'], queryFn: () => host.getConfig() });
  const isActive = config?.selectedClusterId === clusterId;

  const workloadsQuery = useQuery({
    queryKey: ['local-runtime', 'workloads', clusterId],
    enabled: Boolean(client) && isActive,
    queryFn: async () => {
      const res = await client!.listWorkloads();
      if (!res.success) throw res.error;
      return res.data;
    },
    refetchInterval: 5_000,
  });

  const data = workloadsQuery.data;
  const empty = data && data.deployments.length === 0 && data.pods.length === 0 && data.services.length === 0;

  return (
    <>
      <section className="space-y-3 rounded-md border border-[var(--color-border)] p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Workloads · {vmName ?? 'appliance'}</h2>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh workloads"
            onClick={() => workloadsQuery.refetch()}
            disabled={workloadsQuery.isFetching || !isActive}
          >
            <RefreshCw className={cn('h-4 w-4', workloadsQuery.isFetching && 'animate-spin')} />
          </Button>
        </div>

        {!isActive ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Select this microVM as the active cluster to read its workloads through the api-server.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                await host.selectCluster(clusterId);
                queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
              }}
            >
              Select cluster
            </Button>
          </div>
        ) : workloadsQuery.isLoading ? (
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
            <PodsTable
              pods={data.pods}
              onLogs={setActivePod}
              onShell={
                host.terminal
                  ? (pod) => terminals.openSession({ target: pod.name, engine: 'microvm', clusterName: vmName })
                  : undefined
              }
            />
            <ServicesTable services={data.services} />
          </div>
        ) : null}
      </section>

      {activePod && client ? (
        <PodLogsDrawer pod={activePod} client={client} onClose={() => setActivePod(null)} />
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

// Live pod-log tail. Opens a single chunked `follow` stream against the
// api-server (`streamPodLogs`) — the last 500 lines, then new lines as
// they arrive — instead of polling a snapshot. The stream is aborted on
// unmount or when the viewed pod changes.
const LOG_BUFFER_MAX = 5_000;

function PodLogsDrawer({ pod, client, onClose }: { pod: LocalPodInfo; client: ApplianceClient; onClose: () => void }) {
  const [lines, setLines] = React.useState<string[]>([]);
  const [phase, setPhase] = React.useState<'connecting' | 'live' | 'ended' | 'error'>('connecting');
  const [error, setError] = React.useState<string | null>(null);
  const preRef = React.useRef<HTMLPreElement | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    setLines([]);
    setError(null);
    setPhase('connecting');
    let started = false;
    void client
      .streamPodLogs(pod.name, { tailLines: 500, signal: controller.signal }, (line) => {
        if (!started) {
          started = true;
          setPhase('live');
        }
        setLines((prev) => {
          const next = prev.length >= LOG_BUFFER_MAX ? prev.slice(prev.length - LOG_BUFFER_MAX + 1) : prev.slice();
          next.push(line);
          return next;
        });
      })
      .then((res) => {
        if (controller.signal.aborted) return;
        if (!res.success) {
          setError(res.error.message);
          setPhase('error');
        } else {
          setPhase('ended');
        }
      });
    // Abort the follow on unmount / pod switch — the SDK treats an abort
    // as a clean close, not a failure.
    return () => controller.abort();
  }, [client, pod.name]);

  // Keep the newest lines in view as the stream appends.
  React.useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [lines]);

  const text = lines.join('\n');
  const copy = async () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
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
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium',
                phase === 'live'
                  ? 'bg-green-500/15 text-green-300'
                  : phase === 'error'
                    ? 'bg-red-500/15 text-red-300'
                    : 'bg-[var(--color-muted)] text-[var(--color-muted-foreground)]'
              )}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  phase === 'live'
                    ? 'animate-pulse bg-green-400'
                    : phase === 'error'
                      ? 'bg-red-400'
                      : 'bg-[var(--color-muted-foreground)]'
                )}
              />
              {phase === 'live'
                ? 'Live'
                : phase === 'connecting'
                  ? 'Connecting…'
                  : phase === 'error'
                    ? 'Error'
                    : 'Ended'}
            </span>
            <Button variant="outline" size="sm" onClick={copy}>
              <Copy className="h-3.5 w-3.5" /> Copy
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </header>
        <pre
          ref={preRef}
          className="flex-1 overflow-auto whitespace-pre-wrap bg-black/40 p-3 font-mono text-xs leading-relaxed"
        >
          {phase === 'error' ? (
            <span className="text-red-300">{error}</span>
          ) : text ? (
            text
          ) : phase === 'connecting' ? (
            'Connecting…'
          ) : (
            <span className="text-[var(--color-muted-foreground)]">No log lines yet.</span>
          )}
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
