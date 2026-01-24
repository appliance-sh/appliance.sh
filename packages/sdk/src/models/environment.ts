import { z } from 'zod';
import { applianceBaseConfig } from './appliance-base';

export enum EnvironmentStatus {
  Pending = 'pending',
  Deploying = 'deploying',
  Deployed = 'deployed',
  Destroying = 'destroying',
  Destroyed = 'destroyed',
  Failed = 'failed',
}

export const environmentInput = z.object({
  name: z.string(),
  projectId: z.string(),
  baseConfig: applianceBaseConfig,
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
