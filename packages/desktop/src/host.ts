import { invoke, Channel } from '@tauri-apps/api/core';
import { open as openShell } from '@tauri-apps/plugin-shell';
import { sendNotification } from '@tauri-apps/plugin-notification';
import type {
  BootstrapEvent,
  BootstrapInput,
  BootstrapOptions,
  BootstrapResult,
  ConsoleHost,
  HostConfig,
} from '@appliance.sh/app';

// Tauri host: api-server URL lives in a JSON config file under the
// app config dir; the API key lives in the OS keychain. Both are
// read/written through Rust commands defined in src-tauri/src/lib.rs.
// Bootstrap runs through a Node sidecar the Rust side spawns —
// progress events stream back over a Tauri Channel.
export const tauriHost: ConsoleHost = {
  async getConfig(): Promise<HostConfig> {
    return invoke<HostConfig>('get_config');
  },

  async saveApiKey(key) {
    await invoke('save_api_key', { id: key.id, secret: key.secret });
  },

  async clearApiKey() {
    await invoke('clear_api_key');
  },

  async saveApiServerUrl(url) {
    await invoke('save_api_server_url', { url });
  },

  async disconnect() {
    await invoke('disconnect');
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
