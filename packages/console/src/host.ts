import type { ConsoleHost, HostConfig } from '@appliance.sh/app';

const API_KEY_STORAGE_KEY = 'appliance:api-key';
const API_SERVER_URL_STORAGE_KEY = 'appliance:api-server-url';

// Web host implementation. Reads the api-server URL from a build-time
// global (when served from the api-server) or from sessionStorage
// (when a user pasted it on the Connect page). API keys live in
// sessionStorage so they don't persist past the tab.
//
// A future api-server-served build will inject apiServerUrl via
// window.__APPLIANCE_CONFIG__ at response time, skipping the Connect
// page entirely when the page is served from the cluster it targets.
declare global {
  interface Window {
    __APPLIANCE_CONFIG__?: { apiServerUrl?: string };
  }
}

export const webHost: ConsoleHost = {
  async getConfig(): Promise<HostConfig> {
    const injectedUrl = window.__APPLIANCE_CONFIG__?.apiServerUrl ?? null;
    const sessionUrl = sessionStorage.getItem(API_SERVER_URL_STORAGE_KEY);
    const apiServerUrl = injectedUrl ?? sessionUrl;

    const rawKey = sessionStorage.getItem(API_KEY_STORAGE_KEY);
    const apiKey = rawKey ? (JSON.parse(rawKey) as { id: string; secret: string }) : null;

    return { apiServerUrl, apiKey };
  },

  async saveApiKey(key) {
    sessionStorage.setItem(API_KEY_STORAGE_KEY, JSON.stringify(key));
  },

  async clearApiKey() {
    sessionStorage.removeItem(API_KEY_STORAGE_KEY);
  },

  async saveApiServerUrl(url) {
    sessionStorage.setItem(API_SERVER_URL_STORAGE_KEY, url);
  },

  async disconnect() {
    sessionStorage.removeItem(API_KEY_STORAGE_KEY);
    sessionStorage.removeItem(API_SERVER_URL_STORAGE_KEY);
  },

  async openExternal(url) {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
};
