import { z } from 'zod';

export const deployment = z.object({
  name: z.string(),
  projectId: z.string(),
  deploymentId: z.string(),
});
