import { Deployment, DeploymentInput, DeploymentStatus, DeploymentAction, EnvironmentStatus } from '@appliance.sh/sdk';
import { createApplianceDeploymentService, type ApplianceStackMetadata } from '@appliance.sh/infra';
import { getStorageService } from './storage.service';
import { environmentService } from './environment.service';
import { buildService } from './build.service';
import { logger } from '../logger';

const COLLECTION = 'deployments';

export interface WorkerEvent {
  deploymentId: string;
  input: DeploymentInput;
  metadata: ApplianceStackMetadata;
}

/**
 * Execute a deployment job: resolve build, run Pulumi, update status.
 * Idempotent: skips work if the deployment is not in Pending state.
 */
export async function executeDeployment(event: WorkerEvent): Promise<void> {
  const { deploymentId, input, metadata } = event;
  const storage = getStorageService();

  const deployment = await storage.get<Deployment>(COLLECTION, deploymentId);
  if (!deployment) {
    throw new Error(`Deployment not found: ${deploymentId}`);
  }

  // Idempotency guard: only process pending deployments (handles retries)
  if (deployment.status !== DeploymentStatus.Pending) {
    logger.info('skipping non-pending deployment', { deploymentId, status: deployment.status });
    return;
  }

  deployment.status = DeploymentStatus.InProgress;
  await storage.set(COLLECTION, deployment.id, deployment);

  try {
    const infraService = createApplianceDeploymentService();

    let result;
    if (input.action === DeploymentAction.Deploy) {
      const build = input.buildId
        ? await buildService.resolve(input.buildId, `${metadata.stackName}-${deployment.id}`)
        : undefined;

      if (input.environment) {
        if (!build) {
          throw new Error('Environment variables require a build');
        }
        build.environment = { ...input.environment, ...build.environment };
      }

      result = await infraService.deploy(metadata.stackName, metadata, build);
    } else {
      result = await infraService.destroy(metadata.stackName, metadata.projectId);
    }

    deployment.status = DeploymentStatus.Succeeded;
    deployment.completedAt = new Date().toISOString();
    deployment.message = result.message;
    deployment.idempotentNoop = result.idempotentNoop;
    await storage.set(COLLECTION, deployment.id, deployment);

    const finalEnvStatus =
      input.action === DeploymentAction.Deploy ? EnvironmentStatus.Deployed : EnvironmentStatus.Destroyed;
    await environmentService.updateStatus(metadata.environmentId, finalEnvStatus);

    logger.info('deployment succeeded', { deploymentId, action: input.action });
  } catch (error) {
    deployment.status = DeploymentStatus.Failed;
    deployment.completedAt = new Date().toISOString();
    deployment.message = error instanceof Error ? error.message : String(error);
    await storage.set(COLLECTION, deployment.id, deployment);
    await environmentService.updateStatus(metadata.environmentId, EnvironmentStatus.Failed);

    logger.error('deployment failed', error, { deploymentId, action: input.action });
    throw error;
  }
}
