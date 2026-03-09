import { applianceBaseConfig, type ObjectStore } from '@appliance.sh/sdk';
import { S3ObjectStore } from './s3-object-store';

export class StorageService {
  private readonly store: ObjectStore;

  constructor(store: ObjectStore) {
    this.store = store;
  }

  private getKey(collection: string, id: string): string {
    return `${collection}/${id}.json`;
  }

  async get<T>(collection: string, id: string): Promise<T | null> {
    const data = await this.store.get(this.getKey(collection, id));
    if (!data) return null;
    return JSON.parse(data) as T;
  }

  async getAll<T>(collection: string): Promise<T[]> {
    const keys = await this.store.list(`${collection}/`);
    const items: T[] = [];

    for (const key of keys) {
      const data = await this.store.get(key);
      if (data) {
        items.push(JSON.parse(data) as T);
      }
    }

    return items;
  }

  async set<T>(collection: string, id: string, value: T): Promise<void> {
    await this.store.set(this.getKey(collection, id), JSON.stringify(value));
  }

  async delete(collection: string, id: string): Promise<void> {
    await this.store.delete(this.getKey(collection, id));
  }

  async filter<T>(collection: string, predicate: (item: T) => boolean): Promise<T[]> {
    const all = await this.getAll<T>(collection);
    return all.filter(predicate);
  }
}

function createStorageService(): StorageService {
  const baseConfigJson = process.env.APPLIANCE_BASE_CONFIG;
  if (!baseConfigJson) {
    throw new Error('APPLIANCE_BASE_CONFIG environment variable is required');
  }

  const config = applianceBaseConfig.parse(JSON.parse(baseConfigJson));

  if (!config.aws.dataBucketName) {
    throw new Error('dataBucketName is required in APPLIANCE_BASE_CONFIG');
  }

  const store = new S3ObjectStore(config.aws.dataBucketName, config.aws.region);
  return new StorageService(store);
}

let storageServiceInstance: StorageService | null = null;

export function getStorageService(): StorageService {
  if (!storageServiceInstance) {
    storageServiceInstance = createStorageService();
  }
  return storageServiceInstance;
}
