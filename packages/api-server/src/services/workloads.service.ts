import type { Workloads } from '@appliance.sh/sdk';
import type { ContainerDeploymentBackend } from '@appliance.sh/infra';
import { Writable } from 'node:stream';
import { environmentService } from './environment.service';
import { readBaseConfig, resolveContainerBackend, RemovedDockerBaseError } from './deployment-backend';

/**
 * Raised when a workloads/pod-logs read is attempted on a base that
 * has no container runtime to read from (AWS/Lambda), or when the
 * api-server has no base config at all. Routes map this to a 409 with
 * the message, mirroring `environment-health.service`'s base gate
 * (control-plane.md §2) — the difference being these endpoints have no
 * meaningful "unknown" fallback, so they refuse rather than degrade.
 */
export class NonKubernetesBaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonKubernetesBaseError';
  }
}

/**
 * Reads runtime workloads + container logs for the console/SDK. Only
 * container-runtime bases — Kubernetes-driven (local microVM +
 * generic Kubernetes) and plain-Docker (the local daemon) — carry
 * workload state, so every method gates on the base type and
 * instantiates the same `@appliance.sh/infra` runtime client the
 * deploy executor + health service use.
 */
export class WorkloadsService {
  /**
   * Resolve the container backend for this base via the single fork
   * point (deployment-backend.ts), requiring a container-runtime base.
   * Throws NonKubernetesBaseError otherwise so the route can answer
   * 409 before touching the response.
   */
  private cluster(): ContainerDeploymentBackend {
    const baseConfig = readBaseConfig();
    if (!baseConfig) {
      throw new NonKubernetesBaseError('Cluster base config is unavailable on the api-server.');
    }
    let backend: ContainerDeploymentBackend | null;
    try {
      backend = resolveContainerBackend(baseConfig);
    } catch (error) {
      if (error instanceof RemovedDockerBaseError) throw new NonKubernetesBaseError(error.message);
      throw error;
    }
    if (!backend) {
      throw new NonKubernetesBaseError(
        `Workloads and pod logs are only available for container-runtime bases (got '${baseConfig.type}').`
      );
    }
    return backend;
  }

  /**
   * Throw NonKubernetesBaseError unless this api-server is on a
   * container-runtime base. Lets a streaming route reject (→ 409)
   * before it sets any response headers, so the 409 body is still JSON.
   */
  ensureKubernetesBase(): void {
    this.cluster();
  }

  /** Namespace-scoped workloads. Undefined namespace → the infra client
   *  defaults to the base's configured namespace (`appliance`). */
  async listWorkloads(namespace?: string): Promise<Workloads> {
    return this.cluster().listWorkloads({ namespace });
  }

  /**
   * Workloads for one environment, filtered to its stack via the
   * `app.kubernetes.io/name=<stackName>` label the deploy path stamps
   * on every resource. Returns null when the environment doesn't exist
   * (the route maps that to 404).
   */
  async listEnvironmentWorkloads(environmentId: string): Promise<Workloads | null> {
    // Gate on the runtime base BEFORE the env lookup so a cloud base
    // answers 409 ("not available on this base") rather than a 404
    // for an environment it could never read workloads for anyway.
    this.ensureKubernetesBase();
    const environment = await environmentService.get(environmentId);
    if (!environment) return null;
    return this.cluster().listWorkloads({ labelSelector: `app.kubernetes.io/name=${environment.stackName}` });
  }

  /** Snapshot pod logs (text tail). */
  async getPodLogs(
    podName: string,
    opts: { container?: string; tailLines?: number; namespace?: string; sinceSeconds?: number }
  ): Promise<string> {
    return this.cluster().getPodLogs(podName, opts);
  }

  /** Follow pod logs, piping the watch stream into `destination`.
   *  Returns the AbortController the route aborts on client disconnect. */
  async streamPodLogs(
    podName: string,
    destination: Writable,
    opts: { container?: string; tailLines?: number; namespace?: string; sinceSeconds?: number }
  ): Promise<AbortController> {
    return this.cluster().streamPodLogs(podName, destination, opts);
  }
}

export const workloadsService = new WorkloadsService();
