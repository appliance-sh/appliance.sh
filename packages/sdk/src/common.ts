import { z } from 'zod';

export const portInput = z.number().int().gt(0).lt(65536);

export const dnsName = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'Name must be lowercase alphanumeric with hyphens, DNS-safe');
