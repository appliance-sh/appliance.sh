import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { runCommand, sleep } from './exec.js';
import {
  DEFAULT_LOCAL_CLUSTER_NAME,
  DEFAULT_LOCAL_HOST_PORT,
  DEFAULT_LOCAL_NAMESPACE,
  DEFAULT_LOCAL_REGISTRY_PORT,
} from './cluster.js';
import type { ProgressEvent } from './types.js';

// In-cluster api-server bootstrap: render the manifest bundle, apply
// it via kubectl, wait for the Ingress to answer, and mint the first
// API key. Shared by the microVM engine (`appliance vm up`, which passes
// its per-VM kubeconfig + in-VM registry URL) and the desktop's
// `bootstrap_in_cluster_api_server`.

export const IN_CLUSTER_API_SERVER_NAMESPACE = 'appliance-system';
export const IN_CLUSTER_API_SERVER_NAME = 'api-server';
export const IN_CLUSTER_API_SERVER_HOSTNAME = 'api.appliance.localhost';
export const IN_CLUSTER_API_SERVER_PORT = 3000;
// Default api-server image. Cluster pulls this directly from ghcr on
// first deploy; subsequent pod restarts reuse the cached image thanks
// to `imagePullPolicy: IfNotPresent`. Override via
// `BootstrapInClusterOptions.image` for local dev iteration (build →
// push to <registryUrl>/appliance-api-server:<tag>, pass that ref
// through). The tag tracks the SDK release stream.
export const IN_CLUSTER_API_SERVER_DEFAULT_IMAGE = 'ghcr.io/appliance-sh/api-server:latest';

export interface LocalRuntimeOptions {
  clusterName?: string;
  namespace?: string;
  hostPort?: number;
  registryPort?: number;
  dataDir?: string;
  /** Host-side registry URL to advertise in the base config — the
   *  microVM engine passes its in-VM registry URL here. When unset,
   *  no registry block is emitted (image delivery is registry-only). */
  registryUrl?: string;
}

export interface ResolvedRuntimeConfig {
  clusterName: string;
  namespace: string;
  hostPort: number;
  dataDir: string;
  apiServerUrl: string;
  registryPort: number;
  /** Host-side URL of the runtime's image registry (e.g.
   *  `localhost:5052` for the microVM), or null when none was provided. */
  registryUrl: string | null;
}

/**
 * Default data dir for the local runtime: `~/.appliance/local-runtime/`
 * — the same convention the desktop and the demo script use, so CLI-
 * and desktop-managed runtimes share state.
 */
export function defaultLocalRuntimeDir(): string {
  return path.join(os.homedir(), '.appliance', 'local-runtime');
}

export function apiServerUrlForHostPort(hostPort: number): string {
  return hostPort === 80
    ? `http://${IN_CLUSTER_API_SERVER_HOSTNAME}`
    : `http://${IN_CLUSTER_API_SERVER_HOSTNAME}:${hostPort}`;
}

export async function resolveRuntimeConfig(input: LocalRuntimeOptions = {}): Promise<ResolvedRuntimeConfig> {
  const clusterName = input.clusterName ?? DEFAULT_LOCAL_CLUSTER_NAME;
  const hostPort = input.hostPort ?? DEFAULT_LOCAL_HOST_PORT;
  const registryPort = input.registryPort ?? DEFAULT_LOCAL_REGISTRY_PORT;
  return {
    clusterName,
    namespace: input.namespace ?? DEFAULT_LOCAL_NAMESPACE,
    hostPort,
    dataDir: input.dataDir ?? defaultLocalRuntimeDir(),
    apiServerUrl: apiServerUrlForHostPort(hostPort),
    registryPort,
    // Registry-only image delivery: the caller (microVM engine) advertises
    // its registry URL explicitly; there is no cluster-attached registry to
    // probe for anymore.
    registryUrl: input.registryUrl ?? null,
  };
}

/**
 * Build the JSON `APPLIANCE_BASE_CONFIG` env value for the in-cluster
 * api-server. Uses the `appliance-base-kubernetes` variant — the
 * in-cluster api-server authenticates via its mounted ServiceAccount
 * (loadFromCluster()), so no server/token here. The registry block is
 * included only when a registry is actually present.
 */
export function buildInClusterBaseConfig(cfg: ResolvedRuntimeConfig): string {
  const kubernetes: Record<string, unknown> = {
    dataDir: '/data',
    namespace: cfg.namespace,
    hostnameSuffix: 'appliance.localhost',
    ingressClassName: 'traefik',
    // The runtime publishes ingress :80 on this host port — deploy-result
    // URLs must carry it to be clickable from the host.
    hostPort: cfg.hostPort,
  };
  if (cfg.registryUrl) {
    kubernetes.registry = { url: cfg.registryUrl, insecure: true };
  }
  return JSON.stringify({ type: 'appliance-base-kubernetes', name: 'local-runtime', kubernetes });
}

/**
 * Minimal-escape transform for values interpolated into YAML
 * double-quoted scalars. Covers the three characters that can break a
 * double-quoted scalar: `\` (escape lead-in — also what makes Windows
 * paths like `C:\Users\…` parse as invalid escapes), `\n` (closes the
 * scalar mid-string), `"` (terminates the scalar).
 */
export function yamlDoubleQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

/**
 * Compose the multi-document YAML manifest deployed via kubectl apply:
 * Namespace, ServiceAccount + ClusterRole(Binding), Secret (config +
 * bootstrap token), hostPath PV + PVC, and the api-server Deployment +
 * Service + Ingress fronted by Traefik at `api.appliance.localhost`.
 */
export function renderInClusterApiServerManifest(
  cfg: ResolvedRuntimeConfig,
  image: string,
  bootstrapToken: string
): string {
  const ns = IN_CLUSTER_API_SERVER_NAMESPACE;
  const name = IN_CLUSTER_API_SERVER_NAME;
  const port = IN_CLUSTER_API_SERVER_PORT;
  const baseConfig = yamlDoubleQuoted(buildInClusterBaseConfig(cfg));
  const hostDataDir = yamlDoubleQuoted(cfg.dataDir);
  return `apiVersion: v1
kind: Namespace
metadata:
  name: ${ns}
  labels:
    app.kubernetes.io/managed-by: appliance.sh
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${name}
  namespace: ${ns}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: appliance-api-server
rules:
- apiGroups: [""]
  resources: ["namespaces", "services", "pods", "secrets", "configmaps", "persistentvolumeclaims", "events"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["apps"]
  resources: ["deployments", "replicasets"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["networking.k8s.io"]
  resources: ["ingresses"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["pods/log"]
  verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: appliance-api-server
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: appliance-api-server
subjects:
- kind: ServiceAccount
  name: ${name}
  namespace: ${ns}
---
apiVersion: v1
kind: Secret
metadata:
  name: ${name}-config
  namespace: ${ns}
type: Opaque
stringData:
  APPLIANCE_BASE_CONFIG: "${baseConfig}"
  BOOTSTRAP_TOKEN: "${bootstrapToken}"
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: appliance-data
  labels:
    app.kubernetes.io/managed-by: appliance.sh
spec:
  capacity:
    storage: 10Gi
  accessModes: [ReadWriteOnce]
  hostPath:
    path: "${hostDataDir}"
  persistentVolumeReclaimPolicy: Retain
  storageClassName: ""
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: appliance-data
  namespace: ${ns}
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 10Gi
  volumeName: appliance-data
  storageClassName: ""
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  namespace: ${ns}
  labels:
    app.kubernetes.io/name: ${name}
    app.kubernetes.io/managed-by: appliance.sh
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: ${name}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${name}
        app.kubernetes.io/managed-by: appliance.sh
    spec:
      serviceAccountName: ${name}
      containers:
      - name: api-server
        image: "${image}"
        imagePullPolicy: IfNotPresent
        ports:
        - containerPort: ${port}
          name: http
        envFrom:
        - secretRef:
            name: ${name}-config
        env:
        - name: APPLIANCE_MODE
          value: "server"
        - name: PORT
          value: "${port}"
        - name: HOST
          value: "0.0.0.0"
        readinessProbe:
          httpGet:
            path: /bootstrap/status
            port: ${port}
          initialDelaySeconds: 2
          periodSeconds: 2
        volumeMounts:
        - name: data
          mountPath: /data
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: appliance-data
---
apiVersion: v1
kind: Service
metadata:
  name: ${name}
  namespace: ${ns}
  labels:
    app.kubernetes.io/managed-by: appliance.sh
spec:
  selector:
    app.kubernetes.io/name: ${name}
  ports:
  - port: 80
    targetPort: ${port}
    protocol: TCP
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${name}
  namespace: ${ns}
  labels:
    app.kubernetes.io/managed-by: appliance.sh
spec:
  ingressClassName: traefik
  rules:
  - host: ${IN_CLUSTER_API_SERVER_HOSTNAME}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: ${name}
            port:
              number: 80
`;
}

/**
 * Read the existing BOOTSTRAP_TOKEN out of the api-server Secret.
 * Returns null when the Secret doesn't exist yet (first bootstrap),
 * when kubectl fails (cluster down), or when the field is absent.
 * Re-bootstrap must reuse the token the already-running pod's env was
 * seeded with: `envFrom` is a one-shot snapshot at container start, so
 * minting a fresh token would leave the pod's env (old token) and our
 * create-key call (new token) permanently mismatched — 401 until a
 * manual pod restart.
 */
export async function readExistingBootstrapToken(opts: { kubeconfigPath?: string } = {}): Promise<string | null> {
  try {
    const r = await runCommand(
      [
        'kubectl',
        '-n',
        IN_CLUSTER_API_SERVER_NAMESPACE,
        'get',
        'secret',
        `${IN_CLUSTER_API_SERVER_NAME}-config`,
        '-o',
        'jsonpath={.data.BOOTSTRAP_TOKEN}',
      ],
      opts.kubeconfigPath ? { env: { KUBECONFIG: opts.kubeconfigPath } } : {}
    );
    if (!r.ok) return null;
    const encoded = r.stdout.trim();
    if (!encoded) return null;
    const token = Buffer.from(encoded, 'base64').toString('utf8');
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Pipe a manifest string into `kubectl apply -f -` so we don't have to
 * materialize a temp file on disk. Surfaces stderr verbatim — kubectl
 * error messages are usually self-explanatory.
 */
export async function kubectlApplyManifest(manifest: string, opts: { kubeconfigPath?: string } = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('kubectl', ['apply', '-f', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: opts.kubeconfigPath ? { ...process.env, KUBECONFIG: opts.kubeconfigPath } : process.env,
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      const e = err as NodeJS.ErrnoException;
      reject(
        new Error(e.code === 'ENOENT' ? '`kubectl` is not installed or not on PATH.' : `spawn kubectl: ${err.message}`)
      );
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`kubectl apply failed: ${stderr.trim()}`));
    });
    child.stdin.write(manifest);
    child.stdin.end();
  });
}

/**
 * Poll until `<url>/bootstrap/status` answers 2xx, or the timeout
 * elapses — i.e. the in-cluster api-server is past its readiness probe
 * and reachable via the cluster's Ingress.
 */
export async function waitForApiServerUrl(url: string, maxWaitMs: number): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  const target = `${url.replace(/\/+$/, '')}/bootstrap/status`;
  for (;;) {
    try {
      const res = await fetch(target, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) return;
    } catch {
      // unreachable — keep polling until the deadline
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `in-cluster api-server did not become reachable at ${url} within ${Math.round(maxWaitMs / 1000)}s`
      );
    }
    await sleep(500);
  }
}

export interface MintedApiKey {
  id: string;
  secret: string;
}

/** Mint an initial API key via `/bootstrap/create-key`. */
export async function mintApiKey(apiServerUrl: string, token: string, name = 'Local Runtime'): Promise<MintedApiKey> {
  const url = `${apiServerUrl.replace(/\/+$/, '')}/bootstrap/create-key`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-Bootstrap-Token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`mint api key failed: HTTP ${res.status} ${body.trim()}`);
  }
  const parsed = (await res.json()) as Partial<MintedApiKey>;
  if (typeof parsed.id !== 'string' || typeof parsed.secret !== 'string') {
    throw new Error('mint api key failed: response missing id/secret');
  }
  return { id: parsed.id, secret: parsed.secret };
}

export interface BootstrapInClusterOptions {
  runtime?: LocalRuntimeOptions;
  /** Milliseconds to wait for the api-server to come up after the
   *  apply. First boots include a full image pull + extraction, so
   *  the default is generous. */
  readyTimeoutMs?: number;
  /** Kubeconfig the kubectl calls should use. Defaults to the ambient
   *  kubeconfig; the microVM engine passes the per-VM file appliance-vm
   *  fetched. */
  kubeconfigPath?: string;
  /** Override the api-server image reference (see
   *  IN_CLUSTER_API_SERVER_DEFAULT_IMAGE for the default + rationale). */
  image?: string;
  /** Name recorded on the minted API key. */
  keyName?: string;
  onProgress?: (event: ProgressEvent) => void;
}

export interface BootstrapInClusterResult {
  /** URL the in-cluster api-server is reachable at (via the Ingress). */
  apiServerUrl: string;
  /** API key minted via the bootstrap token. Caller persists this so
   *  the SDK can sign subsequent requests. */
  apiKey: MintedApiKey;
}

/**
 * Apply the in-cluster api-server manifests to the running cluster,
 * wait for the deployment to become reachable, and mint the first API
 * key. Idempotent: applying twice reconciles the manifest in place and
 * mints a fresh key. Image delivery is registry-only — the api-server
 * image is pulled from ghcr (or the registry the caller advertised).
 */
export async function bootstrapInClusterApiServer(
  opts: BootstrapInClusterOptions = {}
): Promise<BootstrapInClusterResult> {
  const cfg = await resolveRuntimeConfig(opts.runtime);
  const image = opts.image ?? IN_CLUSTER_API_SERVER_DEFAULT_IMAGE;
  const emit = (message: string) => opts.onProgress?.({ type: 'progress', tool: 'api-server', message });

  // Reuse the existing Secret's BOOTSTRAP_TOKEN when one is present —
  // see readExistingBootstrapToken for why minting fresh would 401.
  const bootstrapToken =
    (await readExistingBootstrapToken({ kubeconfigPath: opts.kubeconfigPath })) ??
    crypto.randomUUID().replaceAll('-', '');

  emit(`applying api-server manifests (image ${image})`);
  await kubectlApplyManifest(renderInClusterApiServerManifest(cfg, image, bootstrapToken), {
    kubeconfigPath: opts.kubeconfigPath,
  });

  emit(`waiting for ${cfg.apiServerUrl} to become reachable`);
  await waitForApiServerUrl(cfg.apiServerUrl, opts.readyTimeoutMs ?? 240_000);

  emit('minting initial API key');
  const apiKey = await mintApiKey(cfg.apiServerUrl, bootstrapToken, opts.keyName);
  return { apiServerUrl: cfg.apiServerUrl, apiKey };
}
