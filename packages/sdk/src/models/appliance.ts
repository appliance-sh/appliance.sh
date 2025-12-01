import { z } from 'zod';

export const applianceBaseInput = z.object({
  name: z.string(),
});

export const applianceV1Input = applianceBaseInput.extend({
  applianceVersion: z.literal('1'),
});

export const applianceInput = z.discriminatedUnion('applianceVersion', [applianceV1Input]);

export type ApplianceInput = z.infer<typeof applianceInput>;
export type Appliance = z.output<typeof applianceInput>;
