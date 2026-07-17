import { createHash, randomBytes } from 'crypto';
import { getStorageService } from './storage.service';
import { apiKeyService } from './api-key.service';
import { ApiKeyCreateResponse, ApiKeyRole, InviteCreateResponse, InviteSummary, generateId } from '@appliance.sh/sdk';

const COLLECTION = 'invites';

const DEFAULT_TTL_HOURS = 24 * 7;

// Only the token's hash is stored: the invite list is readable by every
// admin, and a redeemable token is a full credential-in-waiting. Hashing
// means a leaked store (or log line) can't be redeemed.
interface StoredInvite {
  id: string;
  tokenHash: string;
  name: string;
  role: ApiKeyRole;
  createdAt: string;
  expiresAt: string;
  redeemedAt?: string;
  redeemedKeyId?: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toSummary(invite: StoredInvite): InviteSummary {
  return {
    id: invite.id,
    name: invite.name,
    role: invite.role,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    ...(invite.redeemedAt ? { redeemedAt: invite.redeemedAt } : {}),
  };
}

export type RedeemResult =
  | { ok: true; key: ApiKeyCreateResponse }
  | { ok: false; reason: 'not-found' | 'expired' | 'redeemed' };

export class InviteService {
  async create(input: { name: string; role?: ApiKeyRole; expiresInHours?: number }): Promise<InviteCreateResponse> {
    const storage = getStorageService();
    const id = generateId('invite');
    const token = `inv_${randomBytes(32).toString('hex')}`;
    const now = new Date();
    const ttlHours = input.expiresInHours ?? DEFAULT_TTL_HOURS;
    const expiresAt = new Date(now.getTime() + ttlHours * 3600_000).toISOString();
    const role = input.role ?? 'member';

    const stored: StoredInvite = {
      id,
      tokenHash: hashToken(token),
      name: input.name,
      role,
      createdAt: now.toISOString(),
      expiresAt,
    };

    await storage.set(COLLECTION, id, stored);

    return { id, token, name: input.name, role, createdAt: stored.createdAt, expiresAt };
  }

  async list(): Promise<InviteSummary[]> {
    const storage = getStorageService();
    const invites = await storage.getAll<StoredInvite>(COLLECTION);
    return invites.map(toSummary).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Revoke (delete) an invite. Idempotent. */
  async delete(id: string): Promise<void> {
    const storage = getStorageService();
    await storage.delete(COLLECTION, id);
  }

  /**
   * Redeem a token: single-use, expiring. On success mints an API key
   * carrying the invite's name + role and marks the invite redeemed
   * (kept, not deleted, so admins can see who joined and when).
   *
   * Mark-redeemed-then-mint ordering is deliberate: a crash between the
   * two steps burns the invite without minting a key (the admin just
   * sends a new invite), whereas the reverse could hand out two keys
   * for one token under a concurrent double-submit.
   */
  async redeem(token: string): Promise<RedeemResult> {
    const storage = getStorageService();
    const tokenHash = hashToken(token);
    const matches = await storage.filter<StoredInvite>(COLLECTION, (i) => i.tokenHash === tokenHash);
    const invite = matches[0];

    if (!invite) return { ok: false, reason: 'not-found' };
    if (invite.redeemedAt) return { ok: false, reason: 'redeemed' };
    if (new Date(invite.expiresAt).getTime() < Date.now()) return { ok: false, reason: 'expired' };

    await storage.set(COLLECTION, invite.id, {
      ...invite,
      redeemedAt: new Date().toISOString(),
    });

    const key = await apiKeyService.create(invite.name, invite.role);

    await storage.set(COLLECTION, invite.id, {
      ...invite,
      redeemedAt: new Date().toISOString(),
      redeemedKeyId: key.id,
    });

    return { ok: true, key };
  }
}

export const inviteService = new InviteService();
