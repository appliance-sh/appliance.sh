import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectStatus } from '@appliance.sh/sdk';

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

import { projectService } from './project.service';

describe('ProjectService', () => {
  beforeEach(() => {
    mockStore.clear();
  });

  it('should create a project with correct fields', async () => {
    const project = await projectService.create({ name: 'test-project' });

    expect(project.name).toBe('test-project');
    expect(project.id).toBeDefined();
    expect(project.status).toBe(ProjectStatus.Active);
    expect(project.createdAt).toBeDefined();
    expect(project.updatedAt).toBeDefined();
  });

  it('should create a project with optional description', async () => {
    const project = await projectService.create({
      name: 'test-project',
      description: 'A test',
    });

    expect(project.description).toBe('A test');
  });

  it('should retrieve a project by id', async () => {
    const created = await projectService.create({ name: 'test' });
    const fetched = await projectService.get(created.id);

    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.name).toBe('test');
  });

  it('should return null for non-existent project', async () => {
    const result = await projectService.get('non-existent');
    expect(result).toBeNull();
  });

  it('should list all projects', async () => {
    await projectService.create({ name: 'project-1' });
    await projectService.create({ name: 'project-2' });

    const projects = await projectService.list();
    expect(projects).toHaveLength(2);
  });

  it('should delete a project', async () => {
    const created = await projectService.create({ name: 'to-delete' });
    await projectService.delete(created.id);

    const result = await projectService.get(created.id);
    expect(result).toBeNull();
  });

  it('should update a project while preserving id and createdAt', async () => {
    const created = await projectService.create({ name: 'original' });
    const updated = await projectService.update(created.id, {
      name: 'updated',
      status: ProjectStatus.Archived,
    });

    expect(updated).not.toBeNull();
    expect(updated!.id).toBe(created.id);
    expect(updated!.createdAt).toBe(created.createdAt);
    expect(updated!.name).toBe('updated');
    expect(updated!.status).toBe(ProjectStatus.Archived);
    expect(updated!.updatedAt).toBeDefined();
  });

  it('should return null when updating non-existent project', async () => {
    const result = await projectService.update('non-existent', { name: 'nope' });
    expect(result).toBeNull();
  });
});
