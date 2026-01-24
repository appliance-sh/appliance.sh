import { Project, ProjectInput, ProjectStatus } from '@appliance.sh/sdk';
import { getStorageService } from './storage.service';
import { randomUUID } from 'crypto';

const COLLECTION = 'projects';

export class ProjectService {
  async create(input: ProjectInput): Promise<Project> {
    const storage = getStorageService();
    const now = new Date().toISOString();
    const project: Project = {
      ...input,
      id: randomUUID(),
      status: ProjectStatus.Active,
      createdAt: now,
      updatedAt: now,
    };
    await storage.set(COLLECTION, project.id, project);
    return project;
  }

  async get(id: string): Promise<Project | null> {
    const storage = getStorageService();
    return storage.get<Project>(COLLECTION, id);
  }

  async list(): Promise<Project[]> {
    const storage = getStorageService();
    return storage.getAll<Project>(COLLECTION);
  }

  async delete(id: string): Promise<void> {
    const storage = getStorageService();
    await storage.delete(COLLECTION, id);
  }

  async update(id: string, updates: Partial<Project>): Promise<Project | null> {
    const storage = getStorageService();
    const existing = await storage.get<Project>(COLLECTION, id);
    if (!existing) return null;

    const updated: Project = {
      ...existing,
      ...updates,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await storage.set(COLLECTION, id, updated);
    return updated;
  }
}

export const projectService = new ProjectService();
