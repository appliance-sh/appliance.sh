import { z } from 'zod';
import { portInput } from '../common';

export const applianceBaseInput = z.object({
  manifest: z.literal('v1'),
  name: z.string(),
  version: z.string(),
  scripts: z.record(z.string(), z.string()),
});

export const applianceTypeContainerInput = applianceBaseInput.extend({
  type: z.literal('container'),
  port: portInput,
});

export const applianceTypeInput = applianceBaseInput.extend({
  type: z.literal('framework'),
  framework: z.string().optional().default('auto'),
  port: portInput.optional(),
  includes: z.array(z.string()).optional(),
  excludes: z.array(z.string()).optional(),
});

export const applianceTypeOtherInput = applianceBaseInput.extend({
  type: z.literal('other'),
});

export const applianceInput = z.discriminatedUnion('type', [applianceTypeContainerInput, applianceTypeOtherInput]);

export type ApplianceInput = z.infer<typeof applianceInput>;
export type Appliance = z.output<typeof applianceInput>;
