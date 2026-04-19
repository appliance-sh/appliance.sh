import type {
  BootstrapEvent,
  BootstrapInput,
  BootstrapOptions,
  BootstrapPhase,
  BootstrapResult,
} from '@appliance.sh/bootstrap';

export interface HostConfig {
  apiServerUrl: string | null;
  apiKey: { id: string; secret: string } | null;
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
}

// Capabilities the surrounding shell (web PWA, future Tauri/Electron)
// must provide to the shared app. Kept minimal: anything a browser
// tab can do on its own isn't here. Desktop-only hooks (OS keychain,
// system tray, native notifications, bootstrap driver) are optional
// fields so the web host can omit them entirely.
export interface ConsoleHost {
  getConfig(): Promise<HostConfig>;
  saveApiKey(key: { id: string; secret: string }): Promise<void>;
  clearApiKey(): Promise<void>;
  saveApiServerUrl?(url: string): Promise<void>;
  /** Clears both the api-server URL and the API key. Idempotent. */
  disconnect?(): Promise<void>;
  openExternal(url: string): Promise<void>;
  notify?(opts: { title: string; body?: string }): Promise<void>;
  bootstrap?: BootstrapHost;
}

export type { BootstrapEvent, BootstrapInput, BootstrapOptions, BootstrapPhase, BootstrapResult };
