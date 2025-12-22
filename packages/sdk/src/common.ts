import { z } from 'zod';

export const portInput = z.number().int().gt(0).lt(65536);
