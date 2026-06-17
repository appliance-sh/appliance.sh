// Pure parsing of `kubectl get pods -o json` into a compact
// readiness/restart summary. Kept separate from the command wiring so
// it's unit-testable without a live cluster.

/** The slice of a `kubectl get pods -o json` item we care about. */
export interface RawPod {
  metadata?: { name?: string };
  status?: {
    phase?: string;
    containerStatuses?: Array<{
      name?: string;
      ready?: boolean;
      restartCount?: number;
      state?: Record<string, { reason?: string; message?: string } | undefined>;
    }>;
  };
}

export interface ContainerHealth {
  name: string;
  ready: boolean;
  restarts: number;
  /** Waiting/terminated reason (e.g. CrashLoopBackOff, OOMKilled), when
   *  the container isn't cleanly Running. */
  reason?: string;
}

export interface PodHealth {
  name: string;
  phase: string;
  /** Containers ready / total, e.g. "1/1". */
  readyRatio: string;
  ready: boolean;
  restarts: number;
  containers: ContainerHealth[];
}

export interface DeploymentHealth {
  pods: PodHealth[];
  /** Total pods. */
  total: number;
  /** Pods with every container ready. */
  ready: number;
  /** Sum of container restarts across all pods. */
  restarts: number;
  /** True when at least one pod exists and all are fully ready. */
  healthy: boolean;
}

/** Pull the non-running state reason off a container status, if any. */
function containerReason(
  state: Record<string, { reason?: string; message?: string } | undefined> | undefined
): string | undefined {
  if (!state) return undefined;
  // A container is in exactly one of waiting/terminated/running. We
  // surface the reason of the first non-running state we find.
  for (const key of ['waiting', 'terminated'] as const) {
    const s = state[key];
    if (s?.reason) return s.reason;
  }
  return undefined;
}

/** Parse a single pod item into a compact health record. */
export function parsePodHealth(pod: RawPod): PodHealth {
  const name = pod.metadata?.name ?? '<unknown>';
  const phase = pod.status?.phase ?? 'Unknown';
  const statuses = pod.status?.containerStatuses ?? [];
  const containers: ContainerHealth[] = statuses.map((c) => ({
    name: c.name ?? 'container',
    ready: Boolean(c.ready),
    restarts: c.restartCount ?? 0,
    reason: containerReason(c.state),
  }));
  const readyCount = containers.filter((c) => c.ready).length;
  const restarts = containers.reduce((sum, c) => sum + c.restarts, 0);
  return {
    name,
    phase,
    readyRatio: `${readyCount}/${containers.length}`,
    ready: containers.length > 0 && readyCount === containers.length,
    restarts,
    containers,
  };
}

/** Summarize a `kubectl get pods -o json` payload for one deployment. */
export function summarizeDeploymentHealth(items: RawPod[]): DeploymentHealth {
  const pods = items.map(parsePodHealth);
  const ready = pods.filter((p) => p.ready).length;
  const restarts = pods.reduce((sum, p) => sum + p.restarts, 0);
  return {
    pods,
    total: pods.length,
    ready,
    restarts,
    healthy: pods.length > 0 && ready === pods.length,
  };
}
