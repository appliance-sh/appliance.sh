import { z } from 'zod';

export const applianceInput = z.object({
  name: z.string(),
});

export type ApplianceInput = z.infer<typeof applianceInput>;
