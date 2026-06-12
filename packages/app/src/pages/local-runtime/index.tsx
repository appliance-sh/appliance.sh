import * as React from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  FileText,
  Play,
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
import { MICROVM_CLUSTER_ID } from '@/lib/host';
import { TerminalDrawer } from './terminal-drawer';
import type {
  LocalDeploymentInfo,
  LocalPodInfo,
  LocalPreflightCheck,
  LocalRuntimeStatus,
  LocalServiceInfo,
  MicroVmStatus,
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

  // The header's Deploy button serves both engines — the wizard
  // targets the selected cluster, so it's useful as soon as either
  // the k3d runtime or the microVM is up. Shares the MicroVmPanel's
  // query key; its (faster) polling drives the freshness.
  const vmStatusQuery = useQuery({
    queryKey: ['microvm', 'status'],
    enabled: Boolean(host.vm),
    queryFn: () => host.vm!.status(),
    refetchInterval: 30_000,
  });
  const microVmReady = Boolean(vmStatusQuery.data?.running && vmStatusQuery.data?.kubeconfigReady);
  const canDeploy = phase === 'running' || microVmReady;
  // Both engines publish on host port 8081 — only one can run at a
  // time. Gate Start with an explanation instead of letting k3d fail
  // mid-flight on the bind error.
  const microVmHoldsPort = Boolean(vmStatusQuery.data?.running);

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

  return (
    <div className="max-w-4xl space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Runtimes</h1>
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            Local engines for running appliances on this machine — the k3d cluster and the isolated microVM. Both wire
            into the console as regular clusters.
          </p>
        </div>
        <div className="flex items-center gap-2">
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
            <Button variant="outline" disabled title="Start an engine to deploy applications">
              <Rocket className="h-4 w-4" /> Deploy application
            </Button>
          )}
          <PhaseBadge phase={phase} />
        </div>
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

      <section className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--color-border)] p-4">
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
                ? 'Stop the microVM first — both engines publish on host port 8081'
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
      </section>

      <MutationErrors errors={[startMutation.error, stopMutation.error, deleteMutation.error]} />

      {status ? <RuntimeOverview status={status} /> : null}

      {status?.cluster.running && status?.apiServer.running ? <WorkloadsPanel /> : null}

      {host.vm ? <MicroVmPanel /> : null}

      {microVmReady ? <WorkloadsPanel engine="microvm" /> : null}
    </div>
  );
}

// ---- microVM engine -----------------------------------------------------

// The next-generation runtime: an isolated VM Appliance boots itself
// (appliance-vm) instead of renting the docker provider's. Surfaced
// alongside the k3d runtime while both engines coexist. Once up it
// registers as a regular cluster (id "microvm" — also the CLI profile
// name), so the deploy wizard, cluster switcher, and workload views
// treat it like any other target, on the same
// *.appliance.localhost:8081 URL surface.
function MicroVmPanel() {
  const host = useHost();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const vm = host.vm!;

  const statusQuery = useQuery({
    queryKey: ['microvm', 'status'],
    queryFn: () => vm.status(),
    refetchInterval: (q) => {
      const data = q.state.data as MicroVmStatus | undefined;
      if (!data?.available) return 30_000;
      return data.running ? 8_000 : 4_000;
    },
  });

  // Mirror of the page-level port gate, in the other direction: a
  // running k3d cluster holds host port 8081, so the microVM can't
  // boot until it stops. Shares the page's query key (cache-deduped).
  const k3dQuery = useQuery({
    queryKey: ['local-runtime', 'status'],
    enabled: Boolean(host.local?.runtimeStatus),
    queryFn: () => host.local!.runtimeStatus(),
    refetchInterval: 30_000,
  });
  const k3dHoldsPort = Boolean(k3dQuery.data?.cluster.running);

  const [busy, setBusy] = React.useState<'install' | 'up' | 'stop' | 'delete' | null>(null);
  const [log, setLog] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const logRef = React.useRef<HTMLPreElement | null>(null);

  React.useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['microvm'] });

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
  const deployHere = async () => {
    try {
      const cfg = await host.getConfig();
      if (cfg.selectedClusterId !== MICROVM_CLUSTER_ID) {
        await host.selectCluster(MICROVM_CLUSTER_ID);
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
      title: 'Delete the microVM?',
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

  return (
    <section className="space-y-3 rounded-md border border-[var(--color-border)] p-4">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">
            MicroVM engine{' '}
            <span className="rounded bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-medium text-cyan-300">beta</span>
          </h2>
          <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
            An isolated VM Appliance boots itself — no docker provider needed for the cluster. Deploys use the{' '}
            <code className="font-mono">microvm</code> profile; apps publish at the same{' '}
            <code className="font-mono">*.appliance.localhost</code> URLs.
          </p>
        </div>
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
      </header>

      {status && !status.available ? (
        status.installable ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--color-border)] px-3 py-2">
            <p className="text-xs text-[var(--color-muted-foreground)]">
              The engine binary (<code className="font-mono">appliance-vm</code>) isn't installed yet — Appliance
              installs it into <code className="font-mono">~/.appliance/bin</code>.
            </p>
            <Button onClick={() => run('install', () => vm.install())} disabled={busy !== null}>
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
            onClick={() => run('up', () => vm.up((e) => setLog((prev) => [...prev.slice(-199), e.message])))}
            disabled={busy !== null || status?.running === true || (k3dHoldsPort && !status?.running)}
            title={
              k3dHoldsPort && !status?.running
                ? 'Stop the k3d runtime first — both engines publish on host port 8081'
                : undefined
            }
          >
            <Play className="h-4 w-4" /> {busy === 'up' ? 'Starting…' : status?.running ? 'Running' : 'Start'}
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
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Kubernetes at <code className="font-mono">{status.apiServerUrl}</code> · registered as the{' '}
            <span className="font-medium text-[var(--color-foreground)]">MicroVM Runtime</span> cluster
          </p>
          <Button variant="outline" size="sm" onClick={() => void deployHere()} disabled={busy !== null}>
            <Rocket className="h-4 w-4" /> Deploy application
          </Button>
        </div>
      ) : null}

      {status?.running && status.kubeconfigReady ? <EgressPanel /> : null}
    </section>
  );
}

// Outbound-traffic control for the microVM: a desktop surface over the
// egress proxy's allow/deny policy + optional TLS interception. The
// engine enforces it (packages/vm egress.rs); this just edits the
// policy the proxy reloads live.
function EgressPanel() {
  const host = useHost();
  const queryClient = useQueryClient();
  const egress = host.vm!.egress;
  const [host_, setHost] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const policyQuery = useQuery({
    queryKey: ['microvm', 'egress'],
    queryFn: () => egress.get(),
    refetchInterval: 15_000,
  });
  const policy = policyQuery.data;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['microvm', 'egress'] });

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
        </div>
      ) : (
        <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">Loading policy…</p>
      )}

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

function WorkloadsPanel({ engine }: { engine?: 'microvm' }) {
  const host = useHost();
  const [activePod, setActivePod] = React.useState<LocalPodInfo | null>(null);
  const [shellPod, setShellPod] = React.useState<LocalPodInfo | null>(null);
  const workloadsQuery = useQuery({
    queryKey: ['local-runtime', 'workloads', engine ?? 'k3d'],
    queryFn: () => host.local!.listWorkloads(engine ? { engine } : undefined),
    refetchInterval: 5_000,
  });

  const data = workloadsQuery.data;
  const empty = data && data.deployments.length === 0 && data.pods.length === 0 && data.services.length === 0;

  return (
    <>
      <section className="space-y-3 rounded-md border border-[var(--color-border)] p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{engine === 'microvm' ? 'MicroVM workloads' : 'Workloads'}</h2>
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

      {activePod ? <PodLogsDrawer pod={activePod} engine={engine} onClose={() => setActivePod(null)} /> : null}
      {shellPod ? <TerminalDrawer target={shellPod.name} engine={engine} onClose={() => setShellPod(null)} /> : null}
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

function PodLogsDrawer({ pod, engine, onClose }: { pod: LocalPodInfo; engine?: 'microvm'; onClose: () => void }) {
  const host = useHost();
  const logsQuery = useQuery({
    queryKey: ['local-runtime', 'logs', engine ?? 'k3d', pod.name],
    queryFn: () => host.local!.tailPodLogs({ podName: pod.name, tailLines: 500, engine }),
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
