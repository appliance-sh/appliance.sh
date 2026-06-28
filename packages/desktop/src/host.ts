import { invoke, Channel } from '@tauri-apps/api/core';
import { open as openShell } from '@tauri-apps/plugin-shell';
import { sendNotification } from '@tauri-apps/plugin-notification';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { check as checkForUpdate, type Update } from '@tauri-apps/plugin-updater';
import { relaunch as relaunchApp } from '@tauri-apps/plugin-process';
import type {
  AvailableUpdate,
  UpdateProgress,
  MicroVmStatus,
  MicroVmSummary,
  AddClusterInput,
  ApiServerUpdateInput,
  ApiServerUpdateOptions,
  AwsProfile,
  BaselineUpdateInput,
  BaselineUpdateOptions,
  BootstrapEvent,
  BootstrapInput,
  BootstrapOptions,
  BootstrapInClusterInput,
  BootstrapInClusterResult,
  BootstrapResult,
  Cluster,
  ConsoleHost,
  HostConfig,
  LatestGhcrTagInput,
  LocalApplianceManifest,
  LocalBuildAndImportInput,
  LocalHelperInstallResult,
  LocalLogEvent,
  LocalPodLogsInput,
  LocalPreflightCheck,
  LocalRuntimeInput,
  LocalWorkloads,
  StateDemotionInput,
  StateDemotionOptions,
  StatePromotionInput,
  StatePromotionOptions,
  EgressPolicy,
  EgressEvent,
  CredentialsState,
  TerminalEvent,
  TerminalOpenOptions,
  TerminalSession,
} from '@appliance.sh/app';

// Tauri host: each cluster's URL/name lives in a JSON config file
// under the app config dir; each cluster's API key lives in the OS
// keychain at account `cluster:<id>`. Both are read/written through
// Rust commands defined in src-tauri/src/lib.rs. Bootstrap runs
// through a Node sidecar the Rust side spawns — progress events
// stream back over a Tauri Channel.
export const tauriHost: ConsoleHost = {
  async getConfig(): Promise<HostConfig> {
    return invoke<HostConfig>('get_config');
  },

  async addCluster(input: AddClusterInput): Promise<Cluster> {
    return invoke<Cluster>('add_cluster', { input });
  },

  async selectCluster(clusterId: string | null): Promise<void> {
    await invoke('select_cluster', { clusterId });
  },

  async removeCluster(clusterId: string): Promise<void> {
    await invoke('remove_cluster', { clusterId });
  },

  async setClusterStateBackend(clusterId: string, url: string | null): Promise<void> {
    await invoke('set_cluster_state_backend', { clusterId, url });
  },

  async openExternal(url) {
    await openShell(url);
  },

  async notify({ title, body }) {
    await sendNotification({ title, body });
  },

  bootstrap: {
    async run(
      input: BootstrapInput,
      options: BootstrapOptions | undefined,
      onEvent: (event: BootstrapEvent) => void
    ): Promise<BootstrapResult> {
      const channel = new Channel<BootstrapEvent>();
      channel.onmessage = onEvent;
      return invoke<BootstrapResult>('run_bootstrap', {
        input: { bootstrapInput: input, options: options ?? {} },
        onEvent: channel,
      });
    },
    async promoteState(
      input: StatePromotionInput,
      options: StatePromotionOptions | undefined,
      onEvent: (event: BootstrapEvent) => void
    ): Promise<void> {
      const channel = new Channel<BootstrapEvent>();
      channel.onmessage = onEvent;
      await invoke('promote_state', {
        input: { input, options: options ?? {} },
        onEvent: channel,
      });
    },
    async demoteState(
      input: StateDemotionInput,
      options: StateDemotionOptions | undefined,
      onEvent: (event: BootstrapEvent) => void
    ): Promise<void> {
      const channel = new Channel<BootstrapEvent>();
      channel.onmessage = onEvent;
      await invoke('demote_state', {
        input: { input, options: options ?? {} },
        onEvent: channel,
      });
    },
    async updateApiServer(
      input: ApiServerUpdateInput,
      options: ApiServerUpdateOptions | undefined,
      onEvent: (event: BootstrapEvent) => void
    ): Promise<void> {
      const channel = new Channel<BootstrapEvent>();
      channel.onmessage = onEvent;
      await invoke('update_api_server', {
        input: { input, options: options ?? {} },
        onEvent: channel,
      });
    },
    async updateBaseline(
      input: BaselineUpdateInput,
      options: BaselineUpdateOptions | undefined,
      onEvent: (event: BootstrapEvent) => void
    ): Promise<void> {
      const channel = new Channel<BootstrapEvent>();
      channel.onmessage = onEvent;
      await invoke('update_baseline', {
        input: { input, options: options ?? {} },
        onEvent: channel,
      });
    },
    async latestApiServerVersion(input?: LatestGhcrTagInput): Promise<{ version: string }> {
      const channel = new Channel<BootstrapEvent>();
      // We don't surface progress for the version lookup — but the
      // Tauri command always wires a Channel for parity with the
      // event-streaming sidecar calls.
      channel.onmessage = () => {};
      return invoke<{ version: string }>('latest_api_server_version', {
        input: { input: input ?? {} },
        onEvent: channel,
      });
    },
    async listAwsProfiles(): Promise<AwsProfile[]> {
      return invoke<AwsProfile[]>('list_aws_profiles');
    },
  },

  local: {
    async preflight(): Promise<LocalPreflightCheck[]> {
      return invoke<LocalPreflightCheck[]>('local_preflight');
    },
    async installPrereq(
      tools: string[] | undefined,
      onEvent: (event: { type: string; stage?: string; message?: string }) => void,
      opts?: { force?: boolean }
    ): Promise<LocalHelperInstallResult> {
      const channel = new Channel<{ type: string; stage?: string; message?: string }>();
      channel.onmessage = onEvent;
      return invoke<LocalHelperInstallResult>('local_helper_install', {
        input: { tools, force: opts?.force ?? false },
        onEvent: channel,
      });
    },
    async startContainerRuntime(): Promise<void> {
      await invoke('start_container_runtime');
    },
    async listWorkloads(input?: LocalRuntimeInput): Promise<LocalWorkloads> {
      return invoke<LocalWorkloads>('list_local_workloads', { input: input ?? null });
    },
    async tailPodLogs(input: LocalPodLogsInput): Promise<string> {
      return invoke<string>('tail_local_pod_logs', { input });
    },
    async pickDirectory(): Promise<string | null> {
      // Tauri's dialog plugin returns the chosen folder path, or null
      // on cancel. multiple:false guarantees a single string back.
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: 'Select an appliance folder',
      });
      return typeof picked === 'string' ? picked : null;
    },
    async readApplianceManifest(path: string): Promise<LocalApplianceManifest> {
      return invoke<LocalApplianceManifest>('read_appliance_manifest', { path });
    },
    async buildAndImportImage(
      input: LocalBuildAndImportInput,
      onEvent: (event: LocalLogEvent) => void
    ): Promise<string> {
      const channel = new Channel<LocalLogEvent>();
      channel.onmessage = onEvent;
      return invoke<string>('build_and_import_image', { input, onEvent: channel });
    },
    async bootstrapInClusterApiServer(input?: BootstrapInClusterInput): Promise<BootstrapInClusterResult> {
      return invoke<BootstrapInClusterResult>('bootstrap_in_cluster_api_server', { input: input ?? {} });
    },
  },

  vm: {
    list() {
      return invoke<MicroVmSummary[]>('microvm_list');
    },
    async install() {
      await invoke('microvm_install');
    },
    instance(name?: string) {
      // `name` rides along on every call; the Rust side defaults a
      // null/empty name to the canonical "appliance" VM.
      const vm = name ?? null;
      return {
        name: name ?? 'appliance',
        status() {
          return invoke<MicroVmStatus>('microvm_status', { name: vm });
        },
        async up(onEvent: (event: { message: string }) => void) {
          const channel = new Channel<{ type: string; message?: string }>();
          channel.onmessage = (event) => {
            if (event?.message) onEvent({ message: event.message });
          };
          await invoke('microvm_up', { name: vm, onEvent: channel });
        },
        async devUp(onEvent: (event: { message: string }) => void, opts?: { mount?: string }) {
          const channel = new Channel<{ type: string; message?: string }>();
          channel.onmessage = (event) => {
            if (event?.message) onEvent({ message: event.message });
          };
          await invoke('microvm_dev_up', { name: vm, mount: opts?.mount ?? null, onEvent: channel });
        },
        async cleanupShell() {
          await invoke('microvm_dev_cleanup', { name: vm });
        },
        stop() {
          return invoke('microvm_stop', { name: vm });
        },
        remove() {
          return invoke('microvm_delete', { name: vm });
        },
        egress: {
          get() {
            return invoke<EgressPolicy>('microvm_egress_get', { name: vm });
          },
          async setDefault(action: 'allow' | 'deny') {
            await invoke('microvm_egress_default', { name: vm, action });
          },
          async addRule(action: 'allow' | 'deny', host: string) {
            await invoke('microvm_egress_rule', { name: vm, action, host });
          },
          async setMitm(enabled: boolean) {
            await invoke('microvm_egress_mitm', { name: vm, enabled });
          },
          async reset() {
            await invoke('microvm_egress_reset', { name: vm });
          },
          log(tail?: number) {
            return invoke<EgressEvent[]>('microvm_egress_log', { name: vm, tail: tail ?? null });
          },
          async clearLog() {
            await invoke('microvm_egress_clear_log', { name: vm });
          },
        },
        creds: {
          list() {
            return invoke<CredentialsState>('microvm_creds_list', { name: vm });
          },
          async add(rule: { host: string; capture: boolean; inject: boolean; header?: string; helper?: string }) {
            await invoke('microvm_creds_add', { name: vm, input: rule });
          },
          async remove(host: string) {
            await invoke('microvm_creds_remove', { name: vm, host });
          },
          async setSecret(host: string, value: string, header?: string) {
            await invoke('microvm_creds_set', { name: vm, host, value, header: header ?? null });
          },
          async forget() {
            await invoke('microvm_creds_forget', { name: vm });
          },
        },
      };
    },
  },

  terminal: {
    async open(opts: TerminalOpenOptions, onEvent: (event: TerminalEvent) => void): Promise<TerminalSession> {
      const channel = new Channel<TerminalEvent>();
      channel.onmessage = onEvent;
      const id = await invoke<string>('terminal_open', { input: opts, onEvent: channel });
      return {
        id,
        write: (data: string) => invoke('terminal_write', { id, data }),
        resize: (cols: number, rows: number) => invoke('terminal_resize', { id, cols, rows }),
        close: () => invoke('terminal_close', { id }),
      };
    },
  },

  updater: {
    async check(): Promise<AvailableUpdate | null> {
      // `check()` pulls + verifies the signed manifest from the
      // `plugins.updater.endpoints` feed. It resolves to null when the
      // running build is already current, and to an Update handle (which
      // we stash for downloadAndInstall) when a newer signed bundle
      // exists. A bad pubkey / unreachable feed throws — surfaced to the
      // Settings panel verbatim.
      const update = await checkForUpdate();
      pendingUpdate = update;
      if (!update) return null;
      return {
        version: update.version,
        currentVersion: update.currentVersion,
        // The plugin exposes the manifest's release notes as `body`.
        notes: update.body || undefined,
        date: update.date || undefined,
      };
    },
    async downloadAndInstall(onProgress: (progress: UpdateProgress) => void): Promise<void> {
      if (!pendingUpdate) {
        // Defensive: the UI only enables install after a successful
        // check, but a stale render could call through. Re-resolve so
        // we never install an unverified bundle.
        pendingUpdate = await checkForUpdate();
      }
      if (!pendingUpdate) {
        throw new Error('No pending update — run a check first.');
      }
      let downloaded = 0;
      let contentLength: number | undefined;
      // The plugin streams typed progress events: Started carries the
      // (optional) Content-Length, Progress carries each chunk's size,
      // Finished closes the transfer. Accumulate into the host's
      // UpdateProgress shape the React panel renders.
      await pendingUpdate.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            contentLength = event.data.contentLength;
            downloaded = 0;
            onProgress({ contentLength, downloaded });
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            onProgress({ contentLength, downloaded });
            break;
          case 'Finished':
            onProgress({ contentLength, downloaded: contentLength ?? downloaded });
            break;
          default:
            break;
        }
      });
    },
    async relaunch(): Promise<void> {
      await relaunchApp();
    },
  },
};

// The Update handle resolved by the most recent `updater.check()`.
// downloadAndInstall needs the same handle check() produced (it carries
// the verified download URL + signature), so we keep it module-scoped
// between the two calls rather than round-tripping it through React.
let pendingUpdate: Update | null = null;
