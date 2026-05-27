import { Environment, EnvironmentInput, EnvironmentStatus, generateId } from '@appliance.sh/sdk';
import { getStorageService } from './storage.service';

const COLLECTION = 'environments';

export class EnvironmentService {
  async create(input: EnvironmentInput, projectName: string): Promise<Environment> {
    const storage = getStorageService();
    const now = new Date().toISOString();
    const id = generateId('environment');
    const environment: Environment = {
      ...input,
      id,
      status: EnvironmentStatus.Pending,
      stackName: `${projectName}-${input.name}`,
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

  /**
   * Flip an environment's status atomically with optional URL bookkeeping.
   *
   * `opts.url`:
   *   - omitted     → leave the existing url untouched
   *   - a string    → set the url to that value (deploy success)
   *   - null        → clear the url (destroy success, env is no longer
   *                    reachable)
   *
   * Keeping status + url in a single write avoids a window where the
   * env shows as Deployed with a stale URL, or as Destroyed with a
   * URL that no longer resolves.
   */
  async updateStatus(
    id: string,
    status: EnvironmentStatus,
    opts?: { url?: string | null }
  ): Promise<Environment | null> {
    const storage = getStorageService();
    const existing = await storage.get<Environment>(COLLECTION, id);
    if (!existing) return null;

    const url = opts && 'url' in opts ? (opts.url ?? undefined) : existing.url;

    const updated: Environment = {
      ...existing,
      status,
      url,
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
