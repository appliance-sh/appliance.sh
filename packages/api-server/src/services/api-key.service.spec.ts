import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiKeyService } from './api-key.service';
import { DEFAULT_TENANT, runWithTenant } from './tenant-context';

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

  it('should create a key with apikey_ prefixed id and sk_ prefixed secret', async () => {
    const result = await service.create('test-key');
    expect(result.id).toMatch(/^apikey_/);
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
    expect(stored!.secret).toBe(created.secret);
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

  it('should delete a key', async () => {
    const created = await service.create('test-key');
    await service.delete(created.id);
    const stored = await service.getByKeyId(created.id);
    expect(stored).toBeNull();
  });

  it('delete is a no-op for unknown ids', async () => {
    await expect(service.delete('apikey_unknown')).resolves.toBeUndefined();
  });

  it('rotate mints a new key, revokes the old one, and inherits the name', async () => {
    const created = await service.create('cli');
    const rotated = await service.rotate(created.id);

    expect(rotated).not.toBeNull();
    expect(rotated!.id).not.toBe(created.id);
    expect(rotated!.id).toMatch(/^apikey_/);
    expect(rotated!.secret).toMatch(/^sk_/);
    expect(rotated!.secret).not.toBe(created.secret);
    // Name is inherited so the key keeps its human label across rotations.
    expect(rotated!.name).toBe('cli');

    // Old key is revoked; new key is usable.
    expect(await service.getByKeyId(created.id)).toBeNull();
    const stored = await service.getByKeyId(rotated!.id);
    expect(stored!.secret).toBe(rotated!.secret);
  });

  it('rotate returns null for an unknown key id', async () => {
    const result = await service.rotate('apikey_unknown');
    expect(result).toBeNull();
  });

  describe('principal binding (Seam #1: server-derived, immutable)', () => {
    it('stamps the default tenant when minted with no ambient principal', async () => {
      const created = await service.create('cli');
      const stored = await service.getByKeyId(created.id);
      expect(stored!.tenantId).toBe(DEFAULT_TENANT);
    });

    it('binds the ambient (server-derived) tenant at mint time', async () => {
      const created = await runWithTenant('acme', () => service.create('cli'));
      const stored = await service.getByKeyId(created.id);
      expect(stored!.tenantId).toBe('acme');
    });

    it('rotation inherits the prior key principal (immutable across rotation)', async () => {
      const created = await runWithTenant('acme', () => service.create('cli'));
      // Rotate from a DIFFERENT ambient context to prove the tenant is
      // inherited from the stored key, not re-derived from the caller.
      const rotated = await runWithTenant('globex', () => service.rotate(created.id));
      const stored = await service.getByKeyId(rotated!.id);
      expect(stored!.tenantId).toBe('acme');
    });

    it('existsForTenant is principal-scoped, unlike the server-bootstrap gate', async () => {
      await runWithTenant('acme', () => service.create('cli'));
      expect(await service.existsForTenant('acme')).toBe(true);
      expect(await service.existsForTenant('globex')).toBe(false);
      // The server-bootstrap gate is a global "any key" check.
      expect(await service.exists()).toBe(true);
    });
  });
});
