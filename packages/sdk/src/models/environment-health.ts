import { z } from 'zod';

/**
 * Coarse readiness verdict for an environment's workload. Derived
 * from the live Deployment + Pod state on Kubernetes bases:
 *   - `healthy`     — all desired replicas Ready, no crash-looping.
 *   - `degraded`    — running but not fully Ready (rolling out, a
 *                     replica restarting / not yet Ready, etc.).
 *   - `unhealthy`   — no Ready replicas, or a container is in a
 *                     crash/image-pull backoff.
 *   - `not_deployed`— no workload found for this environment's stack
 *                     (never deployed, or destroyed).
 *   - `unknown`     — health can't be determined: the base isn't
 *                     Kubernetes-driven (e.g. AWS/Lambda, which has no
 *                     pod/restart semantics), or the cluster was
 *                     unreachable. Consumers should treat this as
 *                     "no data" rather than a problem.
 */
export enum EnvironmentHealthStatus {
  Healthy = 'healthy',
  Degraded = 'degraded',
  Unhealthy = 'unhealthy',
  NotDeployed = 'not_deployed',
  Unknown = 'unknown',
}

/**
 * Per-pod readiness + restart snapshot. Mirrors the
 * `kubectl get pods` READY / RESTARTS columns so the console can
 * surface the same at-a-glance signal without shelling out to
 * kubectl. `reason` carries the waiting-state reason of the first
 * not-ready container (e.g. `CrashLoopBackOff`, `ImagePullBackOff`)
 * when one is present.
 */
export const podHealth = z.object({
  name: z.string(),
  /** Pod phase as reported by the kubelet (Running, Pending, etc.). */
  phase: z.string(),
  /** True when every container in the pod reports Ready. */
  ready: z.boolean(),
  /** Sum of container restart counts across the pod. */
  restarts: z.number().int().nonnegative(),
  /** Waiting-state reason of the first not-ready container, if any. */
  reason: z.string().optional(),
});

export type PodHealth = z.infer<typeof podHealth>;

/**
 * Point-in-time CPU/memory usage for an environment's workload,
 * summed across its pods. Sourced from the Kubernetes metrics-server
 * (`metrics.k8s.io`). Absent (the whole object is omitted) when
 * metrics-server isn't installed or hasn't produced a sample yet —
 * health must degrade gracefully without it.
 */
export const resourceUsage = z.object({
  /** Aggregate CPU usage in millicores (1000m = 1 core). */
  cpuMillicores: z.number().nonnegative(),
  /** Aggregate working-set memory in bytes. */
  memoryBytes: z.number().nonnegative(),
});

export type ResourceUsage = z.infer<typeof resourceUsage>;

export const environmentHealth = z.object({
  environmentId: z.string(),
  status: z.nativeEnum(EnvironmentHealthStatus),
  /** Desired replica count from the Deployment spec. */
  desiredReplicas: z.number().int().nonnegative(),
  /** Replicas currently reporting Ready. */
  readyReplicas: z.number().int().nonnegative(),
  /** Restarts summed across all of the workload's pods. */
  restarts: z.number().int().nonnegative(),
  /** Per-pod readiness/restart detail. Empty when not deployed. */
  pods: z.array(podHealth),
  /** CPU/mem usage when metrics-server is present; omitted otherwise. */
  usage: resourceUsage.optional(),
  /**
   * Human-readable note. Set when status is `unknown` / `not_deployed`
   * to explain why (non-Kubernetes base, cluster unreachable, never
   * deployed) so the console can show context instead of a bare dash.
   */
  message: z.string().optional(),
});

export type EnvironmentHealth = z.infer<typeof environmentHealth>;
