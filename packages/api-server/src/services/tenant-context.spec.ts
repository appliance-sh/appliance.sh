import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TENANT,
  TenantScopeError,
  getCurrentTenant,
  isMultiTenant,
  runWithTenant,
  scopePath,
  tenantIdForKey,
} from './tenant-context';

function withFlag(value: string | undefined, fn: () => void): void {
  const prev = process.env.APPLIANCE_MULTI_TENANT;
  if (value === undefined) delete process.env.APPLIANCE_MULTI_TENANT;
  else process.env.APPLIANCE_MULTI_TENANT = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.APPLIANCE_MULTI_TENANT;
    else process.env.APPLIANCE_MULTI_TENANT = prev;
  }
}

describe('tenant-context', () => {
  afterEach(() => {
    delete process.env.APPLIANCE_MULTI_TENANT;
  });

  describe('isMultiTenant flag (default OFF)', () => {
    it('defaults to false when unset', () => {
      withFlag(undefined, () => expect(isMultiTenant()).toBe(false));
    });
    it('is false for any non-truthy value', () => {
      withFlag('false', () => expect(isMultiTenant()).toBe(false));
      withFlag('0', () => expect(isMultiTenant()).toBe(false));
      withFlag('', () => expect(isMultiTenant()).toBe(false));
    });
    it('is true only for "true"/"1"', () => {
      withFlag('true', () => expect(isMultiTenant()).toBe(true));
      withFlag('1', () => expect(isMultiTenant()).toBe(true));
    });
  });

  describe('scopePath — flag OFF is byte-identical (Seam #3 default value)', () => {
    it('returns the raw path unchanged, regardless of any ambient tenant', () => {
      withFlag(undefined, () => {
        expect(scopePath('projects/p1.json')).toBe('projects/p1.json');
        expect(scopePath('builds/b1.zip')).toBe('builds/b1.zip');
        // Even inside a tenant context, flag-off never rewrites the key.
        runWithTenant('acme', () => {
          expect(scopePath('projects/p1.json')).toBe('projects/p1.json');
        });
      });
    });
  });

  describe('scopePath — flag ON', () => {
    it('default tenant maps to the ROOT keyspace (no re-key of existing data)', () => {
      withFlag('true', () => {
        runWithTenant(DEFAULT_TENANT, () => {
          expect(scopePath('projects/p1.json')).toBe('projects/p1.json');
        });
      });
    });

    it('a real tenant namespaces under tenants/<id>/', () => {
      withFlag('true', () => {
        runWithTenant('acme', () => {
          expect(scopePath('projects/p1.json')).toBe('tenants/acme/projects/p1.json');
          expect(scopePath('builds/b1.zip')).toBe('tenants/acme/builds/b1.zip');
        });
      });
    });

    it('two tenants get disjoint prefixes (no cross-tenant collision)', () => {
      withFlag('true', () => {
        const a = runWithTenant('acme', () => scopePath('projects/shared.json'));
        const b = runWithTenant('globex', () => scopePath('projects/shared.json'));
        expect(a).not.toBe(b);
      });
    });

    it('FAILS CLOSED when no principal is resolved — never a global fallback', () => {
      withFlag('true', () => {
        expect(() => scopePath('projects/p1.json')).toThrow(TenantScopeError);
      });
    });
  });

  describe('runWithTenant / getCurrentTenant', () => {
    it('binds and reads the ambient tenant', () => {
      expect(getCurrentTenant()).toBeUndefined();
      runWithTenant('acme', () => {
        expect(getCurrentTenant()).toBe('acme');
      });
      expect(getCurrentTenant()).toBeUndefined();
    });

    it('propagates across async continuations', async () => {
      await runWithTenant('acme', async () => {
        await Promise.resolve();
        expect(getCurrentTenant()).toBe('acme');
      });
    });
  });

  describe('tenantIdForKey — legacy keys map to the default tenant', () => {
    it('maps a key with no tenantId to the default tenant', () => {
      expect(tenantIdForKey({})).toBe(DEFAULT_TENANT);
      expect(tenantIdForKey(null)).toBe(DEFAULT_TENANT);
      expect(tenantIdForKey(undefined)).toBe(DEFAULT_TENANT);
    });
    it('honors an explicit tenantId', () => {
      expect(tenantIdForKey({ tenantId: 'acme' })).toBe('acme');
    });
  });
});
