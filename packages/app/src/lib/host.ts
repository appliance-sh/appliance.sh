import type {
  ApiServerUpdateInput,
  ApiServerUpdateOptions,
  BaselineUpdateInput,
  BaselineUpdateOptions,
  BootstrapEvent,
  BootstrapInput,
  BootstrapOptions,
  BootstrapPhase,
  BootstrapPriorOutputs,
  BootstrapResult,
  LatestGhcrTagInput,
  StateDemotionInput,
  StateDemotionOptions,
  StatePromotionInput,
  StatePromotionOptions,
} from '@appliance.sh/bootstrap';

// A cluster is one (api-server URL, API key) pair the user has either
// connected to manually or bootstrapped from this shell. Identity is a
// stable local UUID — the api-server doesn't know it; it's just how
// the shell keys storage (config + keychain) and references the
// cluster from the UI.
export interface Cluster {
  id: string;
  name: string;
  apiServerUrl: string;
  createdAt: string;
  // Pulumi state backend URL (e.g. `s3://us-east-1-state-...`)
  // for clusters bootstrapped from this device. Settings drives
  // post-hoc state promotion (phase 3) against this URL when the
  // bootstrap wizard skipped phase 3 or it failed mid-run. Absent
  // for clusters added manually via Connect.
  stateBackendUrl?: string;
  // Original BootstrapInput the wizard collected. Persisted so the
  // Settings page can run baseline updates against this cluster
  // without forcing the operator to re-enter dns.createZone/etc.
  // (which would risk flipping declarative state). Absent for
  // clusters added via Connect or migrated from older shells.
  lastBootstrapInput?: BootstrapInput;
}

export interface HostConfig {
  clusters: Cluster[];
  selectedClusterId: string | null;
  // The selected cluster's key, denormalised onto the config so
  // useApplianceClient can construct an SDK client without a second
  // host round-trip per render. Null when no cluster is selected.
  apiKey: { id: string; secret: string } | null;
}

export interface AddClusterInput {
  name: string;
  apiServerUrl: string;
  apiKey: { id: string; secret: string };
  stateBackendUrl?: string;
  lastBootstrapInput?: BootstrapInput;
}

// Drives a bootstrap run from the UI. Tauri host implements this by
// spawning the Node sidecar; web host omits the capability entirely
// (bootstrap needs local AWS creds + a local Pulumi, neither of
// which the browser can provide — the Connect page points users at
// the CLI instead).
export interface BootstrapHost {
  run(
    input: BootstrapInput,
    options: BootstrapOptions | undefined,
    onEvent: (event: BootstrapEvent) => void
  ): Promise<BootstrapResult>;
  /**
   * Run phase 3 (state promotion) standalone. Drives the same
   * runStatePromotion entry point the bootstrap engine uses
   * internally, but without re-running phases 1–2. Settings calls
   * this when the user wants to detach an already-bootstrapped
   * cluster's Pulumi state from this device after the fact.
   */
  promoteState(
    input: StatePromotionInput,
    options: StatePromotionOptions | undefined,
    onEvent: (event: BootstrapEvent) => void
  ): Promise<void>;
  /**
   * Inverse of `promoteState`: pull installer Pulumi state out of
   * S3 back to a local file backend on this device. Refuses to
   * overwrite an existing local state dir; the operator must
   * archive or remove it first. The S3 stack is left in place as
   * a backup.
   */
  demoteState(
    input: StateDemotionInput,
    options: StateDemotionOptions | undefined,
    onEvent: (event: BootstrapEvent) => void
  ): Promise<void>;
  /**
   * Self-update the cluster's api-server + api-worker to a new image
   * version. The sidecar mirrors the new image to the cluster ECR
   * (needs docker — Lambda can't pull/push images) and then drives
   * deploys via the cluster's existing deployment API. Worker is
   * updated first; the api-server's deploy goes through the (now
   * upgraded) worker.
   */
  updateApiServer(
    input: ApiServerUpdateInput,
    options: ApiServerUpdateOptions | undefined,
    onEvent: (event: BootstrapEvent) => void
  ): Promise<void>;
  /**
   * Re-run phase 1 (the installer stack) against an already-bootstrapped
   * cluster to apply infra baseline changes that ship with this version
   * of @appliance.sh/infra. Requires the original BootstrapInput; the
   * desktop caches it on the Cluster record at handoff time.
   */
  updateBaseline(
    input: BaselineUpdateInput,
    options: BaselineUpdateOptions | undefined,
    onEvent: (event: BootstrapEvent) => void
  ): Promise<void>;
  /**
   * Resolve the latest semver-shaped tag on the api-server's ghcr.io
   * image. Used by Settings to default the target version field of
   * the self-update flow without making the operator type a number.
   * Optional — hosts that can't reach ghcr.io should omit it; the UI
   * falls back to the desktop's bundled version.
   */
  latestApiServerVersion?(input?: LatestGhcrTagInput): Promise<{ version: string }>;
  /**
   * Enumerate AWS profiles from `~/.aws/config` + `~/.aws/credentials`
   * for the wizard's profile picker. Optional — hosts without
   * filesystem access (web shell) can omit it; the wizard then
   * gracefully degrades to a free-text input.
   */
  listAwsProfiles?(): Promise<AwsProfile[]>;
}

export interface AwsProfile {
  name: string;
  /** True when the profile is configured for SSO. */
  isSso: boolean;
  /** Which file the profile was found in. */
  source: 'config' | 'credentials';
}

// Capabilities the surrounding shell (web PWA, future Tauri/Electron)
// must provide to the shared app. Kept minimal: anything a browser
// tab can do on its own isn't here. Desktop-only hooks (OS keychain,
// system tray, native notifications, bootstrap driver) are optional
// fields so the web host can omit them entirely.
export interface ConsoleHost {
  getConfig(): Promise<HostConfig>;
  /** Persist a new cluster + its key, and select it. Returns the stored Cluster. */
  addCluster(input: AddClusterInput): Promise<Cluster>;
  /** Switch the active cluster. Pass null to deselect (UI shows "no cluster"). */
  selectCluster(clusterId: string | null): Promise<void>;
  /** Remove a cluster + its key. If it was selected, selection falls back to the first remaining cluster (or null). */
  removeCluster(clusterId: string): Promise<void>;
  /**
   * Set (or clear, with `null`) the cluster's stored
   * `stateBackendUrl`. Settings calls this with `null` after a
   * successful promotion (local state has been archived; no URL to
   * cache) and with the migration URL after a successful demotion
   * (so a future re-promotion can default the input field).
   * Optional: only the desktop host implements it (web shell omits
   * bootstrap entirely).
   */
  setClusterStateBackend?(clusterId: string, url: string | null): Promise<void>;
  openExternal(url: string): Promise<void>;
  notify?(opts: { title: string; body?: string }): Promise<void>;
  bootstrap?: BootstrapHost;
  /**
   * Local-runtime lifecycle for `appliance-base-local` clusters. The
   * desktop drives k3d (start/stop/delete) so the api-server's
   * LocalContainerDeploymentService can apply k8s manifests against
   * a running cluster. Optional — the web shell has no shell access
   * to k3d, so it can omit this entirely.
   */
  local?: LocalRuntimeHost;
}

export interface LocalClusterInput {
  clusterName?: string;
  hostPort?: number;
}

export interface LocalClusterStatus {
  exists: boolean;
  running: boolean;
  clusterName: string;
  /** Populated when the status check itself failed (k3d/docker missing). */
  message?: string;
}

// Runtime-level input — covers the cluster, the api-server sidecar,
// the bound data dir, and the host-side api port. All optional;
// host defaults match the demo script (cluster `appliance-local`,
// namespace `appliance`, host port 8081, api port 3030,
// data dir = appDataDir/local-runtime).
export interface LocalRuntimeInput {
  clusterName?: string;
  namespace?: string;
  hostPort?: number;
  apiPort?: number;
  dataDir?: string;
}

export interface ResolvedRuntimeConfig {
  clusterName: string;
  namespace: string;
  hostPort: number;
  apiPort: number;
  dataDir: string;
  apiServerUrl: string;
  nodePortMin: number;
  nodePortMax: number;
}

export interface ApiServerStatus {
  running: boolean;
  pid?: number;
  port?: number;
  startedAt?: string;
  logPath?: string;
  /** Surfaces "api-server exited" or "reachable but unmanaged" hints. */
  message?: string;
}

export interface LocalRuntimeStatus {
  cluster: LocalClusterStatus;
  apiServer: ApiServerStatus;
  config: ResolvedRuntimeConfig;
  /** Persisted cluster id under which the runtime is auto-registered,
   *  so the Console can select it like any cloud cluster. Absent until
   *  the first successful start. */
  clusterId?: string;
}

export interface LocalDeploymentInfo {
  name: string;
  image?: string;
  desired: number;
  ready: number;
  available: number;
  createdAt?: string;
}

export interface LocalPodInfo {
  name: string;
  phase: string;
  ready: boolean;
  restartCount: number;
  containerImage?: string;
  createdAt?: string;
}

export interface LocalServiceInfo {
  name: string;
  serviceType: string;
  clusterIp?: string;
  nodePort?: number;
  targetPort?: number;
}

export interface LocalWorkloads {
  deployments: LocalDeploymentInfo[];
  pods: LocalPodInfo[];
  services: LocalServiceInfo[];
}

export interface LocalPodLogsInput {
  podName: string;
  container?: string;
  tailLines?: number;
  clusterName?: string;
  namespace?: string;
}

/** Parsed contents of an appliance manifest (json or sandbox-evaluated ts/js). */
export interface LocalApplianceManifest {
  manifest?: string;
  name: string;
  type?: string;
  port?: number;
  platform?: string;
  /** Env block straight from the manifest (passed through as-is). */
  env?: Record<string, string>;
  /** Absolute path of the manifest file the desktop just read. */
  manifestPath: string;
}

export interface LocalBuildAndImportInput {
  /** Build-context folder (parent of the Dockerfile + manifest). */
  path: string;
  /** Image tag, e.g. "demo-node-container:latest". */
  imageTag: string;
  /** Optional docker --platform override (e.g. "linux/amd64"). */
  platform?: string;
  /** k3d cluster to import into; defaults to the active local runtime cluster. */
  clusterName?: string;
}

/** Streaming log event emitted while a child process runs. */
export interface LocalLogEvent {
  type: 'log';
  /** "stdout" / "stderr" for actual output; "meta" for command echoes. */
  stream: 'stdout' | 'stderr' | 'meta';
  message: string;
}

/**
 * One row in the prerequisite report rendered before the user can start
 * the local runtime. The desktop probes each tool with `<tool> --version`
 * and reports installed/version/install-hint so the UI can show a
 * copy-paste install command instead of an opaque "spawn failed".
 */
export interface LocalPreflightCheck {
  /** Tool name as invoked on the command line (`docker`, `k3d`, …). */
  tool: string;
  /** True iff `<tool> --version` exited 0. */
  installed: boolean;
  /** First line of stdout from `<tool> --version`, when installed. */
  version?: string;
  /** One-line human description of what this tool is for. */
  purpose: string;
  /** Platform-appropriate install command (empty on unsupported OS). */
  installHint: string;
  /**
   * True when `host.local.installPrereq(tool)` can drive an automatic
   * install (docker engine is guidance-only).
   */
  autoInstallable: boolean;
  /** stderr or io::Error captured when the version check failed. */
  error?: string;
}

/**
 * Outcome of a helper-driven install for a single tool. The sidecar
 * surfaces these so the UI can render per-tool success/failure rather
 * than collapsing the batch into a single boolean.
 */
export interface LocalHelperInstallOutcome {
  tool: string;
  status: 'installed' | 'already' | 'guidance' | 'failed';
  message: string;
}

export interface LocalHelperInstallResult {
  outcomes: LocalHelperInstallOutcome[];
}

/**
 * Streamed progress event from a helper-install run. Mirrors the
 * bootstrap channel shape so callers can use the same Tauri Channel
 * plumbing.
 */
export interface LocalHelperProgressEvent {
  type: string;
  stage?: string;
  message?: string;
}

export interface LocalRuntimeHost {
  /** Probe the local-runtime prerequisites (docker, k3d, kubectl). */
  preflight(): Promise<LocalPreflightCheck[]>;
  /**
   * Drive the helper to install missing prerequisites. `tools` is
   * either explicit names or `undefined` to install everything
   * required. Progress events stream onto `onEvent`; the returned
   * promise resolves with per-tool outcomes once the run completes.
   * Optional on hosts (web shell) that can't drive a Node sidecar.
   */
  installPrereq?(
    tools: string[] | undefined,
    onEvent: (event: LocalHelperProgressEvent) => void,
    opts?: { force?: boolean }
  ): Promise<LocalHelperInstallResult>;
  /** Legacy cluster-only status (kept for backwards compat). */
  status(input?: LocalClusterInput): Promise<LocalClusterStatus>;
  start(input?: LocalClusterInput): Promise<LocalClusterStatus>;
  stop(input?: LocalClusterInput): Promise<LocalClusterStatus>;
  /** Permanently delete the cluster + all of its state. */
  delete(input?: LocalClusterInput): Promise<LocalClusterStatus>;

  /** Combined cluster + api-server + persisted-cluster snapshot. */
  runtimeStatus(input?: LocalRuntimeInput): Promise<LocalRuntimeStatus>;
  /** Idempotently bring up cluster + api-server + auto-register the
   *  resulting cluster so the Console can talk to it. */
  startRuntime(input?: LocalRuntimeInput): Promise<LocalRuntimeStatus>;
  /** Kill api-server + stop cluster. Data is preserved. */
  stopRuntime(input?: LocalRuntimeInput): Promise<LocalRuntimeStatus>;
  /** Kill api-server, delete cluster, forget the registered Console
   *  cluster + key. The data dir itself is left on disk. */
  deleteRuntime(input?: LocalRuntimeInput): Promise<LocalRuntimeStatus>;
  /** Snapshot of Deployments / Pods / Services in the appliance namespace. */
  listWorkloads(input?: LocalRuntimeInput): Promise<LocalWorkloads>;
  /** One-shot `kubectl logs --tail` for the named pod. */
  tailPodLogs(input: LocalPodLogsInput): Promise<string>;

  /** Open a native folder picker. Returns null on cancel. */
  pickDirectory(): Promise<string | null>;
  /** Resolve an appliance manifest in the given folder. `.json` is
   *  read directly; `.ts` / `.js` (and `.mts` / `.cts` / `.mjs` /
   *  `.cjs`) are evaluated through the CLI's QuickJS sandbox via the
   *  sidecar. Errors if no manifest is found or the sandbox rejects. */
  readApplianceManifest(path: string): Promise<LocalApplianceManifest>;
  /** docker build → k3d image import, streaming each command's output
   *  to onEvent. Resolves with the resulting image tag on success. */
  buildAndImportImage(input: LocalBuildAndImportInput, onEvent: (event: LocalLogEvent) => void): Promise<string>;
}

export type {
  ApiServerUpdateInput,
  ApiServerUpdateOptions,
  BaselineUpdateInput,
  BaselineUpdateOptions,
  BootstrapEvent,
  BootstrapInput,
  BootstrapOptions,
  BootstrapPhase,
  BootstrapPriorOutputs,
  BootstrapResult,
  LatestGhcrTagInput,
  StateDemotionInput,
  StateDemotionOptions,
  StatePromotionInput,
  StatePromotionOptions,
};
