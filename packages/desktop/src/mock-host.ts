import type {
  AddClusterInput,
  AgentInfo,
  AgentLaunchInput,
  BootstrapEvent,
  BootstrapResult,
  Cluster,
  ConsoleHost,
  HostConfig,
  LocalPreflightCheck,
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
//   ready        all tools installed, daemon up (default)
//   running      daemon up, workloads populated
//   daemon-down  docker installed but VM stopped, auto-startable (colima)
//   daemon-manual docker installed, VM stopped, NOT auto-startable
//   missing      kubectl not installed, docker guidance-only
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

// Toggle to QA the "you're up to date" branch of the updater panel.
const MOCK_UPDATE_AVAILABLE = true;
// Fixed running version for the mock update feed (the real running
// version isn't available to desktop-package source — see check()).
const MOCK_CURRENT_VERSION = '1.48.0';

/** Bump the minor of a semver string for the mock update feed. */
function bumpMinor(version: string): string {
  const [major, minor] = version.split('.');
  const nextMinor = Number.isFinite(Number(minor)) ? Number(minor) + 1 : 1;
  return `${major ?? '0'}.${nextMinor}.0`;
}

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
  daemonRunning: boolean;
}

// Mirror the desktop's sync_microvm_cluster (lib.rs): a `vm up` registers
// the VM as a regular cluster and auto-selects it when nothing else is
// selected. Without this the mock host streams the boot but leaves the
// dashboard on "no cluster", so browser QA of the one-click onboarding
// would dead-end where the real desktop connects.
function mockMicroVmClusterId(name: string): string {
  return name === 'appliance' ? 'microvm' : `microvm-${name}`;
}

function registerMockMicroVmCluster(vm: MockVm): void {
  const clusterId = mockMicroVmClusterId(vm.name);
  const state = readState();
  if (!state.clusters.some((c) => c.id === clusterId)) {
    state.clusters.push({
      id: clusterId,
      name: vm.name === 'appliance' ? 'MicroVM Runtime' : `MicroVM Runtime (${vm.name})`,
      apiServerUrl: `http://api.appliance.localhost:${vm.hostPort}`,
      createdAt: new Date().toISOString(),
      apiKey: { id: 'apikey_mock', secret: 'sk_mock' },
    });
  }
  if (!state.selectedClusterId) state.selectedClusterId = clusterId;
  writeState(state);
}

function unregisterMockMicroVmCluster(name: string): void {
  const clusterId = mockMicroVmClusterId(name);
  const state = readState();
  state.clusters = state.clusters.filter((c) => c.id !== clusterId);
  if (state.selectedClusterId === clusterId) {
    state.selectedClusterId = state.clusters[0]?.id ?? null;
  }
  writeState(state);
}

function initialRuntime(): RuntimeState {
  const s = scenario();
  return {
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
      tool: 'kubectl',
      installed,
      version: installed ? 'Client Version: v1.31.4' : undefined,
      purpose: 'Used to read Deployments / Services / pod logs from the microVM.',
      installHint: 'brew install kubectl',
      autoInstallable: true,
      error: installed ? undefined : 'not on PATH',
    },
  ];
}

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

    // Simulated self-update so the Settings "Check for updates" panel can
    // be developed in a browser. Advertises a bump over the bundled
    // version, then streams a fake download with byte-level progress so
    // the determinate progress bar and "Restart" CTA are exercised.
    // `?scenario=` doesn't gate this — it always offers an update so the
    // happy path is reachable; flip `MOCK_UPDATE_AVAILABLE` to false to
    // QA the "you're up to date" branch.
    updater: {
      async check() {
        await sleep(700);
        if (!MOCK_UPDATE_AVAILABLE) return null;
        // The desktop Vite build doesn't inline __APPLIANCE_VERSION__
        // (that define lives in @appliance.sh/app's build), so the mock
        // uses a fixed pair rather than reading the real running
        // version — only the panel's rendering matters here.
        const current = MOCK_CURRENT_VERSION;
        return {
          version: bumpMinor(current),
          currentVersion: current,
          notes: 'mock: faster cluster switcher, microVM egress log fixes, and this very updater panel.',
          date: new Date().toISOString(),
        };
      },
      async downloadAndInstall(onProgress) {
        const total = 48 * 1024 * 1024; // ~48 MB, like a real DMG
        let downloaded = 0;
        onProgress({ contentLength: total, downloaded });
        while (downloaded < total) {
          await sleep(120);
          downloaded = Math.min(total, downloaded + total / 20);
          onProgress({ contentLength: total, downloaded });
        }
      },
      async relaunch() {
        // A real relaunch swaps the process; in the browser, just reload.
        window.location.reload();
      },
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
        const targets = tools ?? ['kubectl'];
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
      async list() {
        await sleep(80);
        return Object.values(microVms).map((vm) => ({
          name: vm.name,
          running: vm.running,
          clusterReady: vm.running,
          phase: vm.running ? ('ready' as const) : undefined,
          hostPort: vm.hostPort,
          apiPort: vm.apiPort,
          registryPort: vm.registryPort,
          egressPort: vm.egressPort,
          clusterId: vm.name === 'appliance' ? 'microvm' : `microvm-${vm.name}`,
        }));
      },
      async install() {
        await sleep(800);
      },
      instance(name?: string) {
        const vm = mockVm(name ?? 'appliance');
        return {
          name: vm.name,
          async status() {
            await sleep(60);
            return {
              available: true,
              installable: false,
              exists: vm.exists,
              running: vm.running,
              kubeconfigReady: vm.running,
              phase: vm.running ? ('ready' as const) : undefined,
              dev: vm.dev,
              // Mock a shared workspace for dev VMs so the agent launcher
              // (gated on devMount) is exercisable in the browser shell.
              devMount: vm.dev ? `/Users/you/projects/${vm.name}` : undefined,
              apiServerUrl: `http://api.appliance.localhost:${vm.hostPort}`,
            };
          },
          async up(onEvent: (event: { message: string }) => void) {
            const profile = vm.name === 'appliance' ? 'microvm' : `microvm-${vm.name}`;
            const lines = [
              `starting VM '${vm.name}' (host pid 4242)`,
              'waiting for kubernetes endpoint......',
              `VM '${vm.name}' is up`,
              '» waiting for the in-VM registry',
              '» pushing appliance-api-server:arm64 into the VM registry',
              '» api-server applying api-server manifests',
              `» api-server waiting for http://api.appliance.localhost:${vm.hostPort} to become reachable`,
              `✓ api-server bootstrapped; credentials saved to profile ${profile}`,
            ];
            for (const message of lines) {
              await sleep(400);
              onEvent({ message });
            }
            vm.exists = true;
            vm.running = true;
            // Register + auto-select the VM's cluster, like the real engine.
            registerMockMicroVmCluster(vm);
          },
          async devUp(onEvent: (event: { message: string }) => void, opts?: { mount?: string }) {
            const profile = vm.name === 'appliance' ? 'microvm' : `microvm-${vm.name}`;
            const lines = [
              `starting VM '${vm.name}' as a dev environment (host pid 4242)`,
              'waiting for kubernetes endpoint......',
              `VM '${vm.name}' is up`,
              '» provisioning dev toolchain in the workspace',
              ...(opts?.mount ? [`» sharing host folder ${opts.mount} into /persist/workspace`] : []),
              `✓ dev environment ready; credentials saved to profile ${profile}`,
            ];
            for (const message of lines) {
              await sleep(400);
              onEvent({ message });
            }
            vm.exists = true;
            vm.running = true;
            vm.dev = true;
            // Register + auto-select the VM's cluster, like the real engine.
            registerMockMicroVmCluster(vm);
          },
          async cleanupShell() {
            // Best-effort sweep of debugger pods a shell leaves behind; a no-op in the mock.
            await sleep(120);
          },
          async stop() {
            await sleep(800);
            vm.running = false;
          },
          async remove() {
            await sleep(800);
            vm.running = false;
            vm.exists = false;
            delete microVms[vm.name];
            unregisterMockMicroVmCluster(vm.name);
          },
          egress: {
            async get() {
              await sleep(100);
              return { ...vm.egress };
            },
            async setDefault(action: 'allow' | 'deny') {
              await sleep(150);
              vm.egress.default = action;
            },
            async addRule(action: 'allow' | 'deny', host: string) {
              await sleep(150);
              const list = action === 'allow' ? vm.egress.allow : vm.egress.deny;
              if (!list.includes(host)) list.push(host);
            },
            async setMitm(enabled: boolean) {
              await sleep(150);
              vm.egress.mitm = enabled;
              vm.egress.caPath = enabled ? `~/.appliance/vm/${vm.name}/egress-ca.pem` : undefined;
            },
            async reset() {
              await sleep(150);
              vm.egress = { default: 'allow', allow: [], deny: [], mitm: false };
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
                rules: [...vm.creds.rules],
                secrets: vm.creds.secrets.map((s) => ({ ...s })),
              };
            },
            async add(rule: { host: string; capture: boolean; inject: boolean; header?: string; helper?: string }) {
              await sleep(120);
              const next = {
                host: rule.host,
                capture: rule.capture,
                inject: rule.inject,
                header: rule.header || 'authorization',
                helper: rule.helper,
              };
              const i = vm.creds.rules.findIndex((r) => r.host === rule.host);
              if (i >= 0) vm.creds.rules[i] = next;
              else vm.creds.rules.push(next);
            },
            async remove(host: string) {
              await sleep(120);
              vm.creds.rules = vm.creds.rules.filter((r) => r.host !== host);
            },
            async setSecret(host: string, value: string, header?: string) {
              await sleep(120);
              const h = (header || 'authorization').toLowerCase();
              const masked = value.length > 4 ? `••••${value.slice(-4)}` : '••••';
              const i = vm.creds.secrets.findIndex((s) => s.host === host && s.header === h);
              const rec = { host, header: h, masked };
              if (i >= 0) vm.creds.secrets[i] = rec;
              else vm.creds.secrets.push(rec);
            },
            async forget() {
              await sleep(80);
              vm.creds.secrets = [];
            },
          },
          agent: {
            async start(input: AgentLaunchInput) {
              await sleep(400);
              vm.agents.push({
                id: input.sessionId.replace(/^agent-/, ''),
                type: input.type ?? 'claude-code',
                task: input.task,
                status: 'running',
                sessionId: input.sessionId,
                mode: 'interactive',
                live: true,
              });
            },
            async list(): Promise<AgentInfo[]> {
              await sleep(80);
              return vm.agents.map((a) => ({ ...a }));
            },
          },
        };
      },
    },
  };
}

// MicroVM mock state (module-level: survives SPA navigation, resets on
// reload like the rest of the mock). Keyed by VM name so the browser
// dev shell can exercise the multi-VM UI — one VM for interactive dev,
// one for traffic testing.
interface MockVm {
  name: string;
  exists: boolean;
  running: boolean;
  /** Provisioned as a development environment (`appliance vm dev up`). */
  dev: boolean;
  hostPort: number;
  apiPort: number;
  registryPort: number;
  egressPort: number;
  egress: { default: 'allow' | 'deny'; allow: string[]; deny: string[]; mitm: boolean; caPath?: string };
  creds: {
    rules: Array<{ host: string; capture: boolean; inject: boolean; header: string; helper?: string }>;
    secrets: Array<{ host: string; header: string; masked: string }>;
  };
  /** Coding agents launched into this VM (Phase 5, A5). */
  agents: AgentInfo[];
}

const microVms: Record<string, MockVm> = {
  appliance: {
    name: 'appliance',
    exists: true,
    running: false,
    dev: false,
    hostPort: 8081,
    apiPort: 6443,
    registryPort: 5052,
    egressPort: 5053,
    egress: { default: 'allow', allow: [], deny: [], mitm: false },
    creds: {
      rules: [{ host: 'api.openai.com', capture: true, inject: true, header: 'authorization' }],
      secrets: [{ host: 'api.openai.com', header: 'authorization', masked: '••••k7Qx' }],
    },
    agents: [],
  },
  traffic: {
    name: 'traffic',
    exists: true,
    running: true,
    dev: false,
    hostPort: 8100,
    apiPort: 8101,
    registryPort: 8102,
    egressPort: 8103,
    egress: {
      default: 'deny',
      allow: ['api.openai.com', 'github.com'],
      deny: [],
      mitm: true,
      caPath: '~/.appliance/vm/traffic/egress-ca.pem',
    },
    creds: { rules: [], secrets: [] },
    agents: [],
  },
};

/** Look up (or lazily create) a mock VM by name, so `instance('new')`
 *  followed by `up()` materializes a VM the way the real engine does. */
function mockVm(name: string): MockVm {
  let vm = microVms[name];
  if (!vm) {
    // Mirror the allocator: pick the next free 4-port block from 8100.
    const used = new Set(Object.values(microVms).flatMap((v) => [v.hostPort]));
    let slot = 0;
    while (used.has(8100 + slot * 4)) slot += 1;
    const base = 8100 + slot * 4;
    vm = {
      name,
      exists: false,
      running: false,
      dev: false,
      hostPort: base,
      apiPort: base + 1,
      registryPort: base + 2,
      egressPort: base + 3,
      egress: { default: 'allow', allow: [], deny: [], mitm: false },
      creds: { rules: [], secrets: [] },
      agents: [],
    };
    microVms[name] = vm;
  }
  return vm;
}
