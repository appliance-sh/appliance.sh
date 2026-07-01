import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Tenancy substrate (Cloud-v1, P0).
 *
 * This module is the ONE place the tenant dimension is defined. It is
 * feature-flagged and DEFAULT single-tenant: with the flag off every
 * storage key path is byte-identical to the pre-tenancy behavior, so
 * enabling managed multi-tenant later is an *enforcement swap*, not a
 * security rewrite.
 *
 * Design:
 *   - `APPLIANCE_MULTI_TENANT` (default false) gates enforcement.
 *   - The tenant dimension is baked into the storage-key SCHEMA from the
 *     start, with a defined default-tenant value (`DEFAULT_TENANT`).
 *   - The default tenant maps to the ROOT keyspace (no prefix). That is
 *     what makes single-tenant mode identical to today AND makes the
 *     managed pivot a namespacing change with no re-key of existing data
 *     (pre-existing single-tenant data simply *is* the default tenant).
 *   - Non-default tenants are namespaced under `tenants/<tenantId>/…`.
 *   - The authenticated principal's tenant is carried per-request via
 *     AsyncLocalStorage, resolved once in the auth middleware from the
 *     SERVER-STORED key (never a client-asserted value).
 */

/**
 * The default-tenant value used in single-tenant mode and for legacy
 * keys that predate the tenant dimension. It maps to the root keyspace
 * (empty prefix) so existing key paths are unchanged.
 */
export const DEFAULT_TENANT = 'default';

/**
 * Reserved key segment under which non-default tenants are namespaced.
 * Chosen to never collide with an existing storage collection
 * (`api-keys`, `projects`, `environments`, `deployments`, `builds`,
 * `env-vars`) or a direct-S3 build-artifact prefix (`builds/`).
 */
export const TENANT_PREFIX = 'tenants';

/**
 * Safe charset a non-default tenant id must match BEFORE it is
 * interpolated into a `tenants/<id>/…` storage key. Rejects anything
 * that could break out of the intended prefix — path separators (`/`),
 * `.` (so no `..` traversal), whitespace, and control characters —
 * while allowing alphanumerics plus `-`/`_` (covers generated and
 * DNS-style ids). Length-bounded to keep keys sane. This is inert in P0
 * (only the default tenant exists), but `scopePath` is the seam P1 mints
 * real tenants onto, so the guard lives at the choke point from the
 * start.
 */
const TENANT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Thrown when multi-tenant enforcement is on but no principal/tenant is
 * resolvable for a keyed access. The scoping choke point raises this to
 * FAIL CLOSED — it must NEVER silently fall back to the global/unscoped
 * keyspace.
 */
export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantScopeError';
  }
}

interface TenantStore {
  tenantId: string;
}

const tenantContext = new AsyncLocalStorage<TenantStore>();

/**
 * Whether managed multi-tenant enforcement is enabled. Read lazily (per
 * call) so the flag can be toggled at process start — and in tests —
 * without a module reload. DEFAULT: false (single-tenant).
 */
export function isMultiTenant(): boolean {
  const raw = process.env.APPLIANCE_MULTI_TENANT;
  return raw === 'true' || raw === '1';
}

/**
 * Run `fn` (and every async continuation it spawns) with `tenantId` bound
 * as the ambient principal. The auth middleware wraps the entire
 * downstream request in this, so tenant scope is established by
 * construction for every authenticated route.
 */
export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  return tenantContext.run({ tenantId }, fn);
}

/** The ambient tenant, or undefined when there is no request context. */
export function getCurrentTenant(): string | undefined {
  return tenantContext.getStore()?.tenantId;
}

/**
 * Map a raw storage key/prefix to its tenant-scoped form. This is the
 * single scoping primitive shared by the StorageService choke point AND
 * the direct-S3 build-artifact path, so there is exactly one scheme.
 *
 * Semantics:
 *   - flag OFF          → returned unchanged (byte-identical to today).
 *   - flag ON, no tenant→ THROWS (fail closed; no global fallback).
 *   - flag ON, default  → returned unchanged (default tenant = root).
 *   - flag ON, tenant T → `tenants/<T>/<rawPath>`.
 */
export function scopePath(rawPath: string): string {
  if (!isMultiTenant()) return rawPath;

  const tenant = getCurrentTenant();
  if (!tenant) {
    throw new TenantScopeError(
      `Refusing unscoped storage access for "${rawPath}": no tenant resolved in the current context`
    );
  }

  if (tenant === DEFAULT_TENANT) return rawPath;

  // Validate the tenant id before it becomes part of a storage key so a
  // malformed/hostile principal can never traverse or inject outside its
  // `tenants/<id>/` namespace. Fail closed on anything unsafe.
  if (!TENANT_ID_PATTERN.test(tenant)) {
    throw new TenantScopeError(
      `Refusing storage access for tenant "${tenant}": tenant id is not a safe [a-zA-Z0-9_-] value`
    );
  }

  return `${TENANT_PREFIX}/${tenant}/${rawPath}`;
}

/**
 * Resolve the principal's tenant from a stored key. A legacy key (minted
 * before the tenant dimension existed) has no `tenantId` and maps to the
 * default tenant. Never derives the tenant from client-supplied input —
 * only from the server-stored key record.
 */
export function tenantIdForKey(key: { tenantId?: string } | null | undefined): string {
  return key?.tenantId ?? DEFAULT_TENANT;
}
