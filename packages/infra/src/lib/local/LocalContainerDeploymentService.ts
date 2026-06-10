import * as k8s from '@kubernetes/client-node';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ApplianceBaseConfig, ApplianceBaseType, getKubernetesParams, isKubernetesBase } from '@appliance.sh/sdk';

const execFileAsync = promisify(execFile);

export const DEFAULT_LOCAL_CLUSTER_NAME = 'appliance-local';
export const DEFAULT_LOCAL_NAMESPACE = 'appliance';
export const DEFAULT_LOCAL_HOST_PORT = 8081;

// NodePort window the demo k3d cluster maps onto the host. Picked
// small (51 ports) so the docker-proxy footprint on macOS stays
// tractable — at ~2700 ports the colima daemon has been observed to
// fall over. The deployment service derives a deterministic NodePort
// from the stack name within this range so each appliance ends up
// reachable on a stable host port.
export const DEFAULT_LOCAL_NODEPORT_MIN = 30000;
export const DEFAULT_LOCAL_NODEPORT_MAX = 30050;

export interface LocalDeploymentMetadata {
  projectId: string;
  projectName: string;
  environmentId: string;
  environmentName: string;
  deploymentId: string;
  stackName: string;
}

export interface LocalResolvedBuild {
  /** Container image reference already present in the local Docker
   *  daemon or k3d-imported (e.g. `demo-node-container:latest`). */
  imageUri: string;
  /** Container port to expose. Falls back to 8080 if unset. */
  port?: number;
  environment?: Record<string, string>;
}

export interface LocalDeploymentResult {
  action: 'deploy' | 'destroy' | 'refresh';
  ok: boolean;
  idempotentNoop: boolean;
  message: string;
  stackName: string;
  /** Host URL where the deployed service is reachable. Present for
   *  successful deploys; absent for destroy/no-op runs. */
  url?: string;
}

interface ClusterConfig {
  clusterName: string;
  namespace: string;
  hostPort: number;
  /** DNS suffix appended to each deploy's stack name to form the
   *  hostname-based Ingress route, e.g. `appliance.localhost` ->
   *  `<stackName>.appliance.localhost`. Mirrors the cloud router's
   *  `<stackName>.<domain>` shape so local + remote URLs share a
   *  structure. */
  hostnameSuffix: string;
  /** Ingress class the per-appliance Ingress declares — defaults to
   *  k3s/k3d's built-in `traefik` controller. */
  ingressClassName: string;
}

// `.localhost` is reserved by RFC 6761 and resolves to 127.0.0.1
// client-side in every modern browser plus macOS / systemd-resolved /
// Windows 10+. That makes `<project>-<env>.appliance.localhost` Just
// Work in a browser the moment the cluster is up — no /etc/hosts,
// no dnsmasq, no `.local` mDNS collisions. Override via
// `base.local.cluster.hostnameSuffix` if you want a different TLD.
const DEFAULT_LOCAL_HOSTNAME_SUFFIX = 'appliance.localhost';
const DEFAULT_LOCAL_INGRESS_CLASS = 'traefik';

// Rollout-wait budget. Matches the previous kubectl-shell timeout
// (`--timeout=120s`) so behaviour at the deploy boundary is
// unchanged. Polled every ROLLOUT_POLL_INTERVAL_MS until the
// Deployment's observedGeneration catches up and all replicas report
// Ready, or this budget elapses.
const ROLLOUT_TIMEOUT_MS = 120_000;
const ROLLOUT_POLL_INTERVAL_MS = 1_000;

/**
 * Drives appliance deploys against an arbitrary Kubernetes cluster
 * (`appliance-base-local` k3d, or `appliance-base-kubernetes` for any
 * cluster reachable via URL + credentials). Maps each deploy to a
 * Deployment + Service + Ingress trio in the configured namespace;
 * destroy tears the same trio down.
 *
 * Talks to the cluster via `@kubernetes/client-node` rather than
 * shelling out to `kubectl`, so the same code path works whether
 * api-server runs on the host pointing at k3d, in-cluster via a
 * ServiceAccount, or against a remote control plane.
 *
 * Cluster lifecycle (create/start/stop of the underlying k3d cluster)
 * remains the desktop's responsibility — see Tauri's
 * `start_local_cluster` etc.
 */
export class KubernetesDeploymentService {
  private readonly cluster: ClusterConfig;
  private readonly kc: k8s.KubeConfig;
  private readonly objects: k8s.KubernetesObjectApi;
  private readonly core: k8s.CoreV1Api;
  private readonly apps: k8s.AppsV1Api;

  constructor(private readonly baseConfig: ApplianceBaseConfig) {
    if (!isKubernetesBase(baseConfig)) {
      throw new Error(
        `KubernetesDeploymentService requires a Kubernetes-driven base ` +
          `('${ApplianceBaseType.ApplianceLocal}' or '${ApplianceBaseType.ApplianceKubernetes}'), got '${baseConfig.type}'`
      );
    }
    this.cluster = resolveClusterConfig(baseConfig);
    this.kc = createKubeConfig(baseConfig);
    this.objects = k8s.KubernetesObjectApi.makeApiClient(this.kc);
    this.core = this.kc.makeApiClient(k8s.CoreV1Api);
    this.apps = this.kc.makeApiClient(k8s.AppsV1Api);
  }

  async deploy(
    stackName: string,
    metadata: LocalDeploymentMetadata,
    build: LocalResolvedBuild
  ): Promise<LocalDeploymentResult> {
    await this.ensureNamespace();
    // Best-effort import: silently skips when the image is not in the
    // host Docker daemon, the k3d CLI is missing, or the base is a
    // generic (non-k3d) Kubernetes cluster. For those cases k8s falls
    // back to a registry pull, which is the desired behaviour.
    await this.maybeImportImage(build.imageUri);

    const nodePort = deterministicNodePort(stackName);
    const hostname = applianceHostname(stackName, this.cluster.hostnameSuffix);
    const manifest = renderManifest({
      name: stackName,
      namespace: this.cluster.namespace,
      image: build.imageUri,
      port: build.port ?? 8080,
      nodePort,
      env: build.environment ?? {},
      metadata,
      hostname,
      ingressClassName: this.cluster.ingressClassName,
    });

    const before = await this.getDeploymentImage(stackName);
    const objects = k8s.loadAllYaml(manifest) as k8s.KubernetesObject[];
    for (const obj of objects) {
      await this.applyObject(obj);
    }
    await this.waitForRollout(stackName);
    // Read back the live NodePort — if k8s accepted our pinned value
    // it'll match `nodePort`; if not (e.g. collision), it picks one
    // and we report whatever the cluster recorded.
    const liveNodePort = (await this.getServiceNodePort(stackName)) ?? nodePort;

    // Primary URL goes through the cluster's Ingress (Traefik), so it
    // shares the cloud router's hostname-routing model. NodePort URL
    // is reported alongside as a direct-access fallback for setups
    // where the browser/host doesn't resolve `*.localhost`.
    const hostnameUrl = applianceHostnameUrl(hostname, this.cluster.hostPort);
    const nodePortUrl = liveNodePort ? `http://localhost:${liveNodePort}` : undefined;
    const messageBody = idempotentMessage(before === build.imageUri, hostnameUrl, nodePortUrl);

    return {
      action: 'deploy',
      ok: true,
      idempotentNoop: before === build.imageUri,
      message: messageBody,
      stackName,
      url: hostnameUrl,
    };
  }

  async destroy(stackName: string): Promise<LocalDeploymentResult> {
    const ns = this.cluster.namespace;
    const existed = await this.resourceExists('Deployment', 'apps/v1', stackName);

    // Delete all three resources; ignoring `not found` is the
    // idempotent path because any of them may already be missing from
    // a previous partial destroy.
    await this.deleteIfExists('Ingress', 'networking.k8s.io/v1', stackName);
    await this.deleteIfExists('Service', 'v1', stackName);
    await this.deleteIfExists('Deployment', 'apps/v1', stackName);

    return {
      action: 'destroy',
      ok: true,
      idempotentNoop: !existed,
      message: existed ? `Stack resources deleted from namespace ${ns}` : 'Stack not found (idempotent)',
      stackName,
    };
  }

  async refresh(stackName: string): Promise<LocalDeploymentResult> {
    // Refresh has no meaningful semantics for a kubectl-driven local
    // deploy — the live state of the cluster IS the source of truth.
    // We report a no-op so the api-server's executor can settle the
    // deployment record without surfacing a misleading error.
    const exists = await this.resourceExists('Deployment', 'apps/v1', stackName);
    return {
      action: 'refresh',
      ok: true,
      idempotentNoop: true,
      message: exists ? 'Local stacks have no separate state to refresh' : 'Stack not found (nothing to refresh)',
      stackName,
    };
  }

  async getDeploymentImage(stackName: string): Promise<string | undefined> {
    try {
      const dep = await this.apps.readNamespacedDeployment({ name: stackName, namespace: this.cluster.namespace });
      return dep.spec?.template?.spec?.containers?.[0]?.image ?? undefined;
    } catch (err) {
      if (isNotFoundError(err)) return undefined;
      throw err;
    }
  }

  /**
   * Read the current env block off the live Deployment. Used by the
   * api-server's executor when a bare re-deploy (no buildId, no env
   * override) lands locally: re-rendering the manifest with no env
   * would strip the prior values, so we lift them in to keep the
   * container's PORT (and any other deploy-time env) intact.
   * Returns undefined if the deployment doesn't exist.
   */
  async getDeploymentEnv(stackName: string): Promise<Record<string, string> | undefined> {
    try {
      const dep = await this.apps.readNamespacedDeployment({ name: stackName, namespace: this.cluster.namespace });
      const envList = dep.spec?.template?.spec?.containers?.[0]?.env ?? [];
      const out: Record<string, string> = {};
      for (const entry of envList) {
        if (entry?.name && typeof entry.value === 'string') out[entry.name] = entry.value;
      }
      return out;
    } catch (err) {
      if (isNotFoundError(err)) return undefined;
      throw err;
    }
  }

  private async ensureNamespace(): Promise<void> {
    try {
      await this.core.readNamespace({ name: this.cluster.namespace });
      return;
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
    await this.core.createNamespace({
      body: { apiVersion: 'v1', kind: 'Namespace', metadata: { name: this.cluster.namespace } },
    });
  }

  private async maybeImportImage(image: string): Promise<void> {
    // Image-import is only meaningful for the k3d-on-laptop runtime.
    // Generic Kubernetes bases must have the image already pushed to
    // a registry the cluster can reach.
    if (this.baseConfig.type !== ApplianceBaseType.ApplianceLocal) return;
    // Only push host-built images into k3d. Anything with a registry
    // host (a `.` or `:port` before the first slash) is treated as
    // remote-pull territory and skipped.
    if (isRegistryReference(image)) return;
    try {
      await execFileAsync('k3d', ['image', 'import', image, '-c', this.cluster.clusterName], {
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (err) {
      // k3d not installed, image missing from host daemon, etc. —
      // let the deploy proceed: kubelet will surface ImagePullBackOff
      // on the Pod which the rollout-wait will then time out on.
      // Surfacing the import error here would hide unrelated failures.
      const message = err instanceof Error ? err.message : String(err);
      if (!/already in use|exists/.test(message)) {
        console.warn(`k3d image import skipped: ${message}`);
      }
    }
  }

  /**
   * `kubectl apply` equivalent for a single object: read existing,
   * replace on hit (preserving immutable fields like Service.clusterIP),
   * create on miss. Strategic-merge would be more accurate for partial
   * field updates, but the manifest we send is the complete intended
   * state for these resources, so a full replace is semantically
   * equivalent and avoids the per-resource patch-type plumbing.
   */
  private async applyObject(desired: k8s.KubernetesObject): Promise<void> {
    if (!desired.metadata?.name) {
      throw new Error(`KubernetesObject of kind '${desired.kind}' is missing metadata.name`);
    }
    // KubernetesObjectApi.read() takes a header-shaped object (the
    // `KubernetesObjectHeader` alias the library doesn't re-export);
    // construct it inline so we don't depend on the alias name.
    const header = {
      apiVersion: desired.apiVersion ?? '',
      kind: desired.kind ?? '',
      metadata: { name: desired.metadata.name, namespace: desired.metadata.namespace },
    };
    try {
      const existing = await this.objects.read(header);
      const merged: k8s.KubernetesObject = {
        ...desired,
        metadata: { ...desired.metadata, resourceVersion: existing.metadata?.resourceVersion },
      };
      // Service.spec.{clusterIP,clusterIPs} are immutable post-create;
      // a replace that omits them gets rejected. Lift the live values
      // back into the desired spec so the round-trip is a no-op for
      // those fields.
      if (desired.kind === 'Service') {
        const existingSpec = (existing as { spec?: Record<string, unknown> }).spec ?? {};
        const desiredSpec = (desired as { spec?: Record<string, unknown> }).spec ?? {};
        (merged as { spec: Record<string, unknown> }).spec = {
          ...desiredSpec,
          clusterIP: existingSpec.clusterIP,
          clusterIPs: existingSpec.clusterIPs,
        };
      }
      await this.objects.replace(merged);
    } catch (err) {
      if (isNotFoundError(err)) {
        await this.objects.create(desired);
        return;
      }
      throw err;
    }
  }

  private async deleteIfExists(kind: string, apiVersion: string, name: string): Promise<void> {
    try {
      await this.objects.delete({ apiVersion, kind, metadata: { name, namespace: this.cluster.namespace } });
    } catch (err) {
      if (isNotFoundError(err)) return;
      throw err;
    }
  }

  /**
   * Poll the Deployment until the controller has observed our latest
   * generation and all desired replicas report Ready, or the rollout
   * budget elapses. Mirrors `kubectl rollout status` semantics: an
   * error from the API surfaces as the rollout failure, a stable but
   * un-ready state surfaces as a timeout.
   */
  private async waitForRollout(stackName: string): Promise<void> {
    const deadline = Date.now() + ROLLOUT_TIMEOUT_MS;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const dep = await this.apps.readNamespacedDeployment({
          name: stackName,
          namespace: this.cluster.namespace,
        });
        const desiredReplicas = dep.spec?.replicas ?? 1;
        const status = dep.status ?? {};
        const observed = status.observedGeneration ?? -1;
        const generation = dep.metadata?.generation ?? 0;
        const ready = status.readyReplicas ?? 0;
        const updated = status.updatedReplicas ?? 0;
        if (observed >= generation && updated >= desiredReplicas && ready >= desiredReplicas) {
          return;
        }
      } catch (err) {
        lastErr = err;
      }
      await sleep(ROLLOUT_POLL_INTERVAL_MS);
    }
    const tail = lastErr instanceof Error ? `: ${lastErr.message}` : '';
    throw new Error(`Rollout did not complete within ${Math.floor(ROLLOUT_TIMEOUT_MS / 1000)}s${tail}`);
  }

  private async resourceExists(kind: string, apiVersion: string, name: string): Promise<boolean> {
    try {
      await this.objects.read({ apiVersion, kind, metadata: { name, namespace: this.cluster.namespace } });
      return true;
    } catch (err) {
      if (isNotFoundError(err)) return false;
      throw err;
    }
  }

  private async getServiceNodePort(stackName: string): Promise<number | undefined> {
    try {
      const svc = await this.core.readNamespacedService({ name: stackName, namespace: this.cluster.namespace });
      const port = svc.spec?.ports?.[0]?.nodePort;
      return typeof port === 'number' && port > 0 ? port : undefined;
    } catch {
      return undefined;
    }
  }
}

// Backwards-compat alias — the executor and any direct consumers
// still import `LocalContainerDeploymentService`. Aliased rather than
// subclassed so the class identity (typeof instances) matches the
// new name. Drop in a follow-up once consumers migrate.
export const LocalContainerDeploymentService = KubernetesDeploymentService;
export type LocalContainerDeploymentService = KubernetesDeploymentService;

/**
 * Build a KubeConfig from the base config. Four supported modes,
 * in priority order:
 *   1. `appliance-base-kubernetes` with inline `kubeconfig` — parsed
 *      verbatim. Covers BYO clusters where the operator already has
 *      a working kubeconfig.
 *   2. `appliance-base-kubernetes` with `server` + `token` — built
 *      programmatically. The common path for in-cluster API tokens
 *      and ServiceAccount-issued credentials supplied out of band.
 *   3. `appliance-base-kubernetes` with none of the above — falls
 *      back to `loadFromCluster()`, which reads the pod's mounted
 *      ServiceAccount token + CA. The expected path when api-server
 *      itself runs inside the cluster it manages.
 *   4. `appliance-base-local` — loads the host's default kubeconfig
 *      (preserves prior behaviour for k3d-on-laptop dev).
 */
function createKubeConfig(baseConfig: ApplianceBaseConfig): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  if (baseConfig.type === ApplianceBaseType.ApplianceKubernetes) {
    const cfg = baseConfig.kubernetes;
    if (!cfg) {
      throw new Error(`'kubernetes' block is required for ${ApplianceBaseType.ApplianceKubernetes} bases`);
    }
    if (cfg.kubeconfig) {
      kc.loadFromString(cfg.kubeconfig);
      return kc;
    }
    if (cfg.server && cfg.token) {
      kc.addCluster({
        name: 'appliance',
        server: cfg.server,
        caData: cfg.ca,
        skipTLSVerify: !cfg.ca,
      });
      kc.addUser({ name: 'appliance', token: cfg.token });
      kc.addContext({
        name: 'appliance',
        cluster: 'appliance',
        user: 'appliance',
        namespace: cfg.namespace,
      });
      kc.setCurrentContext('appliance');
      return kc;
    }
    // No explicit credentials → assume in-cluster ServiceAccount.
    kc.loadFromCluster();
    return kc;
  }
  // appliance-base-local: trust whatever the host kubeconfig points
  // at. The desktop's cluster lifecycle keeps that pointed at the
  // managed k3d cluster.
  kc.loadFromDefault();
  return kc;
}

function resolveClusterConfig(baseConfig: ApplianceBaseConfig): ClusterConfig {
  // Common k8s params (namespace, hostnameSuffix, ingressClassName)
  // come from whichever subobject the variant uses. hostPort is the
  // host-side port the cluster's ingress/LB answers on, used only for
  // the URLs reported back from deploys. `appliance-base-local`
  // defaults to the k3d serverlb publish port (8081);
  // `appliance-base-kubernetes` honors an explicit `hostPort` (set by
  // the desktop/CLI-managed in-cluster runtime, whose serverlb also
  // publishes on a non-80 port) and otherwise assumes the canonical
  // 80, rendered port-less (applianceHostnameUrl elides :80) —
  // stamping the k3d default onto a generic Kubernetes URL produced a
  // bogus `:8081` suffix on every reported deploy URL.
  const k8sParams = getKubernetesParams(baseConfig);
  const localCluster = baseConfig.local?.cluster ?? {};
  const hostPort =
    baseConfig.type === ApplianceBaseType.ApplianceLocal
      ? (localCluster.hostPort ?? DEFAULT_LOCAL_HOST_PORT)
      : (baseConfig.kubernetes?.hostPort ?? 80);
  return {
    clusterName: localCluster.clusterName ?? DEFAULT_LOCAL_CLUSTER_NAME,
    namespace: k8sParams?.namespace ?? DEFAULT_LOCAL_NAMESPACE,
    hostPort,
    hostnameSuffix: k8sParams?.hostnameSuffix ?? DEFAULT_LOCAL_HOSTNAME_SUFFIX,
    ingressClassName: k8sParams?.ingressClassName ?? DEFAULT_LOCAL_INGRESS_CLASS,
  };
}

/**
 * Build the public hostname for an appliance. Mirrors the cloud
 * router's `<stackName>.<domain>` shape — same structure, just a
 * different domain. Stack names come straight from project-environment
 * which already match RFC 1123 (lowercase, alphanumeric, hyphens)
 * because both names are validated by the api-server, so no
 * additional sanitization is needed.
 */
export function applianceHostname(stackName: string, hostnameSuffix: string): string {
  return `${stackName}.${hostnameSuffix}`;
}

/**
 * Compose a host-reachable URL for an appliance. Omits the port when
 * it's the default 80, matching how browsers render URLs.
 */
export function applianceHostnameUrl(hostname: string, hostPort: number): string {
  if (hostPort === 80) return `http://${hostname}`;
  return `http://${hostname}:${hostPort}`;
}

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  // @kubernetes/client-node v1 surfaces apiserver errors as ApiException
  // with a `.code` (HTTP status). Older shapes used `.statusCode` or
  // `.response.statusCode`; check all three plus the legacy string
  // match for kubectl-shaped errors so the wrapper stays compatible
  // with mocked tests.
  const e = err as { code?: number; statusCode?: number; response?: { statusCode?: number }; message?: string };
  if (e.code === 404 || e.statusCode === 404 || e.response?.statusCode === 404) return true;
  if (typeof e.message === 'string') {
    return /not\s*found/i.test(e.message) || /Error from server \(NotFound\)/i.test(e.message);
  }
  return false;
}

/**
 * Build the user-visible deploy message. Surfaces both the
 * hostname-based URL (the canonical "live URL" via the cluster's
 * Ingress) and the NodePort URL (direct-access fallback). When the
 * deploy is a no-op we keep the message short — the URLs haven't
 * changed.
 */
function idempotentMessage(noop: boolean, hostnameUrl: string, nodePortUrl: string | undefined): string {
  if (noop) return 'No changes (idempotent)';
  if (nodePortUrl) {
    return `Stack updated. URL: ${hostnameUrl} (direct: ${nodePortUrl})`;
  }
  return `Stack updated. URL: ${hostnameUrl}`;
}

function isRegistryReference(image: string): boolean {
  const firstSegment = image.split('/')[0];
  return firstSegment.includes('.') || firstSegment.includes(':');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ManifestParams {
  name: string;
  namespace: string;
  image: string;
  port: number;
  /** Explicit NodePort the Service should bind. When omitted, k8s
   *  picks any free port in 30000-32767. The demo cluster only
   *  publishes a small NodePort window, so the executor sets this
   *  deterministically per stack via deterministicNodePort(). */
  nodePort?: number;
  env: Record<string, string>;
  metadata: LocalDeploymentMetadata;
  /** Public hostname Traefik routes to this appliance via the
   *  generated Ingress. Typically `<stackName>.appliance.localhost`. */
  hostname: string;
  /** IngressClass the Ingress declares (k3s/k3d ships `traefik`). */
  ingressClassName: string;
}

/**
 * Hash the stack name into [DEFAULT_LOCAL_NODEPORT_MIN,
 * DEFAULT_LOCAL_NODEPORT_MAX] so each appliance gets a stable
 * NodePort across deploys. Same name → same port — important for
 * the demo, where the script wants to curl the deployed Service
 * without first having to look up the assigned port.
 */
export function deterministicNodePort(stackName: string): number {
  const range = DEFAULT_LOCAL_NODEPORT_MAX - DEFAULT_LOCAL_NODEPORT_MIN + 1;
  let hash = 0;
  for (let i = 0; i < stackName.length; i++) {
    hash = (hash * 31 + stackName.charCodeAt(i)) | 0;
  }
  return DEFAULT_LOCAL_NODEPORT_MIN + (Math.abs(hash) % range);
}

export function renderManifest(params: ManifestParams): string {
  const { name, namespace, image, port, nodePort, env, metadata, hostname, ingressClassName } = params;
  // Cluster-IP for in-cluster reachability would be ideal, but the
  // dev story is "hit the appliance from a browser on the host", so
  // we publish via NodePort. k3d's built-in loadbalancer hairpins
  // host ports onto the node — but until a NodePort range is mapped
  // at cluster creation, NodePort still surfaces a unique
  // host-reachable port (30000-32767) for each service.
  const envEntries = Object.entries(env);
  const envBlock =
    envEntries.length === 0
      ? ''
      : envEntries.map(([k, v]) => `        - name: ${yamlString(k)}\n          value: ${yamlString(v)}`).join('\n');
  const envSection = envBlock ? `\n        env:\n${envBlock}` : '';

  // `imagePullPolicy: IfNotPresent` so k3d picks up the imported
  // image instead of trying to re-pull from a registry it cannot
  // reach (host-built images aren't in any remote registry).
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${yamlString(name)}
  namespace: ${yamlString(namespace)}
  labels:
    app.kubernetes.io/managed-by: appliance.sh
    appliance.sh/project: ${yamlString(metadata.projectName)}
    appliance.sh/environment: ${yamlString(metadata.environmentName)}
  annotations:
    appliance.sh/deployment-id: ${yamlString(metadata.deploymentId)}
    appliance.sh/project-id: ${yamlString(metadata.projectId)}
    appliance.sh/environment-id: ${yamlString(metadata.environmentId)}
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: ${yamlString(name)}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${yamlString(name)}
        app.kubernetes.io/managed-by: appliance.sh
    spec:
      containers:
      - name: app
        image: ${yamlString(image)}
        imagePullPolicy: IfNotPresent
        ports:
        - containerPort: ${port}${envSection}
---
apiVersion: v1
kind: Service
metadata:
  name: ${yamlString(name)}
  namespace: ${yamlString(namespace)}
  labels:
    app.kubernetes.io/managed-by: appliance.sh
spec:
  type: NodePort
  selector:
    app.kubernetes.io/name: ${yamlString(name)}
  ports:
  - port: ${port}
    targetPort: ${port}
    protocol: TCP${nodePort ? `\n    nodePort: ${nodePort}` : ''}
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${yamlString(name)}
  namespace: ${yamlString(namespace)}
  labels:
    app.kubernetes.io/managed-by: appliance.sh
    appliance.sh/project: ${yamlString(metadata.projectName)}
    appliance.sh/environment: ${yamlString(metadata.environmentName)}
  annotations:
    appliance.sh/deployment-id: ${yamlString(metadata.deploymentId)}
spec:
  ingressClassName: ${yamlString(ingressClassName)}
  rules:
  - host: ${yamlString(hostname)}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: ${yamlString(name)}
            port:
              number: ${port}
`;
}

/**
 * Always-quoted YAML string emitter. Quoting unconditionally
 * sidesteps the `:`, `#`, leading-dash, etc. parsing rules and
 * makes the rendered manifest unambiguous regardless of caller
 * input. Escapes only `\` and `"` inside the quoted form.
 */
function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
