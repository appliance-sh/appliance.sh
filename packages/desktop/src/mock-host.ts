import type {
  AddClusterInput,
  BootstrapEvent,
  BootstrapResult,
  Cluster,
  ConsoleHost,
  HostConfig,
  LocalClusterStatus,
  LocalPreflightCheck,
  LocalRuntimeStatus,
  LocalWorkloads,
} from '@appliance.sh/app';

// Browser-runnable stand-in for the Tauri host, so the desktop-only
// pages (Local Runtime, deploy wizard, bootstrap) can be developed and
// audited in a regular browser — no cargo build, no native window, and
// deterministic runtime states a real machine can't hold still in.
//
// Enable by loading the desktop vite dev server with `?mock-host`
// (persisted in sessionStorage so SPA navigation keeps it). Pick the
// preflight/runtime fixture with `?scenario=`:
//
//   ready        all tools installed, daemon up, cluster stopped (default)
//   running      cluster + api-server up, workloads populated
//   daemon-down  docker installed but VM stopped, auto-startable (colima)
//   daemon-manual docker installed, VM stopped, NOT auto-startable
//   missing      k3d/kubectl not installed, docker guidance-only
//
// Transitions are simulated (start ≈2s, stop ≈1s, builds stream log
// lines) so spinners, disabled states, and progress UI are exercised
// for real. DEV-only: main.tsx never references this module outside
// `import.meta.env.DEV`.

type Scenario = 'ready' | 'running' | 'daemon-down' | 'daemon-manual' | 'missing';

const SCENARIO_KEY = 'mock-host:scenario';
const ENABLED_KEY = 'mock-host:enabled';
const CLUSTERS_KEY = 'mock-host:clusters';

export function mockHostEnabled(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.has('mock-host')) {
    sessionStorage.setItem(ENABLED_KEY, '1');
    const scenario = params.get('scenario');
    if (scenario) sessionStorage.setItem(SCENARIO_KEY, scenario);
  }
  return sessionStorage.getItem(ENABLED_KEY) === '1';
}

function scenario(): Scenario {
  const s = sessionStorage.getItem(SCENARIO_KEY);
  return s === 'running' || s === 'daemon-down' || s === 'daemon-manual' || s === 'missing' ? s : 'ready';
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---- persisted clusters (sessionStorage, console-host style) ----------

interface PersistedState {
  clusters: Array<Cluster & { apiKey: { id: string; secret: string } }>;
  selectedClusterId: string | null;
}

function readState(): PersistedState {
  try {
    const raw = sessionStorage.getItem(CLUSTERS_KEY);
    if (raw) return JSON.parse(raw) as PersistedState;
  } catch {
    // fall through to empty
  }
  return { clusters: [], selectedClusterId: null };
}

function writeState(state: PersistedState): void {
  sessionStorage.setItem(CLUSTERS_KEY, JSON.stringify(state));
}

// ---- runtime state machine ---------------------------------------------

interface RuntimeState {
  clusterExists: boolean;
  clusterRunning: boolean;
  apiServerRunning: boolean;
  registeredClusterId: string | null;
  daemonRunning: boolean;
}

function registerMockCluster(): void {
  const state = readState();
  if (!state.clusters.some((c) => c.id === 'local-runtime')) {
    state.clusters.push({
      id: 'local-runtime',
      name: 'Local Runtime',
      apiServerUrl: 'http://api.appliance.localhost:8081',
      createdAt: new Date().toISOString(),
      apiKey: { id: 'apikey_mock', secret: 'sk_mock' },
    });
  }
  state.selectedClusterId = 'local-runtime';
  writeState(state);
}

function unregisterMockCluster(): void {
  const state = readState();
  state.clusters = state.clusters.filter((c) => c.id !== 'local-runtime');
  if (state.selectedClusterId === 'local-runtime') {
    state.selectedClusterId = state.clusters[0]?.id ?? null;
  }
  writeState(state);
}

function initialRuntime(): RuntimeState {
  const s = scenario();
  return {
    clusterExists: s !== 'missing',
    clusterRunning: s === 'running',
    apiServerRunning: s === 'running',
    registeredClusterId: s === 'running' ? 'local-runtime' : null,
    daemonRunning: s === 'ready' || s === 'running',
  };
}

// Lazily initialized: module evaluation happens before
// mockHostEnabled() persists `?scenario=` to sessionStorage, so an
// eager initialRuntime() would always see the default scenario.
let runtimeState: RuntimeState | null = null;
function getRuntime(): RuntimeState {
  if (!runtimeState) {
    runtimeState = initialRuntime();
    // The real desktop auto-registers the runtime's cluster on start;
    // mirror that so the `running` scenario doesn't show a running
    // runtime alongside a "No cluster connected" top bar.
    if (runtimeState.registeredClusterId) registerMockCluster();
  }
  return runtimeState;
}

function preflight(): LocalPreflightCheck[] {
  const s = scenario();
  const docker: LocalPreflightCheck = {
    tool: 'docker',
    installed: s !== 'missing',
    version: s !== 'missing' ? 'Docker version 29.2.1, build a5c7197d72' : undefined,
    purpose: 'Container runtime Appliance shells out to for `docker build` / `docker save`.',
    installHint:
      'Install any container runtime (Docker Desktop, OrbStack, Colima, Rancher Desktop). https://www.docker.com/products/docker-desktop/',
    autoInstallable: false,
    daemonRunning: s === 'missing' ? undefined : getRuntime().daemonRunning,
    daemonStartable: s === 'daemon-down' ? true : s === 'daemon-manual' ? false : undefined,
    error:
      s === 'daemon-down'
        ? 'Docker is installed but its colima VM isn’t running.'
        : s === 'daemon-manual'
          ? 'Docker isn’t running. Start your container runtime — Docker Desktop, OrbStack, or `colima start` — and retry.'
          : s === 'missing'
            ? 'not on PATH'
            : undefined,
  };
  const installed = s !== 'missing';
  return [
    docker,
    {
      tool: 'k3d',
      installed,
      version: installed ? 'k3d version v5.8.3' : undefined,
      purpose: 'Lightweight Kubernetes-in-Docker cluster used as the local runtime.',
      installHint: 'brew install k3d',
      autoInstallable: true,
      error: installed ? undefined : 'not on PATH',
    },
    {
      tool: 'kubectl',
      installed,
      version: installed ? 'Client Version: v1.31.4' : undefined,
      purpose: 'Used to apply Deployments / Services onto the local cluster.',
      installHint: 'brew install kubectl',
      autoInstallable: true,
      error: installed ? undefined : 'not on PATH',
    },
  ];
}

function clusterStatus(): LocalClusterStatus {
  return {
    exists: getRuntime().clusterExists,
    running: getRuntime().clusterRunning,
    clusterName: 'appliance-local',
    message: getRuntime().daemonRunning
      ? undefined
      : 'Docker isn’t running. Start your container runtime — Docker Desktop, OrbStack, or `colima start` — and retry.',
  };
}

function runtimeStatus(): LocalRuntimeStatus {
  return {
    cluster: clusterStatus(),
    apiServer: {
      running: getRuntime().apiServerRunning,
      message: getRuntime().apiServerRunning ? undefined : undefined,
    },
    config: {
      clusterName: 'appliance-local',
      namespace: 'appliance',
      hostPort: 8081,
      dataDir: '/Users/dev/.appliance/local-runtime',
      apiServerUrl: 'http://api.appliance.localhost:8081',
      nodePortMin: 30000,
      nodePortMax: 30050,
      registryUrl: getRuntime().clusterExists ? 'localhost:5050' : undefined,
      registryPort: 5050,
    },
    clusterId: getRuntime().registeredClusterId ?? undefined,
  };
}

const WORKLOADS: LocalWorkloads = {
  deployments: [
    {
      name: 'demo-node-dev',
      image: 'localhost:5050/demo-node-container:latest',
      desired: 1,
      ready: 1,
      available: 1,
      createdAt: new Date(Date.now() - 40 * 60_000).toISOString(),
    },
    {
      name: 'demo-python-dev',
      image: 'localhost:5050/demo-python-container:latest',
      desired: 1,
      ready: 0,
      available: 0,
      createdAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    },
  ],
  pods: [
    {
      name: 'demo-node-dev-5c58d6c8d-dmbfn',
      phase: 'Running',
      ready: true,
      restartCount: 0,
      containerImage: 'localhost:5050/demo-node-container:latest',
      createdAt: new Date(Date.now() - 40 * 60_000).toISOString(),
    },
    {
      name: 'demo-python-dev-7f9c4b6d5-x2x9k',
      phase: 'Pending',
      ready: false,
      restartCount: 2,
      containerImage: 'localhost:5050/demo-python-container:latest',
      createdAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    },
  ],
  services: [
    { name: 'demo-node-dev', serviceType: 'NodePort', clusterIp: '10.43.42.92', nodePort: 30006, targetPort: 3000 },
    { name: 'demo-python-dev', serviceType: 'NodePort', clusterIp: '10.43.123.197', nodePort: 30030, targetPort: 8080 },
  ],
};

const POD_LOGS = [
  '{"timestamp":"2026-06-10T12:46:02.011Z","level":"info","message":"server started","port":3000}',
  '{"timestamp":"2026-06-10T12:46:02.058Z","level":"info","message":"request","path":"/","status":200}',
  '{"timestamp":"2026-06-10T12:47:11.402Z","level":"info","message":"request","path":"/healthz","status":200}',
].join('\n');

// ---- host ---------------------------------------------------------------

export function createMockHost(): ConsoleHost {
  return {
    async getConfig(): Promise<HostConfig> {
      const state = readState();
      const selected = state.clusters.find((c) => c.id === state.selectedClusterId) ?? null;
      return {
        clusters: state.clusters.map(({ apiKey: _apiKey, ...cluster }) => cluster),
        selectedClusterId: state.selectedClusterId,
        apiKey: selected ? selected.apiKey : null,
      };
    },

    async addCluster(input: AddClusterInput): Promise<Cluster> {
      const state = readState();
      const cluster: Cluster & { apiKey: { id: string; secret: string } } = {
        id: `mock-${Math.random().toString(36).slice(2, 10)}`,
        name: input.name,
        apiServerUrl: input.apiServerUrl,
        createdAt: new Date().toISOString(),
        apiKey: input.apiKey,
      };
      state.clusters.push(cluster);
      state.selectedClusterId = cluster.id;
      writeState(state);
      const { apiKey: _apiKey, ...publicCluster } = cluster;
      return publicCluster;
    },

    async selectCluster(clusterId: string | null): Promise<void> {
      const state = readState();
      state.selectedClusterId = clusterId;
      writeState(state);
    },

    async removeCluster(clusterId: string): Promise<void> {
      const state = readState();
      state.clusters = state.clusters.filter((c) => c.id !== clusterId);
      if (state.selectedClusterId === clusterId) {
        state.selectedClusterId = state.clusters[0]?.id ?? null;
      }
      writeState(state);
    },

    async openExternal(url: string): Promise<void> {
      window.open(url, '_blank', 'noreferrer');
    },

    bootstrap: {
      async run(_input, _options, onEvent) {
        const emit = (event: BootstrapEvent) => onEvent(event);
        emit({ type: 'phase-started', phase: 'phase1' });
        emit({ type: 'log', level: 'info', message: 'mock: provisioning installer stack' });
        await sleep(800);
        emit({ type: 'phase-started', phase: 'phase2' });
        emit({ type: 'log', level: 'info', message: 'mock: deploying api-server appliance' });
        await sleep(800);
        return {
          stateBackendUrl: 's3://mock-state-bucket',
          apiServerUrl: 'https://api.mock.appliance.sh',
          apiKey: { id: 'apikey_mock', secret: 'sk_mock' },
        } as BootstrapResult;
      },
      async promoteState() {
        await sleep(500);
      },
      async demoteState() {
        await sleep(500);
      },
      async updateApiServer() {
        await sleep(500);
      },
      async updateBaseline() {
        await sleep(500);
      },
      async listAwsProfiles() {
        return [
          { name: 'default', isSso: false, source: 'credentials' as const },
          { name: 'work-sso', isSso: true, source: 'config' as const },
        ];
      },
    },

    local: {
      async preflight() {
        return preflight();
      },

      async installPrereq(tools, onEvent) {
        const targets = tools ?? ['k3d', 'kubectl'];
        for (const tool of targets) {
          onEvent({ type: 'progress', stage: tool, message: `Downloading ${tool} (mock)` });
          await sleep(600);
        }
        return {
          outcomes: targets.map((tool) => ({
            tool,
            status: 'installed' as const,
            message: 'Installed (mock)',
          })),
        };
      },

      async startContainerRuntime() {
        if (scenario() === 'daemon-manual') {
          throw new Error(
            'Docker isn’t running. Start your container runtime — Docker Desktop, OrbStack, or `colima start` — and retry.'
          );
        }
        await sleep(1_500);
        getRuntime().daemonRunning = true;
      },

      async status() {
        return clusterStatus();
      },
      async start() {
        await sleep(1_000);
        getRuntime().clusterExists = true;
        getRuntime().clusterRunning = true;
        return clusterStatus();
      },
      async stop() {
        await sleep(600);
        getRuntime().clusterRunning = false;
        return clusterStatus();
      },
      async delete() {
        await sleep(600);
        getRuntime().clusterExists = false;
        getRuntime().clusterRunning = false;
        return clusterStatus();
      },

      async runtimeStatus() {
        return runtimeStatus();
      },

      async startRuntime() {
        if (!getRuntime().daemonRunning && scenario() === 'daemon-manual') {
          throw new Error(
            'Docker isn’t running. Start your container runtime — Docker Desktop, OrbStack, or `colima start` — and retry.'
          );
        }
        await sleep(2_000);
        getRuntime().daemonRunning = true;
        getRuntime().clusterExists = true;
        getRuntime().clusterRunning = true;
        getRuntime().apiServerRunning = true;
        getRuntime().registeredClusterId = 'local-runtime';
        registerMockCluster();
        return runtimeStatus();
      },

      async stopRuntime() {
        await sleep(1_000);
        getRuntime().clusterRunning = false;
        getRuntime().apiServerRunning = false;
        return runtimeStatus();
      },

      async deleteRuntime() {
        await sleep(1_000);
        getRuntime().clusterExists = false;
        getRuntime().clusterRunning = false;
        getRuntime().apiServerRunning = false;
        getRuntime().registeredClusterId = null;
        unregisterMockCluster();
        return runtimeStatus();
      },

      async listWorkloads() {
        return WORKLOADS;
      },

      async tailPodLogs() {
        await sleep(300);
        return POD_LOGS;
      },

      async pickDirectory() {
        return '/Users/dev/projects/demo-node-container';
      },

      async readApplianceManifest(path: string) {
        return {
          manifest: 'v1',
          name: 'demo-node-container',
          type: 'container',
          port: 3000,
          platform: 'linux/arm64',
          manifestPath: `${path}/appliance.json`,
        };
      },

      async buildAndImportImage(input, onEvent) {
        const ref = input.registryUrl ? `${input.registryUrl}/${input.imageTag}` : input.imageTag;
        onEvent({ type: 'log', stream: 'meta', message: `$ docker build -t ${ref} ${input.path}` });
        const lines = [
          '#1 [internal] load build definition from Dockerfile',
          '#2 [internal] load metadata for docker.io/library/node:24-slim',
          '#3 [1/4] FROM docker.io/library/node:24-slim',
          '#4 [2/4] WORKDIR /app',
          '#5 [3/4] COPY package.json index.js ./',
          '#6 [4/4] RUN npm install --omit=dev',
          `#7 exporting to image — naming to ${ref}`,
        ];
        for (const line of lines) {
          await sleep(250);
          onEvent({ type: 'log', stream: 'stdout', message: line });
        }
        if (input.registryUrl) {
          onEvent({ type: 'log', stream: 'meta', message: `$ docker push ${ref}` });
          await sleep(400);
          onEvent({ type: 'log', stream: 'stdout', message: 'latest: digest: sha256:mock size: 1677' });
        }
        return ref;
      },

      async bootstrapInClusterApiServer() {
        await sleep(1_200);
        return {
          apiServerUrl: 'http://api.appliance.localhost:8081',
          apiKey: { id: 'apikey_mock-bootstrap', secret: 'sk_mock-secret' },
        };
      },
    },

    vm: {
      async status() {
        return {
          available: true,
          installable: false,
          exists: microVm.exists,
          running: microVm.running,
          kubeconfigReady: microVm.running,
          apiServerUrl: 'http://api.appliance.localhost:8081',
        };
      },
      async install() {
        await sleep(800);
      },
      async up(onEvent) {
        const lines = [
          "starting VM 'appliance' (host pid 4242)",
          'waiting for kubernetes endpoint......',
          "VM 'appliance' is up",
          '» waiting for the in-VM registry',
          '» pushing appliance-api-server:arm64 into the VM registry',
          '» api-server applying api-server manifests',
          '» api-server waiting for http://api.appliance.localhost:8081 to become reachable',
          '✓ api-server bootstrapped; credentials saved to profile microvm',
        ];
        for (const message of lines) {
          await sleep(400);
          onEvent({ message });
        }
        microVm.exists = true;
        microVm.running = true;
      },
      async stop() {
        await sleep(800);
        microVm.running = false;
      },
      async remove() {
        await sleep(800);
        microVm.running = false;
        microVm.exists = false;
      },
      egress: {
        async get() {
          await sleep(100);
          return { ...microVm.egress };
        },
        async setDefault(action: 'allow' | 'deny') {
          await sleep(150);
          microVm.egress.default = action;
        },
        async addRule(action: 'allow' | 'deny', host: string) {
          await sleep(150);
          const list = action === 'allow' ? microVm.egress.allow : microVm.egress.deny;
          if (!list.includes(host)) list.push(host);
        },
        async setMitm(enabled: boolean) {
          await sleep(150);
          microVm.egress.mitm = enabled;
          microVm.egress.caPath = enabled ? '~/.appliance/vm/appliance/egress-ca.pem' : undefined;
        },
        async reset() {
          await sleep(150);
          microVm.egress = { default: 'allow', allow: [], deny: [], mitm: false };
        },
        async log(tail?: number) {
          await sleep(100);
          const now = 1_700_000_000_000;
          const events = [
            {
              ts: now,
              host: 'api.openai.com',
              port: 443,
              method: 'POST',
              path: '/v1/chat/completions',
              decision: 'mitm' as const,
            },
            { ts: now + 1000, host: 'github.com', port: 443, method: 'CONNECT', decision: 'allow' as const },
            { ts: now + 2000, host: 'evil.test', port: 443, method: 'CONNECT', decision: 'deny' as const },
          ];
          return events.slice(-(tail ?? 200));
        },
        async clearLog() {
          await sleep(50);
        },
      },
      creds: {
        async list() {
          await sleep(100);
          return {
            rules: [...microVm.creds.rules],
            secrets: microVm.creds.secrets.map((s) => ({ ...s })),
          };
        },
        async add(rule) {
          await sleep(120);
          const next = {
            host: rule.host,
            capture: rule.capture,
            inject: rule.inject,
            header: rule.header || 'authorization',
            helper: rule.helper,
          };
          const i = microVm.creds.rules.findIndex((r) => r.host === rule.host);
          if (i >= 0) microVm.creds.rules[i] = next;
          else microVm.creds.rules.push(next);
        },
        async remove(host: string) {
          await sleep(120);
          microVm.creds.rules = microVm.creds.rules.filter((r) => r.host !== host);
        },
        async setSecret(host: string, value: string, header?: string) {
          await sleep(120);
          const h = (header || 'authorization').toLowerCase();
          const masked = value.length > 4 ? `••••${value.slice(-4)}` : '••••';
          const i = microVm.creds.secrets.findIndex((s) => s.host === host && s.header === h);
          const rec = { host, header: h, masked };
          if (i >= 0) microVm.creds.secrets[i] = rec;
          else microVm.creds.secrets.push(rec);
        },
        async forget() {
          await sleep(80);
          microVm.creds.secrets = [];
        },
      },
    },
  };
}

// MicroVM mock state (module-level: survives SPA navigation, resets on
// reload like the rest of the mock).
const microVm: {
  exists: boolean;
  running: boolean;
  egress: { default: 'allow' | 'deny'; allow: string[]; deny: string[]; mitm: boolean; caPath?: string };
  creds: {
    rules: Array<{ host: string; capture: boolean; inject: boolean; header: string; helper?: string }>;
    secrets: Array<{ host: string; header: string; masked: string }>;
  };
} = {
  exists: true,
  running: false,
  egress: { default: 'allow', allow: [], deny: [], mitm: false },
  creds: {
    rules: [{ host: 'api.openai.com', capture: true, inject: true, header: 'authorization' }],
    secrets: [{ host: 'api.openai.com', header: 'authorization', masked: '••••k7Qx' }],
  },
};
