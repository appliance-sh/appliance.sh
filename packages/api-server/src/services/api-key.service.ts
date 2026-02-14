import { randomUUID, randomBytes, createHash } from 'crypto';
import { getStorageService } from './storage.service';
import { ApiKeyCreateResponse } from '@appliance.sh/sdk';

const COLLECTION = 'api-keys';

interface StoredApiKey {
  id: string;
  name: string;
  rawSecret: string;
  secretHash: string;
  createdAt: string;
  lastUsedAt?: string;
}

export class ApiKeyService {
  async create(name: string): Promise<ApiKeyCreateResponse> {
    const storage = getStorageService();
    const id = `ak_${randomUUID()}`;
    const secret = `sk_${randomBytes(32).toString('hex')}`;
    const secretHash = createHash('sha256').update(secret).digest('hex');
    const now = new Date().toISOString();

    const stored: StoredApiKey = {
      id,
      name,
      rawSecret: secret,
      secretHash,
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
