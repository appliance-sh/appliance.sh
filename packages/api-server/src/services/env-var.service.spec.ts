import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EnvVarService } from './env-var.service';

const mockStore = new Map<string, string>();

vi.mock('./storage.service', () => ({
  getStorageService: () => ({
    get: async (collection: string, id: string) => {
      const data = mockStore.get(`${collection}/${id}.json`);
      return data ? JSON.parse(data) : null;
    },
    set: async (collection: string, id: string, value: unknown) => {
      mockStore.set(`${collection}/${id}.json`, JSON.stringify(value));
    },
    delete: async (collection: string, id: string) => {
      mockStore.delete(`${collection}/${id}.json`);
    },
  }),
}));

describe('EnvVarService', () => {
  let service: EnvVarService;

  beforeEach(() => {
    mockStore.clear();
    service = new EnvVarService();
  });

  it('returns an empty map when nothing is set', async () => {
    expect(await service.get('env_1')).toEqual({});
    expect(await service.listKeys('env_1')).toEqual([]);
  });

  it('sets and merges variables, listing keys sorted', async () => {
    await service.setMany('env_1', { B: '2', A: '1' });
    await service.setMany('env_1', { C: '3', A: 'override' });

    expect(await service.get('env_1')).toEqual({ A: 'override', B: '2', C: '3' });
    expect(await service.listKeys('env_1')).toEqual(['A', 'B', 'C']);
  });

  it('keeps variables isolated per environment', async () => {
    await service.setMany('env_1', { SHARED: 'one' });
    await service.setMany('env_2', { SHARED: 'two' });

    expect(await service.get('env_1')).toEqual({ SHARED: 'one' });
    expect(await service.get('env_2')).toEqual({ SHARED: 'two' });
  });

  it('unsets a key and is idempotent for unknown keys', async () => {
    await service.setMany('env_1', { A: '1', B: '2' });
    expect(await service.unset('env_1', ['A'])).toEqual(['B']);
    // Removing an already-absent key is a no-op.
    expect(await service.unset('env_1', ['A'])).toEqual(['B']);
    expect(await service.get('env_1')).toEqual({ B: '2' });
  });

  it('clears the whole record', async () => {
    await service.setMany('env_1', { A: '1' });
    await service.clear('env_1');
    expect(await service.get('env_1')).toEqual({});
  });
});
