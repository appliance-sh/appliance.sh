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

/**
 * Local-runtime counterpart to ApplianceDeploymentService. Maps each
 * deploy to a single Kubernetes Deployment + Service inside a
 * developer-side k3d cluster. Destroy tears the same pair down.
 *
 * Cluster lifecycle (create/start/stop) is the desktop's
 * responsibility — see Tauri's `start_local_cluster` etc. This
 * service assumes `kubectl` already has access to the running
 * cluster and that the named image is importable (either built on
 * the host Docker daemon and pre-imported via `k3d image import`,
 * or pullable by the cluster directly).
 */
export class LocalContainerDeploymentService {
  private readonly cluster: ClusterConfig;

  constructor(private readonly baseConfig: ApplianceBaseConfig) {
    if (!isKubernetesBase(baseConfig)) {
      throw new Error(
        `LocalContainerDeploymentService requires a Kubernetes-driven base ` +
          `('${ApplianceBaseType.ApplianceLocal}' or '${ApplianceBaseType.ApplianceKubernetes}'), got '${baseConfig.type}'`
      );
    }
    this.cluster = resolveClusterConfig(baseConfig);
  }

  async deploy(
    stackName: string,
    metadata: LocalDeploymentMetadata,
    build: LocalResolvedBuild
  ): Promise<LocalDeploymentResult> {
    await this.ensureNamespace();
    // Best-effort import: silently skips when the image is not in the
    // host Docker daemon — k3s will then try a registry pull, which
    // is the desired behaviour for remote images (ghcr.io/...).
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
    await this.kubectlApply(manifest);
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
    const existed = await this.resourceExists('deployment', stackName);

    // Delete all three resources; ignoring `not found` is the
    // idempotent path because any of them may already be missing from
    // a previous partial destroy.
    await this.kubectlDeleteIfExists('ingress', stackName);
    await this.kubectlDeleteIfExists('service', stackName);
    await this.kubectlDeleteIfExists('deployment', stackName);

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
    const exists = await this.resourceExists('deployment', stackName);
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
      const { stdout } = await this.kubectl([
        '-n',
        this.cluster.namespace,
        'get',
        'deployment',
        stackName,
        '-o',
        'jsonpath={.spec.template.spec.containers[0].image}',
      ]);
      const trimmed = stdout.trim();
      return trimmed || undefined;
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
      const { stdout } = await this.kubectl([
        '-n',
        this.cluster.namespace,
        'get',
        'deployment',
        stackName,
        '-o',
        'jsonpath={.spec.template.spec.containers[0].env}',
      ]);
      const trimmed = stdout.trim();
      if (!trimmed) return {};
      const parsed = JSON.parse(trimmed) as Array<{ name?: string; value?: string }>;
      const out: Record<string, string> = {};
      for (const entry of parsed) {
        if (entry?.name && typeof entry.value === 'string') out[entry.name] = entry.value;
      }
      return out;
    } catch (err) {
      if (isNotFoundError(err)) return undefined;
      throw err;
    }
  }

  private async ensureNamespace(): Promise<void> {
    const exists = await this.resourceExists('namespace', this.cluster.namespace, { clusterScoped: true });
    if (exists) return;
    await this.kubectl(['create', 'namespace', this.cluster.namespace]);
  }

  private async maybeImportImage(image: string): Promise<void> {
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

  private async kubectlApply(manifest: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        'kubectl',
        ['apply', '-f', '-'],
        { maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const message = stderr || stdout || (err as Error).message;
            reject(new Error(`kubectl apply failed: ${message}`));
            return;
          }
          resolve();
        }
      );
      child.stdin?.end(manifest);
    });
  }

  private async waitForRollout(stackName: string): Promise<void> {
    try {
      await this.kubectl([
        '-n',
        this.cluster.namespace,
        'rollout',
        'status',
        `deployment/${stackName}`,
        '--timeout=120s',
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Rollout did not complete: ${message}`);
    }
  }

  private async kubectlDeleteIfExists(kind: string, name: string): Promise<void> {
    try {
      await this.kubectl(['-n', this.cluster.namespace, 'delete', kind, name, '--ignore-not-found=true']);
    } catch (err) {
      if (isNotFoundError(err)) return;
      throw err;
    }
  }

  private async resourceExists(kind: string, name: string, opts?: { clusterScoped?: boolean }): Promise<boolean> {
    const args = opts?.clusterScoped ? [] : ['-n', this.cluster.namespace];
    try {
      await this.kubectl([...args, 'get', kind, name]);
      return true;
    } catch (err) {
      if (isNotFoundError(err)) return false;
      throw err;
    }
  }

  private async getServiceNodePort(stackName: string): Promise<number | undefined> {
    try {
      const { stdout } = await this.kubectl([
        '-n',
        this.cluster.namespace,
        'get',
        'service',
        stackName,
        '-o',
        'jsonpath={.spec.ports[0].nodePort}',
      ]);
      const port = Number.parseInt(stdout.trim(), 10);
      return Number.isFinite(port) && port > 0 ? port : undefined;
    } catch {
      return undefined;
    }
  }

  private async kubectl(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('kubectl', args, { maxBuffer: 16 * 1024 * 1024 });
  }
}

function resolveClusterConfig(baseConfig: ApplianceBaseConfig): ClusterConfig {
  // Common k8s params (namespace, hostnameSuffix, ingressClassName)
  // come from whichever subobject the variant uses. Local-only
  // fields (k3d cluster name, host port) only have meaning for
  // `appliance-base-local`; for generic Kubernetes bases they fall
  // back to schema defaults that aren't actually used (the k3d
  // host-port routing is replaced by external Ingress).
  const k8s = getKubernetesParams(baseConfig);
  const localCluster = baseConfig.local?.cluster ?? {};
  return {
    clusterName: localCluster.clusterName ?? DEFAULT_LOCAL_CLUSTER_NAME,
    namespace: k8s?.namespace ?? DEFAULT_LOCAL_NAMESPACE,
    hostPort: localCluster.hostPort ?? DEFAULT_LOCAL_HOST_PORT,
    hostnameSuffix: k8s?.hostnameSuffix ?? DEFAULT_LOCAL_HOSTNAME_SUFFIX,
    ingressClassName: k8s?.ingressClassName ?? DEFAULT_LOCAL_INGRESS_CLASS,
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
  if (!(err instanceof Error)) return false;
  return /not\s*found/i.test(err.message) || /Error from server \(NotFound\)/i.test(err.message);
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
