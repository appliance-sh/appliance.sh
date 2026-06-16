import { getStorageService } from './storage.service';

const COLLECTION = 'env-vars';

// Per-environment variables are stored as a single record keyed by the
// environment id. The whole map is the value — there's no per-key
// document — so a `set`/`unset` is a read-modify-write of one record.
interface StoredEnvVars {
  environmentId: string;
  variables: Record<string, string>;
  updatedAt: string;
}

export class EnvVarService {
  /** Full variable map for an environment ({} when none are set). */
  async get(environmentId: string): Promise<Record<string, string>> {
    const storage = getStorageService();
    const stored = await storage.get<StoredEnvVars>(COLLECTION, environmentId);
    return stored?.variables ?? {};
  }

  /** Key names only — callers list without ever reading secret values. */
  async listKeys(environmentId: string): Promise<string[]> {
    const variables = await this.get(environmentId);
    return Object.keys(variables).sort();
  }

  /**
   * Merge `variables` over the environment's existing set (set/update).
   * Returns the resulting key names.
   */
  async setMany(environmentId: string, variables: Record<string, string>): Promise<string[]> {
    const storage = getStorageService();
    const existing = await this.get(environmentId);
    const merged = { ...existing, ...variables };
    await storage.set<StoredEnvVars>(COLLECTION, environmentId, {
      environmentId,
      variables: merged,
      updatedAt: new Date().toISOString(),
    });
    return Object.keys(merged).sort();
  }

  /**
   * Remove the named keys. Returns the remaining key names. Unknown
   * keys are ignored (idempotent).
   */
  async unset(environmentId: string, keys: string[]): Promise<string[]> {
    const storage = getStorageService();
    const existing = await this.get(environmentId);
    let changed = false;
    for (const key of keys) {
      if (key in existing) {
        delete existing[key];
        changed = true;
      }
    }
    if (changed) {
      await storage.set<StoredEnvVars>(COLLECTION, environmentId, {
        environmentId,
        variables: existing,
        updatedAt: new Date().toISOString(),
      });
    }
    return Object.keys(existing).sort();
  }

  /** Drop the whole record (used when an environment is deleted). */
  async clear(environmentId: string): Promise<void> {
    const storage = getStorageService();
    await storage.delete(COLLECTION, environmentId);
  }
}

export const envVarService = new EnvVarService();
