import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ObjectStore } from '@appliance.sh/sdk';
import { StorageService } from './storage.service';
import { DEFAULT_TENANT, TenantScopeError, runWithTenant } from './tenant-context';

/** In-memory ObjectStore so we can assert on the exact keys written. */
class MemoryStore implements ObjectStore {
  readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  async list(prefix?: string): Promise<string[]> {
    const keys = [...this.map.keys()];
    return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
  }
}

describe('StorageService tenant-scoping choke point', () => {
  let store: MemoryStore;
  let storage: StorageService;

  beforeEach(() => {
    store = new MemoryStore();
    storage = new StorageService(store);
  });

  afterEach(() => {
    delete process.env.APPLIANCE_MULTI_TENANT;
  });

  describe('flag OFF — byte-identical keys to pre-tenancy behavior', () => {
    it('writes the exact same key path as before (no prefix)', async () => {
      await storage.set('projects', 'p1', { id: 'p1' });
      expect([...store.map.keys()]).toEqual(['projects/p1.json']);
    });

    it('list uses the un-prefixed collection prefix', async () => {
      await storage.set('projects', 'p1', { id: 'p1' });
      await storage.set('projects', 'p2', { id: 'p2' });
      const all = await storage.getAll<{ id: string }>('projects');
      expect(all.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
    });

    it('an ambient tenant is ignored while the flag is off', async () => {
      await runWithTenant('acme', () => storage.set('projects', 'p1', { id: 'p1' }));
      expect([...store.map.keys()]).toEqual(['projects/p1.json']);
    });
  });

  describe('flag ON — every keyed op AND the list prefix are tenant-scoped', () => {
    beforeEach(() => {
      process.env.APPLIANCE_MULTI_TENANT = 'true';
    });

    it('scopes point-writes (getKey) under tenants/<id>/', async () => {
      await runWithTenant('acme', () => storage.set('projects', 'p1', { id: 'p1' }));
      expect([...store.map.keys()]).toEqual(['tenants/acme/projects/p1.json']);
    });

    it('the default tenant stays at the root (legacy data is not re-keyed)', async () => {
      await runWithTenant(DEFAULT_TENANT, () => storage.set('projects', 'p1', { id: 'p1' }));
      expect([...store.map.keys()]).toEqual(['projects/p1.json']);
    });

    it('a cross-tenant point-read is denied (empty), not leaked', async () => {
      await runWithTenant('acme', () => storage.set('projects', 'p1', { id: 'secret' }));
      const leaked = await runWithTenant('globex', () => storage.get('projects', 'p1'));
      expect(leaked).toBeNull();
      const own = await runWithTenant('acme', () => storage.get<{ id: string }>('projects', 'p1'));
      expect(own?.id).toBe('secret');
    });

    it('a cross-tenant LIST cannot enumerate another tenant (Quinn #1)', async () => {
      await runWithTenant('acme', () => storage.set('projects', 'p1', { id: 'a' }));
      await runWithTenant('globex', () => storage.set('projects', 'p2', { id: 'g' }));
      const acme = await runWithTenant('acme', () => storage.getAll<{ id: string }>('projects'));
      const globex = await runWithTenant('globex', () => storage.getAll<{ id: string }>('projects'));
      expect(acme.map((p) => p.id)).toEqual(['a']);
      expect(globex.map((p) => p.id)).toEqual(['g']);
    });

    it('filter() inherits the list scoping', async () => {
      await runWithTenant('acme', () => storage.set('deployments', 'd1', { id: 'd1', env: 'e1' }));
      await runWithTenant('globex', () => storage.set('deployments', 'd2', { id: 'd2', env: 'e1' }));
      const acme = await runWithTenant('acme', () =>
        storage.filter<{ id: string; env: string }>('deployments', (d) => d.env === 'e1')
      );
      expect(acme.map((d) => d.id)).toEqual(['d1']);
    });

    it('FAILS CLOSED on point ops when no principal is resolved', async () => {
      await expect(storage.get('projects', 'p1')).rejects.toBeInstanceOf(TenantScopeError);
      await expect(storage.set('projects', 'p1', {})).rejects.toBeInstanceOf(TenantScopeError);
    });

    it('FAILS CLOSED on list ops when no principal is resolved', async () => {
      await expect(storage.getAll('projects')).rejects.toBeInstanceOf(TenantScopeError);
    });
  });

  describe('api-keys auth-root exemption (Quinn #3)', () => {
    beforeEach(() => {
      process.env.APPLIANCE_MULTI_TENANT = 'true';
    });

    it('api-keys is reachable WITHOUT a principal (the tenant is resolved from the key)', async () => {
      // No runWithTenant wrapper — this is the pre-principal auth-root path.
      await storage.set('api-keys', 'apikey_1', { id: 'apikey_1', secret: 'sk_x' });
      expect([...store.map.keys()]).toEqual(['api-keys/apikey_1.json']);
      const got = await storage.get<{ id: string }>('api-keys', 'apikey_1');
      expect(got?.id).toBe('apikey_1');
    });

    it('the server-bootstrap "any key" gate lists api-keys unscoped', async () => {
      await storage.set('api-keys', 'apikey_1', { id: 'apikey_1' });
      const all = await storage.getAll('api-keys');
      expect(all).toHaveLength(1);
    });
  });
});
