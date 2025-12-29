import { z } from 'zod';
import { portInput } from '../common';

export enum ApplianceType {
  container = 'container',
  framework = 'framework',
  other = 'other',
}

export enum ApplianceFramework {
  Auto = 'auto',
  Python = 'python',
  Node = 'node',
  Other = 'other',
}

export const applianceTypeSchema = z.enum(ApplianceType);

export const applianceTypeBase = z.object({
  manifest: z.literal('v1'),
  name: z.string(),
  version: z.string().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
});

export const applianceTypeContainerInput = applianceTypeBase.extend({
  type: z.literal(applianceTypeSchema.enum.container),
  port: portInput,
});

export const applianceTypeFrameworkInput = applianceTypeBase.extend({
  type: z.literal(applianceTypeSchema.enum.framework),
  framework: z.string().optional().default('auto'),
  port: portInput.optional(),
  includes: z.array(z.string()).optional(),
  excludes: z.array(z.string()).optional(),
});

export const applianceTypeOtherInput = applianceTypeBase.extend({
  type: z.literal(applianceTypeSchema.enum.other),
});

export const applianceInput = z.discriminatedUnion('type', [
  applianceTypeContainerInput,
  applianceTypeFrameworkInput,
  applianceTypeOtherInput,
]);

export type ApplianceInput = z.infer<typeof applianceInput>;
export type Appliance = z.output<typeof applianceInput>;
