import type { AddClusterInput, Cluster, ConsoleHost, HostConfig } from '@appliance.sh/app';

const CLUSTERS_KEY = 'appliance:clusters';
const SELECTED_KEY = 'appliance:selectedClusterId';
const apiKeyStorageKey = (clusterId: string) => `appliance:apikey:${clusterId}`;

// Legacy single-cluster keys, migrated to the multi-cluster shape on
// first read.
const LEGACY_API_SERVER_URL_KEY = 'appliance:api-server-url';
const LEGACY_API_KEY_KEY = 'appliance:api-key';

// Web host implementation. Cluster metadata + API keys live in
// sessionStorage so they don't persist past the tab. A future
// api-server-served build can inject one cluster via
// window.__APPLIANCE_CONFIG__ — when present, it shows up as a
// pre-existing cluster in the list at first load.
declare global {
  interface Window {
    __APPLIANCE_CONFIG__?: { apiServerUrl?: string };
  }
}

interface PersistedClusters {
  clusters: Cluster[];
  selectedClusterId: string | null;
}

function readPersisted(): PersistedClusters {
  let clusters: Cluster[] = [];
  let selectedClusterId: string | null = null;

  const rawClusters = sessionStorage.getItem(CLUSTERS_KEY);
  if (rawClusters) {
    try {
      const parsed = JSON.parse(rawClusters);
      if (Array.isArray(parsed)) clusters = parsed;
    } catch {
      // discard malformed
    }
  }
  selectedClusterId = sessionStorage.getItem(SELECTED_KEY);

  if (clusters.length === 0) {
    // Legacy single-cluster migration. Keys present on the old shape
    // get folded into a single cluster entry; old keys are then
    // deleted so we don't re-migrate next time.
    const legacyUrl = window.__APPLIANCE_CONFIG__?.apiServerUrl ?? sessionStorage.getItem(LEGACY_API_SERVER_URL_KEY);
    const legacyKeyRaw = sessionStorage.getItem(LEGACY_API_KEY_KEY);
    if (legacyUrl && legacyKeyRaw) {
      try {
        const legacyKey = JSON.parse(legacyKeyRaw) as { id: string; secret: string };
        const id = randomId();
        const cluster: Cluster = {
          id,
          name: deriveNameFromUrl(legacyUrl),
          apiServerUrl: legacyUrl,
          createdAt: new Date().toISOString(),
        };
        sessionStorage.setItem(apiKeyStorageKey(id), JSON.stringify(legacyKey));
        clusters = [cluster];
        selectedClusterId = id;
        writePersisted({ clusters, selectedClusterId });
        sessionStorage.removeItem(LEGACY_API_SERVER_URL_KEY);
        sessionStorage.removeItem(LEGACY_API_KEY_KEY);
      } catch {
        // discard malformed legacy state
      }
    }
  }

  return { clusters, selectedClusterId };
}

function writePersisted(state: PersistedClusters): void {
  sessionStorage.setItem(CLUSTERS_KEY, JSON.stringify(state.clusters));
  if (state.selectedClusterId) {
    sessionStorage.setItem(SELECTED_KEY, state.selectedClusterId);
  } else {
    sessionStorage.removeItem(SELECTED_KEY);
  }
}

function readApiKey(clusterId: string): { id: string; secret: string } | null {
  const raw = sessionStorage.getItem(apiKeyStorageKey(clusterId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { id: string; secret: string };
  } catch {
    return null;
  }
}

function deriveNameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^api\./, '');
  } catch {
    return url;
  }
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export const webHost: ConsoleHost = {
  async getConfig(): Promise<HostConfig> {
    const { clusters, selectedClusterId } = readPersisted();
    const apiKey = selectedClusterId ? readApiKey(selectedClusterId) : null;
    return { clusters, selectedClusterId, apiKey };
  },

  async addCluster(input: AddClusterInput): Promise<Cluster> {
    const { clusters } = readPersisted();
    const cluster: Cluster = {
      id: randomId(),
      name: input.name,
      apiServerUrl: input.apiServerUrl,
      createdAt: new Date().toISOString(),
    };
    sessionStorage.setItem(apiKeyStorageKey(cluster.id), JSON.stringify(input.apiKey));
    writePersisted({
      clusters: [...clusters, cluster],
      selectedClusterId: cluster.id,
    });
    return cluster;
  },

  async selectCluster(clusterId: string | null): Promise<void> {
    const { clusters } = readPersisted();
    if (clusterId && !clusters.some((c) => c.id === clusterId)) {
      throw new Error(`cluster not found: ${clusterId}`);
    }
    writePersisted({ clusters, selectedClusterId: clusterId });
  },

  async removeCluster(clusterId: string): Promise<void> {
    const { clusters, selectedClusterId } = readPersisted();
    const next = clusters.filter((c) => c.id !== clusterId);
    if (next.length === clusters.length) {
      throw new Error(`cluster not found: ${clusterId}`);
    }
    sessionStorage.removeItem(apiKeyStorageKey(clusterId));
    const nextSelected = selectedClusterId === clusterId ? (next[0]?.id ?? null) : selectedClusterId;
    writePersisted({ clusters: next, selectedClusterId: nextSelected });
  },

  async openExternal(url) {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
};
