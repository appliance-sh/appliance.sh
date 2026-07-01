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
  /**
   * Owning principal (tenant) this key is bound to. Server-derived and
   * stamped at mint time from the authenticated principal — NEVER
   * client-asserted. Optional + additive: a legacy key minted before the
   * tenant dimension has no value and resolves to the default tenant.
   */
  tenantId: z.string().optional(),
});

export type ApiKey = z.infer<typeof apiKey>;

export const apiKeyCreateResponse = z.object({
  id: z.string(),
  name: z.string(),
  secret: z.string(),
  createdAt: z.string(),
});

export type ApiKeyCreateResponse = z.infer<typeof apiKeyCreateResponse>;
