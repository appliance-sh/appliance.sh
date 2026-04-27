import { z } from 'zod';
import { dnsName } from '../common';

export enum EnvironmentStatus {
  Pending = 'pending',
  Deploying = 'deploying',
  Deployed = 'deployed',
  Destroying = 'destroying',
  Destroyed = 'destroyed',
  // Transient: Pulumi `refresh` is reconciling state with reality.
  // Settles back to whatever the environment's prior status was on
  // success, or Failed on error.
  Refreshing = 'refreshing',
  Failed = 'failed',
}

export const environmentInput = z.object({
  name: dnsName,
  projectId: z.string(),
});

export type EnvironmentInput = z.infer<typeof environmentInput>;

export const environment = environmentInput.extend({
  id: z.string(),
  status: z.nativeEnum(EnvironmentStatus),
  stackName: z.string(),
  lastDeployedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Environment = z.infer<typeof environment>;
