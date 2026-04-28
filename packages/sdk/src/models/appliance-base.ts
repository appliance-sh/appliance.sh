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
  domainName: z.string().optional(),
  aws: z.object({
    region: z.string(),
    zoneId: z.string(),
    cloudfrontDistributionId: z.string().optional(),
    cloudfrontDistributionDomainName: z.string().optional(),
    edgeRouterRoleArn: z.string().optional(),
    dataBucketName: z.string().optional(),
    ecrRepositoryUrl: z.string().optional(),
    // Pre-created Lambda execution roles for the system api-server and
    // worker appliances. The dogfooded bootstrap deploys those two
    // appliances using these ARNs instead of letting ApplianceStack
    // mint a fresh role per deploy — they need broader IAM than user
    // workloads (Pulumi automation, ECR push, S3 state read/write).
    systemRoleArns: z
      .object({
        apiServer: z.string(),
        worker: z.string(),
      })
      .optional(),
  }),
});

export type ApplianceBaseConfig = z.infer<typeof applianceBaseConfig>;
