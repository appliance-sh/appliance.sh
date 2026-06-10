import * as fs from 'node:fs';
import { runCommand, sleep } from './exec.js';
import { ensureDockerRunning } from './runtime.js';
import type { ProgressEvent } from './types.js';

// k3d cluster + sibling registry lifecycle for the local runtime.
// TypeScript port of the desktop's Tauri commands (`start_local_cluster`
// and friends in packages/desktop/src-tauri/src/lib.rs) so the CLI can
// drive the same flows headlessly — CI, remote boxes, power users.
// Behavior changes should land in both places until the desktop
// delegates here via the sidecar.

// Default k3d cluster name. Must match DEFAULT_LOCAL_CLUSTER_NAME in
// packages/infra/src/lib/local/LocalContainerDeploymentService.ts and
// the desktop's lib.rs.
export const DEFAULT_LOCAL_CLUSTER_NAME = 'appliance-local';
export const DEFAULT_LOCAL_NAMESPACE = 'appliance';
// Host port the cluster LoadBalancer publishes. Default 8081 — keeps
// clear of the desktop's 1420 dev server and common 8080.
export const DEFAULT_LOCAL_HOST_PORT = 8081;
// NodePort sub-range published from the k3d agent onto the host. Kept
// small (51 ports) because publishing the full 30000-32767 window
// crashes colima/docker on macOS at the docker-proxy layer.
// LocalContainerDeploymentService.deterministicNodePort() picks within
// the same range so each deployment's NodePort is reachable here.
export const DEFAULT_LOCAL_NODEPORT_MIN = 30000;
export const DEFAULT_LOCAL_NODEPORT_MAX = 30050;
// Host-side port the k3d-attached registry publishes on. Picked out of
// the way of common dev tools (5000 is occupied by macOS AirPlay
// Receiver on Sequoia+, 5001 by some VPN clients).
export const DEFAULT_LOCAL_REGISTRY_PORT = 5050;

export interface LocalClusterOptions {
  clusterName?: string;
  /** Host port the cluster's LoadBalancer publishes (forwards onto the
   *  k3d serverlb container, which then hits NodePorts inside). */
  hostPort?: number;
  /** Host-side port the k3d-attached registry publishes on. */
  registryPort?: number;
  /**
   * Host-side directory bind-mounted into the k3d node container so
   * the in-cluster api-server's PersistentVolume (hostPath inside the
   * node) actually maps onto durable host storage. Without this,
   * `k3d cluster delete` wipes everything the FilesystemObjectStore
   * wrote (projects, environments, keys).
   */
  dataDir?: string;
  onProgress?: (event: ProgressEvent) => void;
}

export interface LocalClusterStatus {
  /** True when `k3d` is on PATH and the named cluster shows up in
   *  `k3d cluster list -o json`. */
  exists: boolean;
  /** True when the cluster's nodes are all reporting `running`. Stop
   *  flips this to false; the cluster still exists and can be
   *  restarted without recreating state. */
  running: boolean;
  clusterName: string;
  /** Reason a status check couldn't be completed (k3d missing, docker
   *  not running, …). Surfaced verbatim to the user. */
  message?: string;
}

export function clusterNameOrDefault(opts: LocalClusterOptions): string {
  return opts.clusterName ?? DEFAULT_LOCAL_CLUSTER_NAME;
}

/** kubectl context name k3d writes for a cluster. */
export function kubeContextForCluster(cluster: string): string {
  return `k3d-${cluster}`;
}

/**
 * k3d registry name attached to a given cluster. The k3d CLI prefixes
 * every registry name with `k3d-` once created, so we pass the
 * unprefixed form to `k3d registry create / delete` and accept either
 * form when matching against `k3d registry list -o json`.
 */
export function registryNameForCluster(cluster: string): string {
  return `${cluster}-registry`;
}

/**
 * Probe k3d for a cluster by name. Returns existence + running state;
 * absent k3d / docker reports `exists: false, running: false` with a
 * populated `message` so callers can render an actionable hint
 * instead of a stack trace.
 */
export async function localClusterStatus(opts: LocalClusterOptions = {}): Promise<LocalClusterStatus> {
  const clusterName = clusterNameOrDefault(opts);
  let result;
  try {
    result = await runCommand(['k3d', 'cluster', 'list', '-o', 'json']);
  } catch (err) {
    return { exists: false, running: false, clusterName, message: err instanceof Error ? err.message : String(err) };
  }
  if (!result.ok) {
    return { exists: false, running: false, clusterName, message: result.stderr.trim() };
  }
  // Scan the raw list JSON instead of `k3d cluster get <name>` — the
  // latter exits non-zero when the cluster is stopped, which would
  // force disambiguating "stopped" from "missing" via stderr parsing.
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    return { exists: false, running: false, clusterName, message: `parse k3d cluster list: ${String(err)}` };
  }
  const clusters = Array.isArray(parsed) ? parsed : [];
  for (const cluster of clusters as Array<Record<string, unknown>>) {
    if (cluster?.name !== clusterName) continue;
    const nodes = Array.isArray(cluster.nodes) ? (cluster.nodes as Array<Record<string, unknown>>) : [];
    const running =
      nodes.length > 0 &&
      nodes.every((n) => {
        const state = n?.State as Record<string, unknown> | undefined;
        return state?.Running === true;
      });
    return { exists: true, running, clusterName };
  }
  return { exists: false, running: false, clusterName };
}

/**
 * Symptoms `k3d cluster start` emits when the cluster's containers
 * came back in a half-initialised state — typically after the Docker
 * VM was suspended/restarted underneath a stopped cluster. k3d reports
 * the node `running=true` but stuck `restarting`, then times out
 * waiting for k3s's startup log line. A clean stop+start of the node
 * containers almost always clears it.
 */
export function isWedgedStartFailure(stderr: string): boolean {
  return (
    stderr.includes('status=restarting') ||
    stderr.includes('stopped returning log lines') ||
    stderr.includes('error during post-start cluster preparation')
  );
}

/**
 * Start an existing (stopped) cluster, recovering once from the
 * wedged-node failure above. On the retry we first force a clean
 * `k3d cluster stop` so every node container is torn down before the
 * second `start` — that full teardown is what actually unsticks a
 * frozen kubelet/agent, which a bare re-`start` would leave wedged.
 */
async function startExistingCluster(name: string): Promise<void> {
  const first = await runCommand(['k3d', 'cluster', 'start', name]);
  if (first.ok) return;
  if (!isWedgedStartFailure(first.stderr)) {
    throw new Error(`k3d cluster start failed: ${first.stderr.trim()}`);
  }
  await runCommand(['k3d', 'cluster', 'stop', name]);
  const retry = await runCommand(['k3d', 'cluster', 'start', name]);
  if (retry.ok) return;
  throw new Error(
    `k3d cluster start failed after one recovery attempt: ${retry.stderr.trim()}\n` +
      `The cluster's containers may be in a bad state — try \`k3d cluster delete ${name}\` ` +
      `and recreate it, or inspect \`docker logs k3d-${name}-server-0\`.`
  );
}

// How long to wait for every k8s node to report Ready before treating
// the cluster as wedged. Normal post-start readiness lands within
// ~30s; a kubelet that hasn't registered Ready after this long never
// will without a container restart.
const NODE_READY_TIMEOUT_MS = 90_000;

async function allNodesReady(context: string): Promise<boolean> {
  const r = await runCommand(['kubectl', '--context', context, 'get', 'nodes', '-o', 'json']);
  if (!r.ok) return false;
  try {
    const parsed = JSON.parse(r.stdout) as { items?: Array<Record<string, unknown>> };
    const items = parsed.items ?? [];
    if (items.length === 0) return false;
    return items.every((node) => {
      const status = node.status as { conditions?: Array<{ type?: string; status?: string }> } | undefined;
      return (status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');
    });
  } catch {
    return false;
  }
}

/**
 * Poll until every node in the cluster reports the k8s `Ready`
 * condition, or the timeout elapses. Returns false on timeout rather
 * than throwing so callers can attempt recovery.
 */
export async function waitForNodesReady(clusterName: string, timeoutMs = NODE_READY_TIMEOUT_MS): Promise<boolean> {
  const context = kubeContextForCluster(clusterName);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await allNodesReady(context)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(1_000);
  }
}

/**
 * Idempotent registry create: probe `k3d registry list`, create if
 * missing. Errors that look like "already exists" / "port in use" are
 * surfaced verbatim — those need user action (rename or free the
 * port), not a silent retry.
 */
export async function ensureRegistry(name: string, port: number): Promise<void> {
  try {
    const list = await runCommand(['k3d', 'registry', 'list', '-o', 'json']);
    if (list.ok) {
      const parsed = JSON.parse(list.stdout) as Array<Record<string, unknown>>;
      const prefixed = `k3d-${name}`;
      if (Array.isArray(parsed) && parsed.some((e) => e?.name === name || e?.name === prefixed)) {
        return;
      }
    }
  } catch {
    // List/parse failure → fall through to create; its error is the
    // one worth surfacing.
  }
  // Bind only on loopback. The cluster reaches the registry through
  // Docker's internal bridge network via the registry container's DNS
  // name (wired by `--registry-use`), not through the host-published
  // port — so loopback-only binding doesn't break pulls. It DOES keep
  // the unauthenticated registry off any LAN interface, which matters
  // on shared networks where a predictable `localhost:5050/<image>`
  // tag would otherwise be pre-positionable by anyone on the subnet.
  const create = await runCommand(['k3d', 'registry', 'create', name, '--port', `127.0.0.1:${port}`]);
  if (!create.ok) {
    throw new Error(`k3d registry create failed: ${create.stderr.trim()}`);
  }
}

/**
 * Probe `k3d registry list` for a registry attached to the named
 * cluster. Returns `localhost:<port>` when one exists, null on probe
 * failure or absence — callers treat null as "no registry available,
 * fall back to k3d image import".
 */
export async function probeRegistryUrl(clusterName: string, candidatePort: number): Promise<string | null> {
  try {
    const list = await runCommand(['k3d', 'registry', 'list', '-o', 'json']);
    if (!list.ok) return null;
    const parsed = JSON.parse(list.stdout) as Array<Record<string, unknown>>;
    if (!Array.isArray(parsed)) return null;
    const registryName = registryNameForCluster(clusterName);
    const prefixed = `k3d-${registryName}`;
    if (parsed.some((e) => e?.name === registryName || e?.name === prefixed)) {
      return `localhost:${candidatePort}`;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Import a locally-built docker image into the cluster's containerd
 * store under its exact ref. Returns false (no-op) when the image
 * isn't present in the local daemon — the cluster will pull it
 * instead. This is the universal fallback for clusters whose
 * registries.yaml doesn't mirror the sibling registry (clusters
 * created before the registry existed: `--registry-use` only takes
 * effect at create time) — with `imagePullPolicy: IfNotPresent`, an
 * imported image never needs a pull at all.
 */
export async function importImageToCluster(image: string, clusterName: string): Promise<boolean> {
  const inspect = await runCommand(['docker', 'image', 'inspect', image]);
  if (!inspect.ok) return false;
  const r = await runCommand(['k3d', 'image', 'import', image, '-c', clusterName]);
  if (!r.ok) {
    throw new Error(`k3d image import failed: ${r.stderr.trim()}`);
  }
  return true;
}

/**
 * Create-or-start the named k3d cluster. Idempotent: an existing
 * stopped cluster is started; an existing running cluster is left
 * alone. Maps the cluster LoadBalancer's :80 onto `hostPort` so
 * services deployed by the api-server are reachable from the host.
 */
export async function startLocalCluster(opts: LocalClusterOptions = {}): Promise<LocalClusterStatus> {
  const name = clusterNameOrDefault(opts);
  const registryPort = opts.registryPort ?? DEFAULT_LOCAL_REGISTRY_PORT;
  const registryName = registryNameForCluster(name);
  const emit = (message: string) => opts.onProgress?.({ type: 'progress', tool: 'k3d', message });

  // Bring the container runtime up first — every k3d / registry call
  // below needs a reachable Docker daemon, and a stopped colima VM is
  // the single most common reason "start cluster" fails (with a
  // cryptic k3d timeout rather than a clear "Docker isn't running").
  await ensureDockerRunning({ onProgress: opts.onProgress });

  // Ensure the registry exists regardless of whether we're about to
  // create or restart the cluster. It's a sibling container, not a
  // cluster-owned one, so a Docker restart / `docker rm` between
  // sessions can leave the cluster up but the registry gone — in
  // which case ensureRegistry brings it back, idempotently.
  emit(`ensuring registry ${registryName} on 127.0.0.1:${registryPort}`);
  await ensureRegistry(registryName, registryPort);

  const status = await localClusterStatus({ clusterName: name });
  if (status.exists) {
    if (!status.running) {
      emit(`starting existing cluster ${name}`);
      await startExistingCluster(name);
    }
  } else {
    // Fresh creation. We publish two port ranges:
    //   1. hostPort -> serverlb:80 for the in-cluster ingress/LB path
    //      (api-server, ingress-managed apps).
    //   2. A small NodePort window -> agent:0 so the executor's
    //      Service NodePorts are directly reachable on the host.
    const hostPort = opts.hostPort ?? DEFAULT_LOCAL_HOST_PORT;
    const args = [
      'k3d',
      'cluster',
      'create',
      name,
      '--agents',
      '1',
      '-p',
      `${hostPort}:80@loadbalancer`,
      '-p',
      `${DEFAULT_LOCAL_NODEPORT_MIN}-${DEFAULT_LOCAL_NODEPORT_MAX}:${DEFAULT_LOCAL_NODEPORT_MIN}-${DEFAULT_LOCAL_NODEPORT_MAX}@agent:0`,
      '--registry-use',
      `${registryName}:${registryPort}`,
    ];
    if (opts.dataDir) {
      // Ensure the source exists before docker mounts it — docker
      // auto-creates missing host paths as root-owned dirs, which then
      // can't be written by the user later. Same path on both sides of
      // the colon so manifests can use one absolute path everywhere.
      fs.mkdirSync(opts.dataDir, { recursive: true });
      args.push('--volume', `${opts.dataDir}:${opts.dataDir}`);
    }
    args.push('--wait');
    emit(
      `creating cluster ${name} (LB :${hostPort}, NodePorts ${DEFAULT_LOCAL_NODEPORT_MIN}-${DEFAULT_LOCAL_NODEPORT_MAX})`
    );
    const create = await runCommand(args);
    if (!create.ok) {
      throw new Error(`k3d cluster create failed: ${create.stderr.trim()}`);
    }
  }

  // Container-level "running" doesn't imply the cluster is usable:
  // after the Docker VM restarts underneath it (laptop reboot, colima
  // stop/start), the node containers auto-restart but a kubelet can
  // come back wedged — k3d reports running while `kubectl get nodes`
  // shows NotReady forever and every scheduled pod sits Pending. Wait
  // for k8s-level readiness, recovering once with a full stop+start —
  // the same teardown that unsticks a wedged `k3d cluster start`.
  emit(`waiting for cluster nodes to be Ready`);
  if (!(await waitForNodesReady(name))) {
    emit(`cluster nodes not Ready — recovering ${name} with a full stop/start`);
    await runCommand(['k3d', 'cluster', 'stop', name]);
    await startExistingCluster(name);
    if (!(await waitForNodesReady(name))) {
      throw new Error(
        `cluster ${name} nodes did not become Ready after a stop/start recovery. ` +
          `Inspect \`kubectl --context ${kubeContextForCluster(name)} get nodes\` and ` +
          `\`docker logs k3d-${name}-server-0\`, or recreate with \`k3d cluster delete ${name}\`.`
      );
    }
  }
  return localClusterStatus({ clusterName: name });
}

/**
 * Stop the cluster without deleting its state. `startLocalCluster`
 * brings it back; `deleteLocalCluster` removes it entirely.
 */
export async function stopLocalCluster(opts: LocalClusterOptions = {}): Promise<LocalClusterStatus> {
  const name = clusterNameOrDefault(opts);
  const r = await runCommand(['k3d', 'cluster', 'stop', name]);
  if (!r.ok && !r.stderr.includes('not found')) {
    throw new Error(`k3d cluster stop failed: ${r.stderr.trim()}`);
  }
  return localClusterStatus({ clusterName: name });
}

/**
 * Permanently delete the named cluster and all of its in-cluster
 * state. Separate from stop so callers can offer a low-risk "stop"
 * alongside a confirm-gated "delete". Data under `dataDir` survives —
 * it lives on the host, bind-mounted in.
 */
export async function deleteLocalCluster(opts: LocalClusterOptions = {}): Promise<LocalClusterStatus> {
  const name = clusterNameOrDefault(opts);
  const r = await runCommand(['k3d', 'cluster', 'delete', name]);
  if (!r.ok && !r.stderr.includes('not found')) {
    throw new Error(`k3d cluster delete failed: ${r.stderr.trim()}`);
  }
  // Best-effort: tear down the matching registry. Our naming
  // convention is 1:1 with cluster name, so it's safe to remove here.
  // Ignored on "not found" so a re-delete is a no-op.
  await runCommand(['k3d', 'registry', 'delete', registryNameForCluster(name)]).catch(() => undefined);
  return { exists: false, running: false, clusterName: name };
}
