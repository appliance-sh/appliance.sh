import { invoke, Channel } from '@tauri-apps/api/core';
import { open as openShell } from '@tauri-apps/plugin-shell';
import { sendNotification } from '@tauri-apps/plugin-notification';
import type {
  AddClusterInput,
  ApiServerUpdateInput,
  ApiServerUpdateOptions,
  AwsProfile,
  BaselineUpdateInput,
  BaselineUpdateOptions,
  BootstrapEvent,
  BootstrapInput,
  BootstrapOptions,
  BootstrapResult,
  Cluster,
  ConsoleHost,
  HostConfig,
  LatestGhcrTagInput,
  LocalClusterInput,
  LocalClusterStatus,
  StateDemotionInput,
  StateDemotionOptions,
  StatePromotionInput,
  StatePromotionOptions,
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
    async status(input?: LocalClusterInput): Promise<LocalClusterStatus> {
      return invoke<LocalClusterStatus>('local_cluster_status', { input: input ?? {} });
    },
    async start(input?: LocalClusterInput): Promise<LocalClusterStatus> {
      return invoke<LocalClusterStatus>('start_local_cluster', { input: input ?? {} });
    },
    async stop(input?: LocalClusterInput): Promise<LocalClusterStatus> {
      return invoke<LocalClusterStatus>('stop_local_cluster', { input: input ?? {} });
    },
    async delete(input?: LocalClusterInput): Promise<LocalClusterStatus> {
      return invoke<LocalClusterStatus>('delete_local_cluster', { input: input ?? {} });
    },
  },
};
