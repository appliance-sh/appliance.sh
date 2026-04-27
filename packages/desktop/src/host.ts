import { invoke, Channel } from '@tauri-apps/api/core';
import { open as openShell } from '@tauri-apps/plugin-shell';
import { sendNotification } from '@tauri-apps/plugin-notification';
import type {
  AddClusterInput,
  BootstrapEvent,
  BootstrapInput,
  BootstrapOptions,
  BootstrapResult,
  Cluster,
  ConsoleHost,
  HostConfig,
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
  },
};
