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

/** A pending self-update the updater feed advertised — the running app
 *  is behind `version`. Mirrors the fields the Tauri updater plugin's
 *  `check()` resolves with that the UI actually renders. */
export interface AvailableUpdate {
  /** Version on the feed (e.g. "1.49.0"). Always newer than the
   *  running app — the host only returns this when an update exists. */
  version: string;
  /** The currently-running app version, for a before/after display. */
  currentVersion: string;
  /** Release notes pulled from the update manifest, if the publisher
   *  included them. */
  notes?: string;
  /** ISO-8601 publish date from the manifest, if present. */
  date?: string;
}

/** Progress of an in-flight download+install, surfaced so the UI can
 *  render a determinate bar when the manifest carried a content length
 *  and a spinner otherwise. */
export interface UpdateProgress {
  /** Total bytes to download, if the server sent a Content-Length.
   *  Undefined → render indeterminate. */
  contentLength?: number;
  /** Bytes downloaded so far across the whole transfer. */
  downloaded: number;
}

/**
 * Self-update driver. Desktop-only: the web shell auto-updates by
 * virtue of being a page reload, so it omits this capability entirely
 * (the UI hides the "Check for updates" panel when it's absent). The
 * Tauri host implements it against `@tauri-apps/plugin-updater` +
 * `@tauri-apps/plugin-process`, gated on the signed update feed
 * configured in `tauri.conf.json`'s `plugins.updater`.
 */
export interface UpdaterHost {
  /**
   * Ask the update feed whether a newer signed build exists. Resolves
   * with the update when one is available, or `null` when the running
   * app is current. Rejects only on a genuine failure to reach/verify
   * the feed (offline, signature mismatch, malformed manifest).
   */
  check(): Promise<AvailableUpdate | null>;
  /**
   * Download the pending update and install it in place, reporting
   * byte-level progress through `onProgress`. The update must come
   * from a prior `check()` in the same session (the plugin caches the
   * resolved Update handle). Resolves once the bundle is installed;
   * the caller then invokes `relaunch()` to boot into it.
   */
  downloadAndInstall(onProgress: (progress: UpdateProgress) => void): Promise<void>;
  /** Restart the app into the freshly-installed version. */
  relaunch(): Promise<void>;
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
   * Local-runtime support surface: preflight, prerequisite installs,
   * container-runtime start, the appliance build/deploy file-picker
   * bits, and engine-routed workload/log reads for the microVM. The
   * microVM lifecycle itself lives under `vm`. Optional — the web
   * shell has no shell access, so it can omit this entirely.
   */
  local?: LocalRuntimeHost;
  /**
   * MicroVM engine (appliance-vm): an isolated VM Appliance boots
   * itself — no docker provider required for the cluster. Optional;
   * desktop-only, and only meaningful where a VM backend exists.
   */
  vm?: MicroVmHost;
  /**
   * Interactive PTY terminals into local workloads (`kubectl exec
   * -it`). Optional — desktop-only; needs a pseudo-terminal the web
   * shell can't provide.
   */
  terminal?: TerminalHost;
  /**
   * Self-update from the signed update feed. Optional — desktop-only;
   * the web shell ships continuously and has nothing to self-update.
   * When present, Settings exposes a "Check for updates" panel.
   */
  updater?: UpdaterHost;
}

export type TerminalEvent = { type: 'data'; data: string } | { type: 'exit'; code?: number };

export interface TerminalOpenOptions {
  /** kubectl target — a pod, or any exec-able ref like `deploy/app`. */
  target: string;
  namespace?: string;
  clusterName?: string;
  /** 'microvm' routes through the microVM's kubeconfig. */
  engine?: 'microvm';
  /** Shell target. Absent → `kubectl exec` into the `target` pod. 'dev'
   *  → a shell in the microVM's dev workspace; 'host' → a raw root
   *  shell on the microVM host. Both ride `kubectl debug node/` +
   *  chroot (microVM engine only). */
  mode?: 'dev' | 'host';
  /** Command to run; defaults to an interactive `/bin/sh`. */
  command?: string[];
  container?: string;
  cols: number;
  rows: number;
  /** Reattachable guest tmux session id (E3.4). Only the vsock host/dev
   *  shell honours it — the argv gains `--session <id>` so the PTY attaches
   *  to (or creates) the named guest tmux session `appliance-<id>`, which
   *  survives this client disconnecting and a desktop restart. Absent for
   *  pod-exec shells (no tmux behind them) — they stay non-reattachable. */
  sessionId?: string;
}

/** A live PTY session. Output arrives on the `onEvent` callback passed
 *  to `open`; input + control go back through these methods. */
export interface TerminalSession {
  id: string;
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  close(): Promise<void>;
}

/** One reattachable guest tmux session, as reported by `terminal.list`.
 *  Mirrors SessionInfo in packages/vm/src/shell.rs (the `appliance-`
 *  prefix stripped). */
export interface TerminalSessionInfo {
  /** Host-minted id — the desktop tab's session id (`<mode>-<uuid>`). */
  id: string;
  /** tmux `session_activity` (Unix epoch seconds), when known. */
  lastActivity?: number;
}

export interface TerminalHost {
  open(opts: TerminalOpenOptions, onEvent: (event: TerminalEvent) => void): Promise<TerminalSession>;
  /** Enumerate the VM's live reattachable guest tmux sessions, so the
   *  store can rehydrate dock tabs on app launch (E3.4). Optional — a host
   *  without reattachable sessions omits it. */
  list?(vmName?: string): Promise<TerminalSessionInfo[]>;
  /** Destroy a guest tmux session by id (the explicit tab-close path).
   *  Closing the PTY only *detaches*; this is what actually tears the
   *  in-guest session down. Optional, paired with `list`. */
  kill?(vmName: string | undefined, id: string): Promise<void>;
}

/**
 * Stable cluster id for the microVM engine. Doubles as the CLI
 * profile name in ~/.appliance/profiles.json — mirrors
 * MICROVM_CLUSTER_ID in the desktop's lib.rs and MICROVM_PROFILE in
 * the CLI.
 */
export const MICROVM_CLUSTER_ID = 'microvm';

/** The canonical (default) microVM name — keeps the bare `microvm`
 *  cluster id. Mirrors DEFAULT_VM_NAME in the CLI and MICROVM_NAME in
 *  the desktop's lib.rs. */
export const DEFAULT_MICROVM_NAME = 'appliance';

/** Desktop cluster id a VM registers under. The default VM keeps the
 *  bare `microvm`; others get `microvm-<name>`. Mirrors
 *  microvm_cluster_id in lib.rs and profileForVm in the CLI. */
export function microVmClusterId(name: string): string {
  return name === DEFAULT_MICROVM_NAME ? MICROVM_CLUSTER_ID : `${MICROVM_CLUSTER_ID}-${name}`;
}

/** The VM name behind a cluster id, or null if the id isn't a microVM
 *  cluster. `microvm` → `appliance`; `microvm-<name>` → `<name>`. */
export function microVmNameFromClusterId(clusterId: string): string | null {
  if (clusterId === MICROVM_CLUSTER_ID) return DEFAULT_MICROVM_NAME;
  const prefix = `${MICROVM_CLUSTER_ID}-`;
  return clusterId.startsWith(prefix) ? clusterId.slice(prefix.length) : null;
}

/** Whether a cluster id belongs to the microVM engine (any VM). */
export function isMicroVmClusterId(clusterId: string): boolean {
  return microVmNameFromClusterId(clusterId) !== null;
}

/** A microVM bring-up stage, mirrors Phase in packages/vm/src/bringup.rs.
 *  Ordered: media → booting → network → cluster → ready (terminal), or
 *  failed (terminal). */
export type MicroVmPhase = 'media' | 'booting' | 'network' | 'cluster' | 'ready' | 'failed';

export interface MicroVmStatus {
  /** appliance-vm binary present on this machine. */
  available: boolean;
  /** Not installed, but the host carries a binary it can install. */
  installable: boolean;
  exists: boolean;
  running: boolean;
  /** kubeconfig fetched and the host process alive — the cluster
   *  answers. Gated on `running`, so a stopped VM doesn't read ready. */
  kubeconfigReady: boolean;
  /** Current bring-up stage while starting; absent when not running or
   *  when the engine predates phase reporting. Lets the badge show
   *  "starting (k3s)" / "failed" instead of a blunt "running". */
  phase?: MicroVmPhase;
  /** Whether this VM is provisioned as a development environment
   *  (`appliance vm dev up`) — drives the dev-shell affordance. */
  dev: boolean;
  /** Host folder shared into `/persist/workspace` (`devMount`), when one
   *  is mounted. The agent launcher gates on this — an agent runs in (and
   *  writes its registry to) the shared workspace. */
  devMount?: string;
  apiServerUrl: string;
  message?: string;
}

/** Outbound-traffic policy for the microVM's egress proxy. Mirrors
 *  EgressPolicy in packages/vm/src/egress.rs. */
export interface EgressPolicy {
  default: 'allow' | 'deny';
  /** Host suffixes always allowed. */
  allow: string[];
  /** Host suffixes always denied (deny wins over allow). */
  deny: string[];
  /** TLS interception on — the proxy decrypts allowed HTTPS. */
  mitm: boolean;
  /** Path to the VM's egress CA cert, when interception is on. */
  caPath?: string;
}

/** One recorded egress request — mirrors TrafficEvent in
 *  packages/vm/src/traffic.rs. */
export interface EgressEvent {
  /** Unix epoch milliseconds. */
  ts: number;
  host: string;
  port: number;
  method: string;
  /** Present for intercepted HTTPS / plain HTTP; absent for blind CONNECT. */
  path?: string;
  /** 'allow' | 'deny' | 'mitm'. */
  decision: 'allow' | 'deny' | 'mitm';
}

export interface MicroVmEgressHost {
  get(): Promise<EgressPolicy>;
  setDefault(action: 'allow' | 'deny'): Promise<void>;
  addRule(action: 'allow' | 'deny', host: string): Promise<void>;
  setMitm(enabled: boolean): Promise<void>;
  reset(): Promise<void>;
  /** Recent recorded traffic, oldest-first. */
  log(tail?: number): Promise<EgressEvent[]>;
  /** Forget all recorded traffic. */
  clearLog(): Promise<void>;
}

/** Per-host credential capture/injection rule — mirrors
 *  CredentialRule in packages/vm/src/creds.rs. */
export interface CredentialRule {
  host: string;
  capture: boolean;
  inject: boolean;
  header: string;
  helper?: string;
}

/** A stored secret, value masked. */
export interface StoredSecret {
  host: string;
  header: string;
  masked: string;
}

export interface CredentialsState {
  rules: CredentialRule[];
  secrets: StoredSecret[];
}

export interface MicroVmCredsHost {
  list(): Promise<CredentialsState>;
  add(rule: { host: string; capture: boolean; inject: boolean; header?: string; helper?: string }): Promise<void>;
  remove(host: string): Promise<void>;
  /** Manually store a secret (e.g. paste an API key). */
  setSecret(host: string, value: string, header?: string): Promise<void>;
  /** Forget all stored secrets (rules are kept). */
  forget(): Promise<void>;
}

/** A coding agent recorded in a project's `.appliance/agents.json`
 *  registry (Phase 5), reconciled against the VM's live tmux sessions.
 *  Mirrors AgentInfo in the desktop's lib.rs (the CLI's `appliance agent
 *  list --json` row). Surfaced so a rehydrated agent tab can show its
 *  type / task / status. */
export interface AgentInfo {
  /** Host id — the `agent-` prefix stripped from `sessionId`. */
  id: string;
  /** Adapter key, e.g. `claude-code`. */
  type: string;
  /** Autonomous: the prompt. Interactive: an optional label. */
  task?: string;
  status: 'running' | 'done' | 'error' | 'exited';
  /** The `agent-<uuid>` tmux session id — the terminal tab attaches to it. */
  sessionId: string;
  mode?: 'interactive' | 'autonomous';
  /** Reconciled liveness: true/false, or null when the VM was unreachable. */
  live?: boolean | null;
}

/** Launch a coding agent in a VM (Phase 5, A5). The desktop pre-mints the
 *  `agent-<uuid>` session id so it can open the observe tab against a
 *  known id the moment the launch returns. */
export interface AgentLaunchInput {
  /** Adapter type. Defaults to `claude-code`. */
  type?: string;
  /** Optional task prompt (interactive label / autonomous prompt). */
  task?: string;
  /** Pre-minted `agent-<uuid>` session id to launch under. */
  sessionId: string;
}

/** Launch + list coding agents in one microVM (Phase 5, A5). Backed by
 *  the bundled `appliance agent` CLI + its per-project registry. */
export interface MicroVmAgentHost {
  /** Shell `appliance agent start … --no-attach`: spawn a detached,
   *  broker-wired `agent-<id>` tmux session. Resolves once the session
   *  exists (so the caller can attach an observe tab); rejects with the
   *  CLI's stderr (e.g. a missing Anthropic key). */
  start(input: AgentLaunchInput): Promise<void>;
  /** The VM's recorded agents, reconciled against live sessions. */
  list(): Promise<AgentInfo[]>;
  /** Shell `appliance agent stop <id>`: kill the agent's tmux session and
   *  mark its registry record `exited`. Called when an agent tab closes so
   *  no stale `running` row lingers. `id` is the `agent-<uuid>` session id
   *  (the CLI matches it with or without the prefix). Best-effort. */
  stop(id: string): Promise<void>;
}

/** One microVM as reported by the engine — its allocated host ports,
 *  running state, and the desktop cluster id it registers under.
 *  Mirrors MicroVmSummary in the desktop's lib.rs. */
export interface MicroVmSummary {
  name: string;
  running: boolean;
  /** Cluster answers (kubeconfig fetched) while running — lets the
   *  switcher show "starting" vs "ready" per VM. */
  clusterReady: boolean;
  /** Current bring-up stage while starting; absent when not running. */
  phase?: MicroVmPhase;
  hostPort: number;
  apiPort: number;
  registryPort: number;
  egressPort: number;
  /** Desktop cluster id this VM registers under (`microvm` / `microvm-<name>`). */
  clusterId: string;
}

/** Operations scoped to a single microVM. Appliance can run several
 *  concurrently (e.g. one for interactive dev, one for traffic
 *  testing); each is addressed by name. */
export interface MicroVmInstanceHost {
  /** The VM this handle targets. */
  readonly name: string;
  status(): Promise<MicroVmStatus>;
  /** Full `appliance vm up` orchestration, streaming progress lines. */
  up(onEvent: (event: { message: string }) => void): Promise<void>;
  /** Like `up`, but provisions the VM as a development environment
   *  (`appliance vm dev up`): dev toolchain + persistent workspace.
   *  `opts.mount` shares a host folder into /persist/workspace. */
  devUp(onEvent: (event: { message: string }) => void, opts?: { mount?: string }): Promise<void>;
  /** Sweep the debugger pods a dev/host shell leaves behind. Called
   *  when a shell terminal closes; best-effort. */
  cleanupShell(): Promise<void>;
  stop(): Promise<void>;
  /** Delete the VM and its state (stops first if needed). */
  remove(): Promise<void>;
  /** Control the VM's outbound traffic (allow/deny + TLS MITM). */
  egress: MicroVmEgressHost;
  /** Per-host credential capture/injection (apiKeyHelper). */
  creds: MicroVmCredsHost;
  /** Launch + observe coding agents in this VM (Phase 5, A5). */
  agent: MicroVmAgentHost;
}

export interface MicroVmHost {
  /** All defined VMs (running or not). */
  list(): Promise<MicroVmSummary[]>;
  /** Install the engine binary into the managed bin dir. Engine-wide,
   *  not per-VM (one binary serves every VM). */
  install(): Promise<void>;
  /** A handle scoped to one VM. Defaults to the canonical `appliance`
   *  VM, so single-VM callers can stay terse. */
  instance(name?: string): MicroVmInstanceHost;
}

// Engine-routed input for the kubectl-level reads (workloads, pod
// logs) the desktop exposes. microVM-only now that bare k3d is gone.
export interface LocalRuntimeInput {
  /** Which local engine the read addresses — microVM only, routed
   *  through the microVM's kubeconfig. */
  engine?: 'microvm';
  /** The microVM name whose kubeconfig to read; several VMs run
   *  concurrently, so the name selects which one. */
  clusterName?: string;
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
  /** Host-side registry URL the cluster pulls through (e.g. the
   *  microVM's forwarded in-VM registry `localhost:5052`). The image
   *  is tagged `<registryUrl>/<imageTag>` and pushed via `docker
   *  push`; the resolved Promise resolves with the registry-qualified
   *  ref so callers can hand it straight to api-server. Resolved from
   *  the selected cluster's `/cluster-info`. */
  registryUrl?: string;
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
  /** Tool name as invoked on the command line (`docker`, `kubectl`, …). */
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
  /**
   * For docker only: whether a daemon is actually reachable, not just
   * whether the CLI is installed (`docker --version` exits 0 even with
   * a stopped engine). Undefined for tools with no daemon (kubectl).
   * `false` means "installed but not running".
   */
  daemonRunning?: boolean;
  /**
   * For docker only, when `daemonRunning` is false: whether appliance
   * can start the runtime itself (colima is the active runtime). Drives
   * a "Start runtime" button vs. manual-start guidance.
   */
  daemonStartable?: boolean;
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
  /** Probe the local-runtime prerequisites (docker, kubectl). */
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
  /**
   * Start the container runtime (colima) when appliance can do so
   * safely — wired to the doctor view's "Start runtime" button. Same
   * code path the implicit cluster-start uses. Optional: only the
   * desktop host can manage a local runtime; rejects with an actionable
   * message for runtimes appliance can't auto-start.
   */
  startContainerRuntime?(): Promise<void>;

  // Workloads + pod logs are no longer read here: the console reads them
  // through the in-VM api-server via `ApplianceClient.listWorkloads()` /
  // `getPodLogs()` / `streamPodLogs()` (control-plane.md §4), the same
  // signed base-URL path that powers projects/deployments. No kubectl.

  /** Open a native folder picker. Returns null on cancel. */
  pickDirectory(): Promise<string | null>;
  /** Resolve an appliance manifest in the given folder. `.json` is
   *  read directly; `.ts` / `.js` (and `.mts` / `.cts` / `.mjs` /
   *  `.cjs`) are evaluated through the CLI's QuickJS sandbox via the
   *  sidecar. Errors if no manifest is found or the sandbox rejects. */
  readApplianceManifest(path: string): Promise<LocalApplianceManifest>;
  /** docker build → registry push, streaming each command's output to
   *  onEvent. Resolves with the registry-qualified image ref on
   *  success. */
  buildAndImportImage(input: LocalBuildAndImportInput, onEvent: (event: LocalLogEvent) => void): Promise<string>;
  /** Apply the in-cluster api-server manifest to the local cluster
   *  (Deployment + Service + Ingress + RBAC + PVC), wait for it to
   *  become reachable at `api.appliance.localhost`, mint a first
   *  API key via the bootstrap token. The api-server image must
   *  already live in the cluster-attached registry (pushed via
   *  `buildAndImportImage` with the appliance-api-server context).
   *  Returns the resulting URL + key. Idempotent — safe to call
   *  again to reconcile drift. */
  bootstrapInClusterApiServer(input?: BootstrapInClusterInput): Promise<BootstrapInClusterResult>;
}

export interface BootstrapInClusterInput {
  /** Override the runtime input used to resolve cluster name / data
   *  dir / namespace. Defaults to the baked-in runtime-config
   *  defaults. */
  runtime?: LocalRuntimeInput;
  /** Override the api-server image reference. Defaults to
   *  `ghcr.io/appliance-sh/api-server:latest` (pulled from ghcr on
   *  first deploy). For local dev iteration, push a built image to
   *  `<registryUrl>/appliance-api-server:<tag>` and pass that ref
   *  through here. */
  image?: string;
}

export interface BootstrapInClusterResult {
  /** URL at which the in-cluster api-server is reachable
   *  (`http://api.appliance.localhost[:port]`). */
  apiServerUrl: string;
  /** API key minted via the bootstrap token — caller persists it
   *  alongside the cluster registration. Shape matches what
   *  api-server's POST /bootstrap/create-key returns. */
  apiKey: { id: string; secret: string };
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
