import { z } from 'zod';

export enum ApplianceBaseType {
  ApplianceAwsPublic = 'appliance-base-aws-public',
  ApplianceAwsVpc = 'appliance-base-aws-vpc',
}

export const applianceBaseInput = z.object({
  name: z.string(),
  dns: z.object({
    domainName: z.string(),
    createZone: z.boolean().optional().default(true),
    attachZone: z.boolean().optional().default(true),
  }),
});

export const applianceBaseAwsInput = applianceBaseInput.extend({
  region: z.string(),
});

export const applianceAwsPublicInput = applianceBaseAwsInput.extend({
  type: z.literal(ApplianceBaseType.ApplianceAwsPublic),
});

export type ApplianceBaseAwsPublicInput = z.infer<typeof applianceAwsPublicInput>;

export const applianceAwsVpcInput = applianceBaseAwsInput.extend({
  type: z.literal(ApplianceBaseType.ApplianceAwsVpc),
  vpc: z.union([
    z.object({
      vpcCidr: z.string(),
      numberOfAzs: z.number().int().min(1).max(3),
    }),
    z.object({
      vpcId: z.string(),
    }),
  ]),
});

export type ApplianceBaseAwsVpcInput = z.infer<typeof applianceAwsVpcInput>;

export const applianceBaseConfigInput = z.discriminatedUnion('type', [applianceAwsPublicInput, applianceAwsVpcInput]);

export type ApplianceBaseConfigInput = z.infer<typeof applianceBaseConfigInput>;

export const applianceBaseConfig = z.object({
  name: z.string(),
  type: z.enum(ApplianceBaseType),
  stateBackendUrl: z.string(),
  aws: z.object({
    region: z.string(),
    cloudfrontDistributionId: z.string().optional(),
  }),
});

export type ApplianceBaseConfig = z.infer<typeof applianceBaseConfig>;
