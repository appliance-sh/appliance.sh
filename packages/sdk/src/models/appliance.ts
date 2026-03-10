import { z } from 'zod';
import { portInput } from '../common';

export enum ApplianceType {
  container = 'container',
  framework = 'framework',
  other = 'other',
}

export enum AppliancePlatform {
  LinuxAmd64 = 'linux/amd64',
  LinuxArm64 = 'linux/arm64',
}

export enum ApplianceFramework {
  Auto = 'auto',
  Python = 'python',
  Node = 'node',
  Other = 'other',
}

export const applianceTypeSchema = z.enum(ApplianceType);

export const applianceTypeBase = z.object({
  manifest: z.literal('v1'),
  name: z
    .string()
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'Name must be lowercase alphanumeric with hyphens, DNS-safe'),
  version: z.string().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
});

export const applianceTypeContainerInput = applianceTypeBase.extend({
  type: z.literal(applianceTypeSchema.enum.container),
  port: portInput,
  platform: z.nativeEnum(AppliancePlatform).optional().default(AppliancePlatform.LinuxAmd64),
});

export const applianceTypeFrameworkInput = applianceTypeBase.extend({
  type: z.literal(applianceTypeSchema.enum.framework),
  framework: z.string().optional().default('auto'),
  platform: z.nativeEnum(AppliancePlatform).optional().default(AppliancePlatform.LinuxAmd64),
  port: portInput.optional(),
  includes: z.array(z.string()).optional(),
  excludes: z.array(z.string()).optional(),
});

export const applianceTypeOtherInput = applianceTypeBase.extend({
  type: z.literal(applianceTypeSchema.enum.other),
});

export const applianceInput = z.discriminatedUnion('type', [
  applianceTypeContainerInput,
  applianceTypeFrameworkInput,
  applianceTypeOtherInput,
]);

export type ApplianceInput = z.infer<typeof applianceInput>;
export type Appliance = z.output<typeof applianceInput>;
export type ApplianceContainer = z.output<typeof applianceTypeContainerInput>;
export type ApplianceFrameworkApp = z.output<typeof applianceTypeFrameworkInput>;
export type ApplianceOther = z.output<typeof applianceTypeOtherInput>;
