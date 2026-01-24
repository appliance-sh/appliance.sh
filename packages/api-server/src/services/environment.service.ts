import { Environment, EnvironmentInput, EnvironmentStatus } from '@appliance.sh/sdk';
import { getStorageService } from './storage.service';
import { randomUUID } from 'crypto';

const COLLECTION = 'environments';

export class EnvironmentService {
  async create(input: EnvironmentInput): Promise<Environment> {
    const storage = getStorageService();
    const now = new Date().toISOString();
    const id = randomUUID();
    const environment: Environment = {
      ...input,
      id,
      status: EnvironmentStatus.Pending,
      stackName: `${input.projectId}-${id}`,
      createdAt: now,
      updatedAt: now,
    };
    await storage.set(COLLECTION, environment.id, environment);
    return environment;
  }

  async get(id: string): Promise<Environment | null> {
    const storage = getStorageService();
    return storage.get<Environment>(COLLECTION, id);
  }

  async listByProject(projectId: string): Promise<Environment[]> {
    const storage = getStorageService();
    return storage.filter<Environment>(COLLECTION, (env) => env.projectId === projectId);
  }

  async delete(id: string): Promise<void> {
    const storage = getStorageService();
    await storage.delete(COLLECTION, id);
  }

  async updateStatus(id: string, status: EnvironmentStatus): Promise<Environment | null> {
    const storage = getStorageService();
    const existing = await storage.get<Environment>(COLLECTION, id);
    if (!existing) return null;

    const updated: Environment = {
      ...existing,
      status,
      updatedAt: new Date().toISOString(),
      lastDeployedAt: status === EnvironmentStatus.Deployed ? new Date().toISOString() : existing.lastDeployedAt,
    };
    await storage.set(COLLECTION, id, updated);
    return updated;
  }

  async update(id: string, updates: Partial<Environment>): Promise<Environment | null> {
    const storage = getStorageService();
    const existing = await storage.get<Environment>(COLLECTION, id);
    if (!existing) return null;

    const updated: Environment = {
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

export const environmentService = new EnvironmentService();
