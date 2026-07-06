import { randomBytes } from 'crypto';
import { getStorageService } from './storage.service';
import { ApiKeyCreateResponse, ApiKeyRole, ApiKeySummary, generateId } from '@appliance.sh/sdk';

const COLLECTION = 'api-keys';

// The shared secret must be stored to verify HMAC signatures (RFC 9421).
// Unlike password hashing, HMAC requires the original key on both sides.
interface StoredApiKey {
  id: string;
  name: string;
  secret: string;
  createdAt: string;
  lastUsedAt?: string;
  // Absent on keys stored before roles existed — read as 'admin', since
  // every pre-role key was full-access.
  role?: ApiKeyRole;
}

/** Pre-role keys were all full-access, so absence reads as admin. */
export function roleOf(key: { role?: ApiKeyRole }): ApiKeyRole {
  return key.role ?? 'admin';
}

export class ApiKeyService {
  async create(name: string, role: ApiKeyRole = 'admin'): Promise<ApiKeyCreateResponse> {
    const storage = getStorageService();
    const id = generateId('apikey');
    const secret = `sk_${randomBytes(32).toString('hex')}`;
    const now = new Date().toISOString();

    const stored: StoredApiKey = {
      id,
      name,
      secret,
      createdAt: now,
      role,
    };

    await storage.set(COLLECTION, id, stored);

    return { id, name, secret, createdAt: now, role };
  }

  /** All keys, secrets stripped — safe to return to admins. */
  async list(): Promise<ApiKeySummary[]> {
    const storage = getStorageService();
    const keys = await storage.getAll<StoredApiKey>(COLLECTION);
    return keys
      .map((k) => ({
        id: k.id,
        name: k.name,
        role: roleOf(k),
        createdAt: k.createdAt,
        ...(k.lastUsedAt ? { lastUsedAt: k.lastUsedAt } : {}),
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getByKeyId(keyId: string): Promise<StoredApiKey | null> {
    const storage = getStorageService();
    return storage.get<StoredApiKey>(COLLECTION, keyId);
  }

  async exists(): Promise<boolean> {
    const storage = getStorageService();
    const keys = await storage.getAll<StoredApiKey>(COLLECTION);
    return keys.length > 0;
  }

  async updateLastUsed(keyId: string): Promise<void> {
    const storage = getStorageService();
    const existing = await storage.get<StoredApiKey>(COLLECTION, keyId);
    if (existing) {
      await storage.set(COLLECTION, keyId, {
        ...existing,
        lastUsedAt: new Date().toISOString(),
      });
    }
  }

  /** Permanently delete a key. Idempotent — no-op if the id is unknown. */
  async delete(keyId: string): Promise<void> {
    const storage = getStorageService();
    await storage.delete(COLLECTION, keyId);
  }

  /**
   * Rotate a key: mint a fresh id+secret (inheriting the old key's
   * name) and revoke the previous one, so a leaked secret stops
   * working the moment the new credential is in hand.
   *
   * Mint-then-revoke ordering is deliberate: the new key exists and is
   * returned to the caller before the old one is removed, so a crash
   * mid-rotation can at worst leave both keys valid (recoverable by
   * re-running rotate) rather than locking the operator out with
   * neither key valid.
   *
   * Returns null when `keyId` doesn't resolve to a stored key.
   */
  async rotate(keyId: string): Promise<ApiKeyCreateResponse | null> {
    const existing = await this.getByKeyId(keyId);
    if (!existing) return null;
    const replacement = await this.create(existing.name, roleOf(existing));
    // Revoke last: the replacement is already persisted and returned.
    await this.delete(keyId);
    return replacement;
  }
}

export const apiKeyService = new ApiKeyService();
