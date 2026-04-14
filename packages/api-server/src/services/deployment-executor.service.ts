import {
  Deployment,
  DeploymentStatus,
  DeploymentAction,
  EnvironmentStatus,
  deploymentInput,
  z,
} from '@appliance.sh/sdk';
import { createApplianceDeploymentService, type ApplianceStackMetadata } from '@appliance.sh/infra';
import { getStorageService } from './storage.service';
import { environmentService } from './environment.service';
import { buildService } from './build.service';
import { logger } from '../logger';

const COLLECTION = 'deployments';

// Annotated with z.ZodType<ApplianceStackMetadata> so the compiler flags
// drift if the infra-side interface changes shape.
const applianceStackMetadataSchema: z.ZodType<ApplianceStackMetadata> = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  environmentId: z.string().min(1),
  environmentName: z.string().min(1),
  deploymentId: z.string().min(1),
  stackName: z.string().min(1),
});

export const workerEventSchema = z.object({
  deploymentId: z.string().min(1),
  input: deploymentInput,
  metadata: applianceStackMetadataSchema,
});

export type WorkerEvent = z.infer<typeof workerEventSchema>;

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
    switch (input.action) {
      case DeploymentAction.Deploy: {
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
        break;
      }
      case DeploymentAction.Destroy: {
        result = await infraService.destroy(metadata.stackName, metadata.projectId);
        break;
      }
      default: {
        // Exhaustiveness check — unreachable if DeploymentAction is exhaustive.
        const _exhaustive: never = input.action;
        throw new Error(`Unknown deployment action: ${String(_exhaustive)}`);
      }
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
