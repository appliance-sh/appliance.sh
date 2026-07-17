import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory storage stand-in: enough of StorageService for InviteService.
const memory = vi.hoisted(() => new Map<string, unknown>());

vi.mock('./storage.service', () => ({
  getStorageService: () => ({
    set: async (collection: string, id: string, value: unknown) => {
      memory.set(`${collection}/${id}`, value);
    },
    get: async (collection: string, id: string) => memory.get(`${collection}/${id}`) ?? null,
    getAll: async (collection: string) =>
      [...memory.entries()].filter(([k]) => k.startsWith(`${collection}/`)).map(([, v]) => v),
    delete: async (collection: string, id: string) => {
      memory.delete(`${collection}/${id}`);
    },
    filter: async (collection: string, predicate: (item: unknown) => boolean) =>
      [...memory.entries()]
        .filter(([k]) => k.startsWith(`${collection}/`))
        .map(([, v]) => v)
        .filter(predicate),
  }),
}));

import { InviteService } from './invite.service';

describe('InviteService', () => {
  const service = new InviteService();

  beforeEach(() => {
    memory.clear();
  });

  it('stores only a hash of the token', async () => {
    const created = await service.create({ name: 'teammate' });

    const stored = [...memory.values()] as { tokenHash: string; name: string }[];
    expect(stored).toHaveLength(1);
    expect(stored[0].tokenHash).not.toContain(created.token);
    expect(JSON.stringify(stored[0])).not.toContain(created.token);
  });

  it('redeems a valid token exactly once, minting a member key', async () => {
    const created = await service.create({ name: 'teammate' });

    const first = await service.redeem(created.token);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.key.name).toBe('teammate');
      expect(first.key.role).toBe('member');
      expect(first.key.secret).toMatch(/^sk_/);
    }

    const second = await service.redeem(created.token);
    expect(second).toEqual({ ok: false, reason: 'redeemed' });
  });

  it('honors a requested admin role', async () => {
    const created = await service.create({ name: 'co-admin', role: 'admin' });
    const result = await service.redeem(created.token);
    expect(result.ok && result.key.role).toBe('admin');
  });

  it('rejects unknown tokens', async () => {
    await service.create({ name: 'teammate' });
    expect(await service.redeem('inv_wrong')).toEqual({ ok: false, reason: 'not-found' });
  });

  it('rejects expired tokens', async () => {
    const created = await service.create({ name: 'teammate', expiresInHours: 1 });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(Date.now() + 2 * 3600_000));
      expect(await service.redeem(created.token)).toEqual({ ok: false, reason: 'expired' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists invites without tokens and marks redemption', async () => {
    const created = await service.create({ name: 'teammate' });
    await service.redeem(created.token);

    const listed = await service.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].redeemedAt).toBeDefined();
    expect(JSON.stringify(listed)).not.toContain(created.token);
  });

  it('delete revokes an unredeemed invite', async () => {
    const created = await service.create({ name: 'teammate' });
    await service.delete(created.id);
    expect(await service.redeem(created.token)).toEqual({ ok: false, reason: 'not-found' });
  });
});
