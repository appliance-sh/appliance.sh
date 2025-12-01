import { z } from 'zod';

export const applianceBaseInput = z.object({
  manifest: z.literal('v1'),
  name: z.string(),
  version: z.string(),
  scripts: z.record(z.string(), z.string()),
});

export const applianceTypeContainerInput = applianceBaseInput.extend({
  type: z.literal('container'),
});

export const applianceTypeOtherInput = applianceBaseInput.extend({
  type: z.literal('other'),
});

export const applianceInput = z.discriminatedUnion('type', [applianceTypeContainerInput, applianceTypeOtherInput]);

export type ApplianceInput = z.infer<typeof applianceInput>;
export type Appliance = z.output<typeof applianceInput>;
