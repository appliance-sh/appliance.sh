import {
  Deployment,
  DeploymentInput,
  DeploymentStatus,
  DeploymentAction,
  EnvironmentStatus,
  generateId,
  signRequest,
  type SigningCredentials,
} from '@appliance.sh/sdk';
import { getStorageService } from './storage.service';
import { environmentService } from './environment.service';
import { projectService } from './project.service';
import { executeDeployment, type WorkerEvent } from './deployment-executor.service';
import { logger } from '../logger';

const COLLECTION = 'deployments';

// Client-side timeout for dispatching to the worker. We only need enough
// time for the request to reach the worker and start processing — we do
// NOT wait for the deployment to finish. The worker continues running
// even if we abort the connection.
const DISPATCH_TIMEOUT_MS = 5000;

export class EnvironmentBusyError extends Error {
  constructor(environmentId: string, status: EnvironmentStatus) {
    super(`Environment ${environmentId} is ${status}`);
    this.name = 'EnvironmentBusyError';
  }
}

export class DeploymentService {
  async execute(input: DeploymentInput, caller: SigningCredentials): Promise<Deployment> {
    const storage = getStorageService();

    const environment = await environmentService.get(input.environmentId);
    if (!environment) {
      throw new Error(`Environment not found: ${input.environmentId}`);
    }

    // Refuse to start a new deployment while a transition is in flight
    // for this environment — overlapping Pulumi runs on the same stack
    // would race on state. Only `Deploying` and `Destroying` are rejected:
    // `Pending` is the initial state (must allow the first deploy), and
    // terminal states (`Deployed`, `Destroyed`, `Failed`) are all safe to
    // start a new deployment from.
    if (environment.status === EnvironmentStatus.Deploying || environment.status === EnvironmentStatus.Destroying) {
      throw new EnvironmentBusyError(environment.id, environment.status);
    }

    const project = await projectService.get(environment.projectId);
    if (!project) {
      throw new Error(`Project not found: ${environment.projectId}`);
    }

    const now = new Date().toISOString();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { environment: _env, ...inputWithoutEnv } = input;
    const deployment: Deployment = {
      ...inputWithoutEnv,
      id: generateId('deployment'),
      projectId: environment.projectId,
      status: DeploymentStatus.Pending,
      startedAt: now,
    };

    await storage.set(COLLECTION, deployment.id, deployment);

    const envStatus =
      input.action === DeploymentAction.Deploy ? EnvironmentStatus.Deploying : EnvironmentStatus.Destroying;
    await environmentService.updateStatus(environment.id, envStatus);

    const workerEvent: WorkerEvent = {
      deploymentId: deployment.id,
      input,
      metadata: {
        projectId: project.id,
        projectName: project.name,
        environmentId: environment.id,
        environmentName: environment.name,
        deploymentId: deployment.id,
        stackName: environment.stackName,
      },
    };

    try {
      await this.dispatch(workerEvent, caller);
    } catch (error) {
      logger.error('failed to dispatch worker', error, { deploymentId: deployment.id });
      deployment.status = DeploymentStatus.Failed;
      deployment.completedAt = new Date().toISOString();
      deployment.message = `Failed to dispatch worker: ${error instanceof Error ? error.message : String(error)}`;
      await storage.set(COLLECTION, deployment.id, deployment);
      await environmentService.updateStatus(environment.id, EnvironmentStatus.Failed);
    }

    return deployment;
  }

  /**
   * Dispatches a job to a worker. If WORKER_URL is set, the job is sent
   * via HTTP to a separate worker container. Otherwise it runs inline
   * (useful for local dev and single-container deployments).
   *
   * The dispatch is re-signed with the ORIGINAL caller's API key. This
   * means the worker's /api/internal routes authenticate against the same
   * shared api-key store as the data plane — no separate worker secret
   * to leak, and the worker can attribute the job back to the real
   * caller for audit purposes.
   */
  private async dispatch(event: WorkerEvent, caller: SigningCredentials): Promise<void> {
    const workerUrl = process.env.WORKER_URL;
    if (!workerUrl) {
      // Inline execution — run in background, don't await.
      executeDeployment(event).catch((err) => {
        logger.error('inline deployment execution failed', err, { deploymentId: event.deploymentId });
      });
      return;
    }

    const url = `${workerUrl.replace(/\/$/, '')}/api/internal/jobs/deployment`;
    const body = JSON.stringify(event);
    const baseHeaders: Record<string, string> = { 'content-type': 'application/json' };

    const sigHeaders = await signRequest(caller, { method: 'POST', url, headers: baseHeaders, body });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { ...baseHeaders, ...sigHeaders },
        body,
        signal: controller.signal,
      });

      // If we got a response within the timeout window, surface any errors.
      if (!response.ok) {
        const responseBody = await response.text();
        throw new Error(`Worker returned ${response.status}: ${responseBody}`);
      }
    } catch (error) {
      // AbortError is expected — we only wait long enough for the request
      // to reach the worker. The worker continues running even if we
      // abort the client side of the connection.
      if (error instanceof Error && error.name === 'AbortError') {
        logger.info('worker dispatch aborted (expected, worker continues)', {
          deploymentId: event.deploymentId,
        });
        return;
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async get(id: string): Promise<Deployment | null> {
    const storage = getStorageService();
    return storage.get<Deployment>(COLLECTION, id);
  }

  async listByEnvironment(environmentId: string): Promise<Deployment[]> {
    const storage = getStorageService();
    return storage.filter<Deployment>(COLLECTION, (d) => d.environmentId === environmentId);
  }

  /**
   * List deployments sorted by `startedAt` descending (most recent
   * first). Optional filters narrow by environment or project.
   * `limit` is clamped to [1, 200] to keep any single S3 page
   * materialization bounded.
   */
  async list(options?: {
    limit?: number;
    offset?: number;
    environmentId?: string;
    projectId?: string;
  }): Promise<Deployment[]> {
    const storage = getStorageService();
    const all = await storage.getAll<Deployment>(COLLECTION);

    const filtered = all.filter((d) => {
      if (options?.environmentId && d.environmentId !== options.environmentId) return false;
      if (options?.projectId && d.projectId !== options.projectId) return false;
      return true;
    });

    filtered.sort((a, b) => {
      const at = new Date(a.startedAt).getTime();
      const bt = new Date(b.startedAt).getTime();
      return bt - at;
    });

    const offset = Math.max(0, options?.offset ?? 0);
    const limit = Math.min(Math.max(1, options?.limit ?? 50), 200);
    return filtered.slice(offset, offset + limit);
  }
}

export const deploymentService = new DeploymentService();
