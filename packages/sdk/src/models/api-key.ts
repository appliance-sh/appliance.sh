import { z } from 'zod';

/**
 * Coarse role attached to every API key.
 *   - `admin`: full access — data plane plus key/invite management and
 *     cluster lifecycle. Bootstrap-minted operator keys are admins.
 *   - `member`: data plane only (projects, environments, deployments).
 *     Keys minted by redeeming an invite default to member, so a
 *     teammate's stolen key cannot enumerate or revoke other keys.
 * Keys stored before roles existed are treated as `admin`.
 */
export const apiKeyRole = z.enum(['admin', 'member']);

export type ApiKeyRole = z.infer<typeof apiKeyRole>;

export const apiKeyInput = z.object({
  name: z.string(),
  role: apiKeyRole.optional(),
});

export type ApiKeyInput = z.infer<typeof apiKeyInput>;

/** A key as listed to admins — never carries the secret. */
export const apiKeySummary = z.object({
  id: z.string(),
  name: z.string(),
  role: apiKeyRole,
  createdAt: z.string(),
  lastUsedAt: z.string().optional(),
});

export type ApiKeySummary = z.infer<typeof apiKeySummary>;

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
  role: apiKeyRole.optional(),
});

export type ApiKeyCreateResponse = z.infer<typeof apiKeyCreateResponse>;
