import { z } from 'zod';
import { apiKeyRole } from './api-key';

/**
 * Invites let an admin onboard a teammate without hand-delivering a
 * secret: the admin mints an invite, sends the resulting link, and the
 * console redeems it for a fresh API key on the teammate's first visit.
 * Tokens are single-use and expire; the server stores only a hash, so a
 * leaked invite list cannot be redeemed.
 */
export const inviteInput = z.object({
  /** Who this invite is for — becomes the minted key's name. */
  name: z.string().min(1),
  /** Role of the key minted on redemption. Defaults to `member`. */
  role: apiKeyRole.optional(),
  /** Hours until the invite stops being redeemable. Default 168 (7 days). */
  expiresInHours: z
    .number()
    .int()
    .positive()
    .max(24 * 90)
    .optional(),
});

export type InviteInput = z.infer<typeof inviteInput>;

/** An invite as listed to admins — never carries the token. */
export const inviteSummary = z.object({
  id: z.string(),
  name: z.string(),
  role: apiKeyRole,
  createdAt: z.string(),
  expiresAt: z.string(),
  redeemedAt: z.string().optional(),
});

export type InviteSummary = z.infer<typeof inviteSummary>;

/** Returned once, at creation — the only time the token is visible. */
export const inviteCreateResponse = inviteSummary.extend({
  token: z.string(),
});

export type InviteCreateResponse = z.infer<typeof inviteCreateResponse>;

export const inviteRedeemInput = z.object({
  token: z.string().min(1),
});

export type InviteRedeemInput = z.infer<typeof inviteRedeemInput>;
