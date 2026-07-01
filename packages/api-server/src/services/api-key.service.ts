import { randomBytes } from 'crypto';
import { getStorageService } from './storage.service';
import { ApiKeyCreateResponse, generateId } from '@appliance.sh/sdk';
import { DEFAULT_TENANT, getCurrentTenant } from './tenant-context';

const COLLECTION = 'api-keys';

// The shared secret must be stored to verify HMAC signatures (RFC 9421).
// Unlike password hashing, HMAC requires the original key on both sides.
export interface StoredApiKey {
  id: string;
  name: string;
  secret: string;
  createdAt: string;
  lastUsedAt?: string;
  /**
   * Owning principal. Bound at mint time from the SERVER-derived
   * principal (the ambient tenant, or the default tenant when none) —
   * never from client input. Immutable across the key's life; rotation
   * inherits it. Absent on legacy keys ⇒ resolves to the default tenant.
   */
  tenantId?: string;
}

export class ApiKeyService {
  /**
   * Mint a key. The owning `tenantId` is SERVER-derived and immutable —
   * taken from an explicit server-supplied principal (rotation inherits
   * the prior key's tenant) or the ambient request tenant, falling back
   * to the default tenant. There is deliberately no path for a client to
   * assert the tenant of a key it is minting.
   */
  async create(name: string, tenantId?: string): Promise<ApiKeyCreateResponse> {
    const storage = getStorageService();
    const id = generateId('apikey');
    const secret = `sk_${randomBytes(32).toString('hex')}`;
    const now = new Date().toISOString();

    const stored: StoredApiKey = {
      id,
      name,
      secret,
      createdAt: now,
      tenantId: tenantId ?? getCurrentTenant() ?? DEFAULT_TENANT,
    };

    await storage.set(COLLECTION, id, stored);

    return { id, name, secret, createdAt: now };
  }

  async getByKeyId(keyId: string): Promise<StoredApiKey | null> {
    const storage = getStorageService();
    return storage.get<StoredApiKey>(COLLECTION, keyId);
  }

  /**
   * Server-bootstrap gate: "is there ANY key at all yet?". This is a
   * deliberate server-LEVEL check (Quinn #3), not a per-principal one —
   * it runs before any principal exists, against the auth-root
   * (un-tenant-scoped) `api-keys` collection, to decide whether the
   * server has been initialized. Per-tenant existence is a different
   * question — see `existsForTenant`.
   */
  async exists(): Promise<boolean> {
    const storage = getStorageService();
    const keys = await storage.getAll<StoredApiKey>(COLLECTION);
    return keys.length > 0;
  }

  /**
   * Principal-scoped existence (Sasha #4): does the given tenant own any
   * key? Unlike the server-bootstrap gate, this is per-principal — a
   * global "any key" check would be a cross-tenant logic bug in a managed
   * world. Kept distinct so the two questions never get conflated.
   */
  async existsForTenant(tenantId: string): Promise<boolean> {
    const storage = getStorageService();
    const keys = await storage.getAll<StoredApiKey>(COLLECTION);
    return keys.some((k) => (k.tenantId ?? DEFAULT_TENANT) === tenantId);
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
    // The principal is immutable across rotation: the replacement
    // inherits the prior key's tenant (default when the old key predates
    // the tenant dimension), never re-derives it from the caller.
    const replacement = await this.create(existing.name, existing.tenantId ?? DEFAULT_TENANT);
    // Revoke last: the replacement is already persisted and returned.
    await this.delete(keyId);
    return replacement;
  }
}

export const apiKeyService = new ApiKeyService();
