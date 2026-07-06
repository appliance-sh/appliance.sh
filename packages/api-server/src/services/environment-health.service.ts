import {
  applianceBaseConfig,
  isDockerBase,
  isKubernetesBase,
  EnvironmentHealth,
  EnvironmentHealthStatus,
} from '@appliance.sh/sdk';
import { DockerDeploymentService, LocalContainerDeploymentService, type DeploymentHealth } from '@appliance.sh/infra';
import { environmentService } from './environment.service';
import { logger } from '../logger';

/**
 * Computes per-environment health for the console/SDK.
 *
 * Only Kubernetes-driven bases (local microVM + generic Kubernetes) carry
 * pod-level readiness/restart state, so health is sourced from the
 * same `@appliance.sh/infra` cluster client the deploy executor uses.
 * On AWS/Lambda bases — which have no pod/restart semantics — and when
 * the cluster is unreachable, health degrades to `unknown` with an
 * explanatory message rather than erroring, so the UI can render "no
 * data" instead of a failure.
 */
export class EnvironmentHealthService {
  /**
   * Returns the live health for an environment, or `null` when the
   * environment doesn't exist (the route maps that to a 404). Every
   * other failure path resolves to an `unknown`-status record so the
   * console always has something to render.
   */
  async getForEnvironment(environmentId: string): Promise<EnvironmentHealth | null> {
    const environment = await environmentService.get(environmentId);
    if (!environment) return null;

    const baseConfig = this.readBaseConfig();
    if (!baseConfig) {
      return this.unknown(environmentId, 'Cluster base config is unavailable on the api-server.');
    }

    // AWS/Lambda bases have no pod/restart state to read — surface
    // "unknown" rather than pretending. Kubernetes-driven and
    // plain-Docker bases both carry container health.
    if (!isKubernetesBase(baseConfig) && !isDockerBase(baseConfig)) {
      return this.unknown(
        environmentId,
        `Health metrics are only available for container-runtime bases (got '${baseConfig.type}').`
      );
    }

    try {
      const service = isDockerBase(baseConfig)
        ? new DockerDeploymentService(baseConfig)
        : new LocalContainerDeploymentService(baseConfig);
      const health = await service.getDeploymentHealth(environment.stackName);
      return this.fromDeploymentHealth(environmentId, health);
    } catch (error) {
      // Cluster unreachable / API error — don't fail the request, the
      // console treats unknown as "no data".
      logger.warn('environment health lookup failed', {
        environmentId,
        stackName: environment.stackName,
        error: String(error),
      });
      return this.unknown(environmentId, 'Unable to reach the cluster to read workload health.');
    }
  }

  private readBaseConfig() {
    const raw = process.env.APPLIANCE_BASE_CONFIG;
    if (!raw) return undefined;
    try {
      return applianceBaseConfig.parse(JSON.parse(raw));
    } catch (error) {
      logger.warn('failed to parse APPLIANCE_BASE_CONFIG for health lookup', { error: String(error) });
      return undefined;
    }
  }

  /**
   * Map the infra-layer DeploymentHealth onto the SDK model, deriving
   * the coarse health verdict:
   *   - no workload                       → not_deployed
   *   - all desired replicas Ready, no
   *     crash-looping                     → healthy
   *   - no Ready replicas, or a container
   *     in a crash/pull backoff           → unhealthy
   *   - otherwise (rolling out / partial) → degraded
   */
  private fromDeploymentHealth(environmentId: string, health: DeploymentHealth): EnvironmentHealth {
    if (!health.deployed) {
      return {
        environmentId,
        status: EnvironmentHealthStatus.NotDeployed,
        desiredReplicas: 0,
        readyReplicas: 0,
        restarts: 0,
        pods: [],
        message: 'No workload is currently deployed for this environment.',
      };
    }

    const { desiredReplicas, readyReplicas, restarts, pods, usage } = health;
    const backingOff = pods.some((p) => p.reason && /BackOff|CrashLoop|ImagePull|ErrImage/i.test(p.reason));

    let status: EnvironmentHealthStatus;
    if (readyReplicas >= desiredReplicas && desiredReplicas > 0 && !backingOff) {
      status = EnvironmentHealthStatus.Healthy;
    } else if (readyReplicas === 0 || backingOff) {
      status = EnvironmentHealthStatus.Unhealthy;
    } else {
      status = EnvironmentHealthStatus.Degraded;
    }

    return {
      environmentId,
      status,
      desiredReplicas,
      readyReplicas,
      restarts,
      pods,
      ...(usage ? { usage } : {}),
    };
  }

  private unknown(environmentId: string, message: string): EnvironmentHealth {
    return {
      environmentId,
      status: EnvironmentHealthStatus.Unknown,
      desiredReplicas: 0,
      readyReplicas: 0,
      restarts: 0,
      pods: [],
      message,
    };
  }
}

export const environmentHealthService = new EnvironmentHealthService();
