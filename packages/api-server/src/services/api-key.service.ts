import { randomBytes } from 'crypto';
import { getStorageService } from './storage.service';
import { ApiKeyCreateResponse, generateId } from '@appliance.sh/sdk';

const COLLECTION = 'api-keys';

// The shared secret must be stored to verify HMAC signatures (RFC 9421).
// Unlike password hashing, HMAC requires the original key on both sides.
interface StoredApiKey {
  id: string;
  name: string;
  secret: string;
  createdAt: string;
  lastUsedAt?: string;
}

export class ApiKeyService {
  async create(name: string): Promise<ApiKeyCreateResponse> {
    const storage = getStorageService();
    const id = generateId('apikey');
    const secret = `sk_${randomBytes(32).toString('hex')}`;
    const now = new Date().toISOString();

    const stored: StoredApiKey = {
      id,
      name,
      secret,
      createdAt: now,
    };

    await storage.set(COLLECTION, id, stored);

    return { id, name, secret, createdAt: now };
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
}

export const apiKeyService = new ApiKeyService();
