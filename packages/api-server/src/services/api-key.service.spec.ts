import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiKeyService } from './api-key.service';

const mockStore = new Map<string, string>();

vi.mock('./storage.service', () => ({
  getStorageService: () => ({
    get: async (_collection: string, id: string) => {
      const key = `${_collection}/${id}.json`;
      const data = mockStore.get(key);
      return data ? JSON.parse(data) : null;
    },
    set: async (_collection: string, id: string, value: unknown) => {
      const key = `${_collection}/${id}.json`;
      mockStore.set(key, JSON.stringify(value));
    },
    getAll: async (_collection: string) => {
      const items: unknown[] = [];
      for (const [key, value] of mockStore) {
        if (key.startsWith(`${_collection}/`)) {
          items.push(JSON.parse(value));
        }
      }
      return items;
    },
    delete: async (_collection: string, id: string) => {
      const key = `${_collection}/${id}.json`;
      mockStore.delete(key);
    },
  }),
}));

describe('ApiKeyService', () => {
  let service: ApiKeyService;

  beforeEach(() => {
    mockStore.clear();
    service = new ApiKeyService();
  });

  it('should create a key with ak_ prefixed id and sk_ prefixed secret', async () => {
    const result = await service.create('test-key');
    expect(result.id).toMatch(/^ak_/);
    expect(result.secret).toMatch(/^sk_/);
    expect(result.name).toBe('test-key');
    expect(result.createdAt).toBeDefined();
  });

  it('should retrieve a stored key by id', async () => {
    const created = await service.create('test-key');
    const stored = await service.getByKeyId(created.id);
    expect(stored).not.toBeNull();
    expect(stored!.id).toBe(created.id);
    expect(stored!.name).toBe('test-key');
    expect(stored!.rawSecret).toBe(created.secret);
  });

  it('should return null for non-existent key', async () => {
    const result = await service.getByKeyId('ak_nonexistent');
    expect(result).toBeNull();
  });

  it('should return false for exists when no keys', async () => {
    const result = await service.exists();
    expect(result).toBe(false);
  });

  it('should return true for exists when keys exist', async () => {
    await service.create('test-key');
    const result = await service.exists();
    expect(result).toBe(true);
  });

  it('should update lastUsedAt', async () => {
    const created = await service.create('test-key');
    await service.updateLastUsed(created.id);
    const stored = await service.getByKeyId(created.id);
    expect(stored!.lastUsedAt).toBeDefined();
  });
});
