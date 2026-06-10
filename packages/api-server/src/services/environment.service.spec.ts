import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EnvironmentStatus } from '@appliance.sh/sdk';

const mockStore = new Map<string, string>();

vi.mock('./storage.service', () => ({
  getStorageService: () => ({
    get: async (_collection: string, id: string) => {
      const key = `${_collection}/${id}.json`;
      const val = mockStore.get(key);
      return val ? JSON.parse(val) : null;
    },
    getAll: async (collection: string) => {
      const items: unknown[] = [];
      for (const [key, val] of mockStore) {
        if (key.startsWith(`${collection}/`)) {
          items.push(JSON.parse(val));
        }
      }
      return items;
    },
    set: async (_collection: string, id: string, value: unknown) => {
      mockStore.set(`${_collection}/${id}.json`, JSON.stringify(value));
    },
    delete: async (_collection: string, id: string) => {
      mockStore.delete(`${_collection}/${id}.json`);
    },
    filter: async (collection: string, predicate: (item: unknown) => boolean) => {
      const items: unknown[] = [];
      for (const [key, val] of mockStore) {
        if (key.startsWith(`${collection}/`)) {
          const parsed = JSON.parse(val);
          if (predicate(parsed)) items.push(parsed);
        }
      }
      return items;
    },
  }),
}));

import { environmentService } from './environment.service';

describe('EnvironmentService', () => {
  beforeEach(() => {
    mockStore.clear();
  });

  it('should create an environment with Pending status', async () => {
    const env = await environmentService.create(
      {
        name: 'production',
        projectId: 'proj-1',
      },
      'proj-1'
    );

    expect(env.name).toBe('production');
    expect(env.projectId).toBe('proj-1');
    expect(env.status).toBe(EnvironmentStatus.Pending);
    expect(env.id).toBeDefined();
    expect(env.stackName).toBe('proj-1-production');
    expect(env.createdAt).toBeDefined();
  });

  it('should retrieve an environment by id', async () => {
    const created = await environmentService.create(
      {
        name: 'staging',
        projectId: 'proj-1',
      },
      'proj-1'
    );

    const fetched = await environmentService.get(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe('staging');
  });

  it('should return null for non-existent environment', async () => {
    const result = await environmentService.get('non-existent');
    expect(result).toBeNull();
  });

  it('should list environments by projectId', async () => {
    await environmentService.create(
      {
        name: 'prod',
        projectId: 'proj-1',
      },
      'proj-1'
    );
    await environmentService.create(
      {
        name: 'staging',
        projectId: 'proj-1',
      },
      'proj-1'
    );
    await environmentService.create(
      {
        name: 'dev',
        projectId: 'proj-2',
      },
      'proj-1'
    );

    const proj1Envs = await environmentService.listByProject('proj-1');
    expect(proj1Envs).toHaveLength(2);

    const proj2Envs = await environmentService.listByProject('proj-2');
    expect(proj2Envs).toHaveLength(1);
  });

  it('should delete an environment', async () => {
    const created = await environmentService.create(
      {
        name: 'to-delete',
        projectId: 'proj-1',
      },
      'proj-1'
    );

    await environmentService.delete(created.id);
    const result = await environmentService.get(created.id);
    expect(result).toBeNull();
  });

  it('should update environment status', async () => {
    const created = await environmentService.create(
      {
        name: 'prod',
        projectId: 'proj-1',
      },
      'proj-1'
    );

    const updated = await environmentService.updateStatus(created.id, EnvironmentStatus.Deploying);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe(EnvironmentStatus.Deploying);
    expect(updated!.lastDeployedAt).toBeUndefined();
  });

  it('should set lastDeployedAt when status is Deployed', async () => {
    const created = await environmentService.create(
      {
        name: 'prod',
        projectId: 'proj-1',
      },
      'proj-1'
    );

    const updated = await environmentService.updateStatus(created.id, EnvironmentStatus.Deployed);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe(EnvironmentStatus.Deployed);
    expect(updated!.lastDeployedAt).toBeDefined();
  });

  it('should return null when updating status of non-existent environment', async () => {
    const result = await environmentService.updateStatus('non-existent', EnvironmentStatus.Failed);
    expect(result).toBeNull();
  });

  it('should update environment preserving id and createdAt', async () => {
    const created = await environmentService.create(
      {
        name: 'prod',
        projectId: 'proj-1',
      },
      'proj-1'
    );

    const updated = await environmentService.update(created.id, { name: 'production' });
    expect(updated).not.toBeNull();
    expect(updated!.id).toBe(created.id);
    expect(updated!.createdAt).toBe(created.createdAt);
    expect(updated!.name).toBe('production');
  });
});
