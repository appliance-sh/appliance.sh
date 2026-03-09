import { uuidv7 } from 'uuidv7';

export type IdPrefix = 'proj' | 'env' | 'dep' | 'ak';

/**
 * Generate a type-prefixed UUIDv7 identifier.
 *
 * Examples:
 *   proj_019cd2f7-cd13-7a74-838f-1308847e3149
 *   env_019cd2f7-cd14-761a-ae98-f0f2956b107c
 *   dep_019cd2f7-cd14-7b76-9d5c-974b9d1d1d62
 */
export function generateId(prefix: IdPrefix): string {
  return `${prefix}_${uuidv7()}`;
}
