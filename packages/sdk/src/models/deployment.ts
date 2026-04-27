import { z } from 'zod';

export enum DeploymentAction {
  Deploy = 'deploy',
  Destroy = 'destroy',
  // Pulumi `refresh` — reconciles the stack's state file with live
  // cloud reality. Used to recover from drift, after a force-cancel,
  // or after manual cloud-side changes. Doesn't change topology.
  Refresh = 'refresh',
}

export enum DeploymentStatus {
  Pending = 'pending',
  InProgress = 'in_progress',
  // Cancellation requested. The worker observes this on its
  // periodic status poll and calls stack.cancel() on the Pulumi
  // operation. Transient — flips to Cancelled or Failed once the
  // worker acknowledges and reconciles state via refresh.
  Cancelling = 'cancelling',
  Succeeded = 'succeeded',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

export const deploymentInput = z.object({
  environmentId: z.string(),
  action: z.nativeEnum(DeploymentAction),
  buildId: z.string().optional(),
  environment: z.record(z.string(), z.string()).optional(),
});

export type DeploymentInput = z.infer<typeof deploymentInput>;

export const deployment = z.object({
  environmentId: z.string(),
  action: z.nativeEnum(DeploymentAction),
  buildId: z.string().optional(),
  id: z.string(),
  projectId: z.string(),
  status: z.nativeEnum(DeploymentStatus),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  message: z.string().optional(),
  idempotentNoop: z.boolean().optional(),
});

export type Deployment = z.infer<typeof deployment>;
