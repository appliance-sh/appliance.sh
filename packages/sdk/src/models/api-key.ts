import { z } from 'zod';

export const apiKeyInput = z.object({
  name: z.string(),
});

export type ApiKeyInput = z.infer<typeof apiKeyInput>;

export const apiKey = z.object({
  id: z.string(),
  name: z.string(),
  secretHash: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().optional(),
});

export type ApiKey = z.infer<typeof apiKey>;

export const apiKeyCreateResponse = z.object({
  id: z.string(),
  name: z.string(),
  secret: z.string(),
  createdAt: z.string(),
});

export type ApiKeyCreateResponse = z.infer<typeof apiKeyCreateResponse>;
