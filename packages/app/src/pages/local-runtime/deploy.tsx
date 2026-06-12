import * as React from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronLeft, FolderOpen, Trash2, Plus, ChevronRight, Rocket, X, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useHost } from '@/providers/host-provider';
import { useApplianceClient } from '@/hooks/use-appliance-client';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { useRecentFolders, type RecentFolder } from '@/hooks/use-recent-folders';
import { cn } from '@/lib/utils';
import { LOCAL_RUNTIME_CLUSTER_ID, microVmNameFromClusterId } from '@/lib/host';
import type { LocalApplianceManifest, LocalLogEvent } from '@/lib/host';
import { extractDeploymentUrl } from '@/lib/deployment';

// Docker Desktop-style deploy wizard for the local engines (k3d
// runtime and microVM). It deploys into the *selected* cluster —
// both engines register as regular clusters — gating readiness and
// routing the image registry per engine. Three steps:
//   1. Pick a folder containing an appliance.{json,ts,js} manifest
//      + a Dockerfile. Programmatic .ts/.js manifests run in the
//      CLI's QuickJS sandbox (sidecar invocation).
//   2. Configure the deploy — project / environment names, env vars,
//      optional runtime overrides (memory / timeout / storage).
//   3. Run — streams docker build + k3d image import logs from the
//      shell, then drives the api-server via the existing SDK for
//      build registration + deploy + status polling.
//
// The wizard never talks to the api-server directly; it uses the
// SDK client wired up by useApplianceClient(), which already holds
// the selected cluster's signed credentials. That keeps the new
// Rust-side surface small (just shell-outs to docker / k3d / kubectl).

type Phase = 'pick' | 'configure' | 'run';

type RunStatus = 'idle' | 'running' | 'succeeded' | 'failed';

interface EnvEntry {
  key: string;
  value: string;
}

export function LocalRuntimeDeployPage() {
  const host = useHost();
  const client = useApplianceClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const local = host.local;
  const { recent: recentFolders, record: recordRecentFolder, forget: forgetRecentFolder } = useRecentFolders();

  // Pre-selected target via query params — e.g. the Environment detail
  // page sends `?project=foo&environment=bar` when its first-time
  // Deploy button is clicked. Captured once on mount so navigating
  // away (e.g. to /local-runtime) and back doesn't blow away in-flight
  // form state.
  const [searchParams] = useSearchParams();
  const presetProject = React.useMemo(() => searchParams.get('project') ?? null, [searchParams]);
  const presetEnvironment = React.useMemo(() => searchParams.get('environment') ?? null, [searchParams]);

  // The wizard deploys into the *selected* cluster (the SDK client is
  // bound to it), so readiness gating has to match the engine behind
  // that cluster: the k3d runtime and the microVM engine are separate
  // lifecycles. Surface the target + its state up front — the wizard
  // is reachable while an engine is down (deep links, or the user
  // stopped it mid-session), and finding out at the end of step 3 is
  // the worst place. Query keys are shared with the Runtimes page so
  // the two views never disagree.
  const { cluster: selectedCluster } = useSelectedCluster();
  const vmName = selectedCluster ? microVmNameFromClusterId(selectedCluster.id) : null;
  const isMicroVmTarget = vmName !== null;
  const runtimeQuery = useQuery({
    queryKey: ['local-runtime', 'status'],
    enabled: Boolean(local?.runtimeStatus) && !isMicroVmTarget,
    queryFn: () => local!.runtimeStatus(),
    refetchInterval: 5_000,
  });
  const vmQuery = useQuery({
    queryKey: ['microvm', 'status', vmName],
    enabled: Boolean(host.vm) && isMicroVmTarget,
    queryFn: () => host.vm!.instance(vmName!).status(),
    refetchInterval: 5_000,
  });
  const runtimeUp = Boolean(runtimeQuery.data?.cluster.running && runtimeQuery.data?.apiServer.running);
  const vmUp = Boolean(vmQuery.data?.running && vmQuery.data?.kubeconfigReady);
  const targetUp = isMicroVmTarget ? vmUp : runtimeUp;
  const targetLoading = isMicroVmTarget ? vmQuery.isLoading : runtimeQuery.isLoading;
  const readyToDeploy = targetUp && Boolean(client);

  const [phase, setPhase] = React.useState<Phase>('pick');

  // Step 1 — folder + manifest
  const [folderPath, setFolderPath] = React.useState<string | null>(null);
  const [manifest, setManifest] = React.useState<LocalApplianceManifest | null>(null);
  const [pickError, setPickError] = React.useState<string | null>(null);
  const [pickBusy, setPickBusy] = React.useState(false);

  // Step 2 — config form. Preset target wins over manifest defaults so
  // a "Deploy to foo/bar" click from elsewhere in the app lands on bar
  // even if the picked folder's manifest names a different project.
  const [projectName, setProjectName] = React.useState(presetProject ?? '');
  const [envName, setEnvName] = React.useState(presetEnvironment ?? 'local');
  const [envEntries, setEnvEntries] = React.useState<EnvEntry[]>([]);
  const [memory, setMemory] = React.useState('');
  const [timeout, setTimeoutField] = React.useState('');
  const [storage, setStorage] = React.useState('');

  // Step 3 — run state
  const [runStatus, setRunStatus] = React.useState<RunStatus>('idle');
  const [logs, setLogs] = React.useState<LogLine[]>([]);
  const [runError, setRunError] = React.useState<string | null>(null);
  const [resultUrl, setResultUrl] = React.useState<string | null>(null);
  const logBoxRef = React.useRef<HTMLPreElement | null>(null);

  React.useEffect(() => {
    // Autoscroll to tail as new lines arrive.
    if (logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [logs]);

  // ============================================================
  // Step 1 — pick a folder, read its manifest.
  // ============================================================
  const applyPickedManifest = (picked: string, m: LocalApplianceManifest) => {
    setFolderPath(picked);
    setManifest(m);
    // Reasonable defaults for step 2 form. Don't clobber a preset
    // project/env passed via URL — those were chosen explicitly
    // upstream (e.g. from the environment detail page).
    if (!presetProject) setProjectName(m.name);
    const envFromManifest = Object.entries(m.env ?? {}).map(([key, value]) => ({ key, value }));
    // Prefill PORT from manifest so the container's listen port and
    // the Service / NodePort agree. Without this the executor falls
    // back to 8080, which doesn't match e.g. demo-node-container.
    if (m.port && !envFromManifest.some((e) => e.key === 'PORT')) {
      envFromManifest.unshift({ key: 'PORT', value: String(m.port) });
    }
    setEnvEntries(envFromManifest);
  };

  const onPickFolder = async () => {
    if (!local?.pickDirectory) return;
    setPickBusy(true);
    setPickError(null);
    try {
      const picked = await local.pickDirectory();
      if (!picked) return;
      const m = await local.readApplianceManifest(picked);
      applyPickedManifest(picked, m);
    } catch (err) {
      setPickError(err instanceof Error ? err.message : String(err));
    } finally {
      setPickBusy(false);
    }
  };

  const onPickRecent = async (entry: RecentFolder) => {
    if (!local?.readApplianceManifest) return;
    setPickBusy(true);
    setPickError(null);
    try {
      const m = await local.readApplianceManifest(entry.path);
      applyPickedManifest(entry.path, m);
    } catch (err) {
      // Folder moved / manifest gone — forget the entry so it doesn't
      // keep failing every time. Surface the error so the user knows.
      forgetRecentFolder(entry.path);
      setPickError(err instanceof Error ? err.message : String(err));
    } finally {
      setPickBusy(false);
    }
  };

  // ============================================================
  // Step 3 — build + import + deploy + poll.
  // ============================================================
  const runDeploy = async () => {
    if (!folderPath || !manifest || !local?.buildAndImportImage) return;
    // Defense in depth behind the banner/disabled button: a silent
    // return here used to leave step 3 stuck on "Starting…" forever.
    if (!client) {
      setRunStatus('failed');
      setRunError(
        'No cluster is selected, so there are no credentials to deploy with. Start a local engine (it registers its cluster automatically), then retry.'
      );
      return;
    }
    if (!targetUp) {
      setRunStatus('failed');
      setRunError(
        isMicroVmTarget
          ? 'The microVM engine is not running. Start it from the Runtimes page, then retry.'
          : 'The local runtime is not running. Start it from the Runtimes page, then retry.'
      );
      return;
    }
    setRunStatus('running');
    setLogs([]);
    setRunError(null);
    setResultUrl(null);

    const append = (line: LogLine) => setLogs((prev) => [...prev, line]);

    try {
      // 1. Resolve the registry from the *selected cluster's* own
      //    /cluster-info — engine-agnostic: the k3d runtime advertises
      //    its sibling registry (localhost:5050), the microVM its
      //    forwarded in-VM registry (localhost:5052). Asking the k3d
      //    runtimeStatus here used to misroute microVM builds into the
      //    k3d registry. Fall back to the k3d probe only when the
      //    server predates /cluster-info.
      let registryUrl: string | undefined;
      const info = await client.getClusterInfo();
      if (info.success) {
        registryUrl = info.data.baseConfig.kubernetes?.registry?.url ?? undefined;
      }
      if (!registryUrl) {
        // The k3d probe is only a valid fallback for the k3d cluster —
        // answering with localhost:5050 for a microVM target would
        // misroute the image into the wrong engine's registry.
        if (isMicroVmTarget) {
          throw new Error(
            'the microVM api-server did not advertise its registry (/cluster-info) — run "appliance vm up" to reconcile it, then retry'
          );
        }
        const runtime = await local.runtimeStatus();
        registryUrl = runtime.config.registryUrl;
      }

      // 2. docker build + push (or import fallback) — streams onto our log box.
      const imageTag = `${manifest.name}:latest`;
      append({ stream: 'meta', message: `==> building image ${imageTag} from ${folderPath}` });
      const resolvedImageRef = await local.buildAndImportImage(
        {
          path: folderPath,
          imageTag,
          platform: manifest.platform,
          registryUrl,
        },
        (event: LocalLogEvent) => append({ stream: event.stream, message: event.message })
      );

      // 3. SDK path: find-or-create project + environment, register
      //    the external-image build, dispatch the deploy, poll until
      //    a terminal state arrives.
      append({ stream: 'meta', message: `==> registering project "${projectName}" / env "${envName}"` });
      const project = await findOrCreateProject(client, projectName);
      const env = await findOrCreateEnvironment(client, project.id, projectName, envName);

      append({ stream: 'meta', message: `==> creating external build for ${resolvedImageRef}` });
      // `port` rides on the build record so the api-server's Service
      // wiring targets the app's real port (remote images carry no
      // manifest to read it from).
      const build = await client.createBuild({ uploadUrl: resolvedImageRef, port: manifest.port });
      if (!build.success) throw new Error(`createBuild: ${build.error.message}`);

      const envVars: Record<string, string> = {};
      for (const { key, value } of envEntries) {
        if (key.trim()) envVars[key.trim()] = value;
      }

      append({ stream: 'meta', message: `==> dispatching deploy` });
      const deploy = await client.deploy(env.id, {
        buildId: build.data.buildId,
        environment: Object.keys(envVars).length ? envVars : undefined,
        memory: memory ? Number(memory) : undefined,
        timeout: timeout ? Number(timeout) : undefined,
        storage: storage ? Number(storage) : undefined,
      });
      if (!deploy.success) throw new Error(`deploy: ${deploy.error.message}`);

      // Poll for terminal status.
      const finalDeploy = await pollDeploymentUntilDone(client, deploy.data.id, (msg) =>
        append({ stream: 'meta', message: `  ${msg}` })
      );
      append({
        stream: 'meta',
        message: `==> ${finalDeploy.status}${finalDeploy.message ? ': ' + finalDeploy.message : ''}`,
      });

      if (finalDeploy.status === 'failed') {
        throw new Error(finalDeploy.message ?? 'deployment failed');
      }

      const url = extractDeploymentUrl(finalDeploy.message);
      if (url) setResultUrl(url);

      // Folder + project shipped successfully — remember it so the
      // next run of this wizard offers it as a one-click chip.
      recordRecentFolder({ path: folderPath, projectName: manifest.name });

      // Nudge the workloads + deployments queries on the rest of the UI.
      queryClient.invalidateQueries({ queryKey: ['local-runtime'] });
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
      queryClient.invalidateQueries({ queryKey: ['environments'] });
      setRunStatus('succeeded');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      append({ stream: 'stderr', message });
      setRunError(message);
      setRunStatus('failed');
    }
  };

  // ============================================================
  // Render
  // ============================================================
  if (!local?.buildAndImportImage) {
    return (
      <div className="max-w-2xl space-y-4">
        <h1 className="text-xl font-semibold">Deploy Application</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          The build & deploy wizard is only available in the desktop app.
        </p>
      </div>
    );
  }

  const canAdvanceToConfigure = manifest !== null;
  const canRun = projectName.trim().length > 0 && envName.trim().length > 0;

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/local-runtime">
            <ChevronLeft className="h-4 w-4" /> Local Runtime
          </Link>
        </Button>
      </div>

      <header>
        <h1 className="text-xl font-semibold">Deploy Application</h1>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          Pick a folder with an <code>appliance.json</code>, <code>.ts</code>, or <code>.js</code> manifest, configure
          overrides, then build and deploy directly to the target cluster.
        </p>
        {selectedCluster ? (
          <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-[var(--color-muted-foreground)]">
            Target:
            <span className="inline-flex items-center rounded-md border border-[var(--color-border)] px-1.5 py-0.5 font-medium text-[var(--color-foreground)]">
              {selectedCluster.name}
            </span>
            {isMicroVmTarget ? (
              <span className="rounded bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-medium text-cyan-300">
                microVM engine
              </span>
            ) : selectedCluster.id === LOCAL_RUNTIME_CLUSTER_ID ? (
              <span className="rounded bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-medium text-cyan-300">
                k3d engine
              </span>
            ) : null}
            <span>· switch with the cluster menu in the top bar</span>
          </p>
        ) : null}
      </header>

      {!readyToDeploy && !targetLoading ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {!targetUp ? (
              <>
                {isMicroVmTarget ? (
                  <>The microVM engine isn&apos;t running</>
                ) : (
                  <>The local runtime isn&apos;t running</>
                )}{' '}
                — builds deploy into its cluster, so the final step needs it up.{' '}
                <Link to="/local-runtime" className="underline">
                  Start it from the Runtimes page
                </Link>{' '}
                first. You can still pick a folder and configure in the meantime.
              </>
            ) : (
              <>No cluster is selected. Starting a local engine registers its cluster automatically.</>
            )}
          </span>
        </div>
      ) : null}

      {presetProject || presetEnvironment ? (
        <div className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-200">
          Deploying to{' '}
          <code className="font-mono">
            {presetProject ?? projectName}
            {presetEnvironment ? ` / ${presetEnvironment}` : ''}
          </code>
          .
        </div>
      ) : null}

      <Stepper phase={phase} />

      {phase === 'pick' ? (
        <PickStep
          folderPath={folderPath}
          manifest={manifest}
          onPick={onPickFolder}
          pickBusy={pickBusy}
          pickError={pickError}
          onNext={() => setPhase('configure')}
          canNext={canAdvanceToConfigure}
          recent={recentFolders}
          onPickRecent={onPickRecent}
          onForgetRecent={forgetRecentFolder}
        />
      ) : null}

      {phase === 'configure' ? (
        <ConfigureStep
          manifest={manifest!}
          projectName={projectName}
          setProjectName={setProjectName}
          envName={envName}
          setEnvName={setEnvName}
          envEntries={envEntries}
          setEnvEntries={setEnvEntries}
          memory={memory}
          setMemory={setMemory}
          timeout={timeout}
          setTimeout={setTimeoutField}
          storage={storage}
          setStorage={setStorage}
          onBack={() => setPhase('pick')}
          onNext={() => {
            setPhase('run');
            void runDeploy();
          }}
          canNext={canRun && readyToDeploy}
        />
      ) : null}

      {phase === 'run' ? (
        <RunStep
          runStatus={runStatus}
          logs={logs}
          logBoxRef={logBoxRef}
          error={runError}
          resultUrl={resultUrl}
          onRetry={runDeploy}
          onDone={() => navigate('/local-runtime')}
        />
      ) : null}
    </div>
  );
}

// ----- step UIs ------------------------------------------------------

function Stepper({ phase }: { phase: Phase }) {
  const steps: Array<{ id: Phase; label: string }> = [
    { id: 'pick', label: '1. Pick folder' },
    { id: 'configure', label: '2. Configure' },
    { id: 'run', label: '3. Build & deploy' },
  ];
  const activeIdx = steps.findIndex((s) => s.id === phase);
  return (
    <ol className="flex items-center gap-2 text-xs">
      {steps.map((s, i) => {
        const state = i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'upcoming';
        return (
          <React.Fragment key={s.id}>
            <li
              className={cn(
                'rounded-md px-2 py-1',
                state === 'active' && 'bg-[var(--color-accent)] text-[var(--color-accent-foreground)] font-medium',
                state === 'done' && 'text-green-300',
                state === 'upcoming' && 'text-[var(--color-muted-foreground)]'
              )}
            >
              {s.label}
            </li>
            {i < steps.length - 1 ? <ChevronRight className="h-3 w-3 text-[var(--color-muted-foreground)]" /> : null}
          </React.Fragment>
        );
      })}
    </ol>
  );
}

function PickStep({
  folderPath,
  manifest,
  onPick,
  pickBusy,
  pickError,
  onNext,
  canNext,
  recent,
  onPickRecent,
  onForgetRecent,
}: {
  folderPath: string | null;
  manifest: LocalApplianceManifest | null;
  onPick: () => void;
  pickBusy: boolean;
  pickError: string | null;
  onNext: () => void;
  canNext: boolean;
  recent: RecentFolder[];
  onPickRecent: (entry: RecentFolder) => void;
  onForgetRecent: (path: string) => void;
}) {
  return (
    <section className="space-y-3 rounded-md border border-[var(--color-border)] p-4">
      <h2 className="text-sm font-semibold">Source folder</h2>
      <p className="text-xs text-[var(--color-muted-foreground)]">
        The folder must contain a <code>Dockerfile</code> plus an <code>appliance.json</code>, <code>appliance.ts</code>
        , or <code>appliance.js</code> manifest. Programmatic manifests run inside a QuickJS sandbox — no host
        filesystem, process, or network access; only <code>@appliance.sh/sdk</code> imports resolve.
      </p>
      <div className="flex items-center gap-2">
        <Button onClick={onPick} disabled={pickBusy}>
          <FolderOpen className="h-4 w-4" />{' '}
          {pickBusy ? 'Reading…' : folderPath ? 'Pick a different folder' : 'Pick folder'}
        </Button>
        {folderPath ? <code className="truncate font-mono text-xs">{folderPath}</code> : null}
      </div>

      {recent.length > 0 && !folderPath ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[var(--color-muted-foreground)]">
            <History className="h-3 w-3" /> Recent
          </div>
          <ul className="flex flex-wrap gap-1.5">
            {recent.map((entry) => (
              <li key={entry.path}>
                <span className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-muted)]/30 pl-2 pr-0.5 py-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() => onPickRecent(entry)}
                    disabled={pickBusy}
                    className="font-mono text-[11px] hover:text-[var(--color-accent)] disabled:opacity-50"
                    title={entry.path}
                  >
                    {entry.projectName ?? basename(entry.path)}
                  </button>
                  <button
                    type="button"
                    aria-label={`Forget ${entry.path}`}
                    onClick={() => onForgetRecent(entry.path)}
                    className="rounded p-0.5 text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {pickError ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">{pickError}</div>
      ) : null}

      {manifest ? (
        <dl className="grid grid-cols-[7rem_1fr] gap-y-1 rounded-md border border-[var(--color-border)] p-3 text-sm">
          <Row label="Name" value={<code className="font-mono text-xs">{manifest.name}</code>} />
          <Row label="Type" value={<code className="font-mono text-xs">{manifest.type ?? '—'}</code>} />
          <Row label="Port" value={<code className="font-mono text-xs">{manifest.port ?? '—'}</code>} />
          <Row label="Platform" value={<code className="font-mono text-xs">{manifest.platform ?? 'host'}</code>} />
          <Row label="Manifest" value={<code className="truncate font-mono text-xs">{manifest.manifestPath}</code>} />
        </dl>
      ) : null}

      <div className="flex justify-end">
        <Button onClick={onNext} disabled={!canNext}>
          Next: configure <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </section>
  );
}

function ConfigureStep({
  manifest,
  projectName,
  setProjectName,
  envName,
  setEnvName,
  envEntries,
  setEnvEntries,
  memory,
  setMemory,
  timeout,
  setTimeout,
  storage,
  setStorage,
  onBack,
  onNext,
  canNext,
}: {
  manifest: LocalApplianceManifest;
  projectName: string;
  setProjectName: (v: string) => void;
  envName: string;
  setEnvName: (v: string) => void;
  envEntries: EnvEntry[];
  setEnvEntries: React.Dispatch<React.SetStateAction<EnvEntry[]>>;
  memory: string;
  setMemory: (v: string) => void;
  timeout: string;
  setTimeout: (v: string) => void;
  storage: string;
  setStorage: (v: string) => void;
  onBack: () => void;
  onNext: () => void;
  canNext: boolean;
}) {
  const addEnv = () => setEnvEntries((prev) => [...prev, { key: '', value: '' }]);
  const removeEnv = (idx: number) => setEnvEntries((prev) => prev.filter((_, i) => i !== idx));
  const setEnv = (idx: number, patch: Partial<EnvEntry>) =>
    setEnvEntries((prev) => prev.map((e, i) => (i === idx ? { ...e, ...patch } : e)));

  return (
    <section className="space-y-5 rounded-md border border-[var(--color-border)] p-4">
      <h2 className="text-sm font-semibold">Configure deploy</h2>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Project name" hint={`Default from manifest: ${manifest.name}`}>
          <TextInput value={projectName} onChange={setProjectName} placeholder={manifest.name} />
        </Field>
        <Field label="Environment name" hint="Created if absent.">
          <TextInput value={envName} onChange={setEnvName} placeholder="local" />
        </Field>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <div>
            <h3 className="text-xs font-medium">Environment variables</h3>
            <p className="text-[10px] text-[var(--color-muted-foreground)]">
              Forwarded as container env. <code>PORT</code> also drives the Service&rsquo;s port + NodePort target.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={addEnv}>
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        </div>
        {envEntries.length === 0 ? (
          <p className="rounded-md border border-dashed border-[var(--color-border)] p-3 text-xs text-[var(--color-muted-foreground)]">
            No env vars. Manifest didn&rsquo;t declare any.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {envEntries.map((entry, idx) => (
              <li key={idx} className="grid grid-cols-[1fr_2fr_auto] items-center gap-2">
                <TextInput value={entry.key} onChange={(v) => setEnv(idx, { key: v })} placeholder="KEY" mono />
                <TextInput value={entry.value} onChange={(v) => setEnv(idx, { value: v })} placeholder="value" mono />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${entry.key || 'env var'}`}
                  onClick={() => removeEnv(idx)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <details className="rounded-md border border-[var(--color-border)] p-3">
        <summary className="cursor-pointer text-xs font-medium">Runtime overrides (optional)</summary>
        <p className="mt-1 text-[10px] text-[var(--color-muted-foreground)]">
          Cloud-only knobs for parity with the cloud Console. Locally they&rsquo;re recorded on the deployment but have
          no effect on the running container.
        </p>
        <div className="mt-2 grid grid-cols-3 gap-3">
          <Field label="Memory (MB)" hint="cloud-only">
            <TextInput value={memory} onChange={setMemory} placeholder="1024" mono />
          </Field>
          <Field label="Timeout (s)" hint="cloud-only">
            <TextInput value={timeout} onChange={setTimeout} placeholder="30" mono />
          </Field>
          <Field label="Storage (MB)" hint="cloud-only">
            <TextInput value={storage} onChange={setStorage} placeholder="512" mono />
          </Field>
        </div>
      </details>

      <div className="flex justify-between">
        <Button variant="outline" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" /> Back
        </Button>
        <Button onClick={onNext} disabled={!canNext}>
          <Rocket className="h-4 w-4" /> Build & deploy
        </Button>
      </div>
    </section>
  );
}

function RunStep({
  runStatus,
  logs,
  logBoxRef,
  error,
  resultUrl,
  onRetry,
  onDone,
}: {
  runStatus: RunStatus;
  logs: LogLine[];
  logBoxRef: React.RefObject<HTMLPreElement | null>;
  error: string | null;
  resultUrl: string | null;
  onRetry: () => void;
  onDone: () => void;
}) {
  return (
    <section className="space-y-3 rounded-md border border-[var(--color-border)] p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Build & deploy</h2>
        <StatusBadge status={runStatus} />
      </div>

      <pre
        ref={logBoxRef}
        className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-md border border-[var(--color-border)] bg-black/40 p-3 font-mono text-[11px] leading-relaxed"
      >
        {logs.length === 0 ? (
          <span className="text-[var(--color-muted-foreground)]">Starting…</span>
        ) : (
          logs.map((line, i) => (
            <div
              key={i}
              className={cn(line.stream === 'stderr' && 'text-red-300', line.stream === 'meta' && 'text-cyan-300')}
            >
              {line.message}
            </div>
          ))
        )}
      </pre>

      {error ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">{error}</div>
      ) : null}

      {resultUrl ? (
        <div className="rounded-md border border-green-500/40 bg-green-500/10 p-3 text-xs text-green-300">
          Deployed at{' '}
          <a className="underline" href={resultUrl} target="_blank" rel="noreferrer">
            {resultUrl}
          </a>
        </div>
      ) : null}

      <div className="flex justify-between">
        {runStatus === 'failed' ? (
          <Button variant="outline" onClick={onRetry}>
            Retry
          </Button>
        ) : (
          <span />
        )}
        <Button onClick={onDone} disabled={runStatus === 'running'}>
          {runStatus === 'succeeded' ? 'Done' : 'Close'}
        </Button>
      </div>
    </section>
  );
}

// ----- small UI primitives -------------------------------------------

interface LogLine {
  stream: 'stdout' | 'stderr' | 'meta';
  message: string;
}

function StatusBadge({ status }: { status: RunStatus }) {
  const meta: Record<RunStatus, { label: string; tone: string }> = {
    idle: { label: 'Idle', tone: 'bg-[var(--color-muted)] text-[var(--color-muted-foreground)]' },
    running: { label: 'Running', tone: 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/40' },
    succeeded: { label: 'Succeeded', tone: 'bg-green-500/15 text-green-300 border border-green-500/40' },
    failed: { label: 'Failed', tone: 'bg-red-500/15 text-red-300 border border-red-500/40' },
  };
  const m = meta[status];
  return (
    <span className={cn('inline-flex items-center rounded-md px-2 py-1 text-xs font-medium', m.tone)}>{m.label}</span>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="text-xs text-[var(--color-muted-foreground)]">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-xs font-medium">{label}</span>
      {children}
      {hint ? <span className="block text-[10px] text-[var(--color-muted-foreground)]">{hint}</span> : null}
    </label>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  mono,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={cn(
        'w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1.5 text-sm',
        mono && 'font-mono text-xs'
      )}
    />
  );
}

function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

// ----- SDK helpers (small replicas of CLI deploy) --------------------

type Client = NonNullable<ReturnType<typeof useApplianceClient>>;

async function findOrCreateProject(client: Client, name: string) {
  const list = await client.listProjects();
  if (!list.success) throw new Error(`listProjects: ${list.error.message}`);
  const existing = list.data.find((p) => p.name === name);
  if (existing) return existing;
  const created = await client.createProject({ name });
  if (!created.success) throw new Error(`createProject: ${created.error.message}`);
  return created.data;
}

async function findOrCreateEnvironment(client: Client, projectId: string, projectName: string, envName: string) {
  const expectedStack = `${projectName}-${envName}`;
  const list = await client.listEnvironments(projectId);
  if (!list.success) throw new Error(`listEnvironments: ${list.error.message}`);
  const existing = list.data.find((e) => e.name === envName);
  if (existing && existing.stackName === expectedStack) return existing;
  if (existing) {
    // Stale stack name — drop and recreate so the executor's resources
    // line up with the new environment id. Mirrors what the CLI does.
    await client.deleteEnvironment(projectId, existing.id);
  }
  const created = await client.createEnvironment({ name: envName, projectId });
  if (!created.success) throw new Error(`createEnvironment: ${created.error.message}`);
  return created.data;
}

const POLL_INTERVAL_MS = 2000;

async function pollDeploymentUntilDone(client: Client, deploymentId: string, onProgress: (msg: string) => void) {
  // Poll until the deployment lands in a terminal state. Cap at 5 min
  // to avoid hanging forever on a stuck deploy — the user can always
  // re-run.
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const r = await client.getDeployment(deploymentId);
    if (!r.success) throw new Error(`getDeployment: ${r.error.message}`);
    onProgress(`status: ${r.data.status}${r.data.message ? ' — ' + r.data.message : ''}`);
    if (r.data.status === 'succeeded' || r.data.status === 'failed') {
      return r.data;
    }
  }
  throw new Error('deployment polling timed out after 5 minutes');
}
