import { z } from 'zod';

export enum DeploymentAction {
  Deploy = 'deploy',
  Destroy = 'destroy',
}

export enum DeploymentStatus {
  Pending = 'pending',
  InProgress = 'in_progress',
  Succeeded = 'succeeded',
  Failed = 'failed',
}

export const deploymentInput = z.object({
  environmentId: z.string(),
  action: z.nativeEnum(DeploymentAction),
});

export type DeploymentInput = z.infer<typeof deploymentInput>;

export const deployment = deploymentInput.extend({
  id: z.string(),
  projectId: z.string(),
  status: z.nativeEnum(DeploymentStatus),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  message: z.string().optional(),
  idempotentNoop: z.boolean().optional(),
});

export type Deployment = z.infer<typeof deployment>;
