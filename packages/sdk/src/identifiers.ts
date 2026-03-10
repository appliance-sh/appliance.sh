import { uuidv7 } from 'uuidv7';

export type IdPrefix = 'project' | 'environment' | 'deployment' | 'apikey' | 'build';

/**
 * Generate a type-prefixed UUIDv7 identifier.
 *
 * Examples:
 *   project_019cd2f7-cd13-7a74-838f-1308847e3149
 *   environment_019cd2f7-cd14-761a-ae98-f0f2956b107c
 *   deployment_019cd2f7-cd14-7b76-9d5c-974b9d1d1d62
 */
export function generateId(prefix: IdPrefix): string {
  return `${prefix}_${uuidv7()}`;
}
