import { z } from 'zod';

/**
 * A point-in-time view of the cluster workloads backing an appliance:
 * the Deployments, Pods, and Services in a namespace. This is the same
 * shape the desktop console already renders for its local-runtime
 * workloads page (the Rust `LocalWorkloads` struct / the `host.ts`
 * `LocalWorkloads` interface), lifted into the SDK so the console can
 * read it through the api-server instead of shelling out to `kubectl`.
 *
 * Field names mirror the desktop interface verbatim (`serviceType`,
 * `clusterIp`, `restartCount`, `containerImage`) so migrating the
 * console to `client.listWorkloads()` is a drop-in with no UI type
 * changes (control-plane.md §2/§3).
 */

/**
 * One Deployment's rollout summary — the `kubectl get deploy` columns
 * (`READY`/`UP-TO-DATE`/`AVAILABLE`) the console surfaces.
 */
export const workloadDeployment = z.object({
  name: z.string(),
  /** First container image of the pod template, when present. */
  image: z.string().optional(),
  /** Desired replica count from the Deployment spec. */
  desired: z.number().int().nonnegative(),
  /** Replicas currently reporting Ready. */
  ready: z.number().int().nonnegative(),
  /** Replicas currently Available. */
  available: z.number().int().nonnegative(),
  /** Creation timestamp (RFC3339), when the api reports one. */
  createdAt: z.string().optional(),
});

export type WorkloadDeployment = z.infer<typeof workloadDeployment>;

/**
 * One Pod's readiness/restart summary — the `kubectl get pods`
 * `STATUS`/`READY`/`RESTARTS` columns.
 */
export const workloadPod = z.object({
  name: z.string(),
  /** Pod phase as reported by the kubelet (Running, Pending, etc.). */
  phase: z.string(),
  /** True when every container in the pod reports Ready. */
  ready: z.boolean(),
  /** Sum of container restart counts across the pod. */
  restartCount: z.number().int().nonnegative(),
  /** First container image, when present. */
  containerImage: z.string().optional(),
  /** Creation timestamp (RFC3339), when the api reports one. */
  createdAt: z.string().optional(),
});

export type WorkloadPod = z.infer<typeof workloadPod>;

/**
 * One Service's addressing summary — the `kubectl get svc`
 * `TYPE`/`CLUSTER-IP`/`PORT(S)` columns (first port only).
 */
export const workloadService = z.object({
  name: z.string(),
  /** Service type (ClusterIP, NodePort, LoadBalancer, ...). */
  serviceType: z.string(),
  /** Allocated cluster IP, when assigned. */
  clusterIp: z.string().optional(),
  /** Host-published NodePort of the first port, when the Service is a
   *  NodePort/LoadBalancer. */
  nodePort: z.number().int().optional(),
  /** Target container port of the first port, when numeric. */
  targetPort: z.number().int().optional(),
});

export type WorkloadService = z.infer<typeof workloadService>;

/**
 * The deployments/pods/services triple for a namespace (or, when
 * filtered by the `app.kubernetes.io/name` selector, for a single
 * environment's stack).
 */
export const workloads = z.object({
  deployments: z.array(workloadDeployment),
  pods: z.array(workloadPod),
  services: z.array(workloadService),
});

export type Workloads = z.infer<typeof workloads>;
