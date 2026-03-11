import { z } from 'zod';
import { dnsName } from '../common';

export enum ProjectStatus {
  Active = 'active',
  Archived = 'archived',
}

export const projectInput = z.object({
  name: dnsName,
  description: z.string().optional(),
});

export type ProjectInput = z.infer<typeof projectInput>;

export const project = projectInput.extend({
  id: z.string(),
  status: z.nativeEnum(ProjectStatus),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Project = z.infer<typeof project>;
