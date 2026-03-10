import {
  Deployment,
  DeploymentInput,
  DeploymentStatus,
  DeploymentAction,
  EnvironmentStatus,
  generateId,
} from '@appliance.sh/sdk';
import { createApplianceDeploymentService } from '@appliance.sh/infra';
import { getStorageService } from './storage.service';
import { environmentService } from './environment.service';
import { projectService } from './project.service';
import { buildService } from './build.service';

const COLLECTION = 'deployments';

export class DeploymentService {
  async execute(input: DeploymentInput): Promise<Deployment> {
    const storage = getStorageService();

    const environment = await environmentService.get(input.environmentId);
    if (!environment) {
      throw new Error(`Environment not found: ${input.environmentId}`);
    }

    const now = new Date().toISOString();
    const deployment: Deployment = {
      ...input,
      id: generateId('dep'),
      projectId: environment.projectId,
      status: DeploymentStatus.Pending,
      startedAt: now,
    };

    await storage.set(COLLECTION, deployment.id, deployment);

    // Update deployment to in_progress
    deployment.status = DeploymentStatus.InProgress;
    await storage.set(COLLECTION, deployment.id, deployment);

    // Update environment status
    const envStatus =
      input.action === DeploymentAction.Deploy ? EnvironmentStatus.Deploying : EnvironmentStatus.Destroying;
    await environmentService.updateStatus(environment.id, envStatus);

    // Look up the project for tagging
    const project = await projectService.get(environment.projectId);
    if (!project) {
      throw new Error(`Project not found: ${environment.projectId}`);
    }

    const metadata = {
      projectId: project.id,
      projectName: project.name,
      environmentId: environment.id,
      environmentName: environment.name,
      deploymentId: deployment.id,
      stackName: environment.stackName,
    };

    // Execute the deployment
    try {
      const infraService = createApplianceDeploymentService();

      let result;
      if (input.action === DeploymentAction.Deploy) {
        // Resolve the build into cloud-specific params if present
        const build = input.buildId
          ? await buildService.resolve(input.buildId, `${environment.stackName}-${deployment.id}`)
          : undefined;

        result = await infraService.deploy(environment.stackName, metadata, build);
      } else {
        result = await infraService.destroy(environment.stackName);
      }

      deployment.status = DeploymentStatus.Succeeded;
      deployment.completedAt = new Date().toISOString();
      deployment.message = result.message;
      deployment.idempotentNoop = result.idempotentNoop;
      await storage.set(COLLECTION, deployment.id, deployment);

      // Update environment status
      const finalEnvStatus =
        input.action === DeploymentAction.Deploy ? EnvironmentStatus.Deployed : EnvironmentStatus.Destroyed;
      await environmentService.updateStatus(environment.id, finalEnvStatus);
    } catch (error) {
      deployment.status = DeploymentStatus.Failed;
      deployment.completedAt = new Date().toISOString();
      deployment.message = error instanceof Error ? error.message : String(error);
      await storage.set(COLLECTION, deployment.id, deployment);

      await environmentService.updateStatus(environment.id, EnvironmentStatus.Failed);
    }

    return deployment;
  }

  async get(id: string): Promise<Deployment | null> {
    const storage = getStorageService();
    return storage.get<Deployment>(COLLECTION, id);
  }

  async listByEnvironment(environmentId: string): Promise<Deployment[]> {
    const storage = getStorageService();
    return storage.filter<Deployment>(COLLECTION, (d) => d.environmentId === environmentId);
  }
}

export const deploymentService = new DeploymentService();
