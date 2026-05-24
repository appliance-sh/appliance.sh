import { z } from 'zod';

export enum ApplianceBaseType {
  ApplianceAwsPublic = 'appliance-base-aws-public',
  ApplianceAwsVpc = 'appliance-base-aws-vpc',
  // Local container runtime backed by a Kubernetes cluster on the
  // developer's machine (k3d/kind/colima). Mirrors the cloud bases'
  // deploy/destroy surface but maps each appliance to a k8s
  // Deployment + Service rather than a Lambda. Used by the desktop
  // for offline / single-machine development.
  ApplianceLocal = 'appliance-base-local',
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

// Local container runtime base. `dns` is omitted because services
// are reached via host-side port forwards (`kubectl port-forward`)
// or a NodePort/Ingress published by the k3d loadbalancer — there is
// no Route 53 equivalent. `cluster` carries the bits the api-server
// needs to talk to the local kube-apiserver and pick a namespace
// for appliance workloads.
export const applianceLocalInput = applianceBaseInput.omit({ dns: true }).extend({
  type: z.literal(ApplianceBaseType.ApplianceLocal),
  cluster: z
    .object({
      // k3d cluster name. Defaults to `appliance-local` when omitted.
      // The desktop manages cluster lifecycle by this name.
      clusterName: z.string().optional(),
      // Kubernetes namespace appliances get deployed into. Auto-created
      // by the deployment service on first deploy when missing.
      namespace: z.string().optional(),
      // Host port the cluster's loadbalancer exposes (mapped to
      // service NodePorts inside the cluster). Defaults to 8081.
      hostPort: z.number().int().min(1).max(65535).optional(),
    })
    .optional(),
});

export type ApplianceLocalInput = z.infer<typeof applianceLocalInput>;

export const applianceBaseConfigInput = z.discriminatedUnion('type', [
  applianceAwsPublicInput,
  applianceAwsVpcInput,
  applianceLocalInput,
]);

export type ApplianceBaseConfigInput = z.infer<typeof applianceBaseConfigInput>;

export const applianceBaseConfig = z.object({
  name: z.string(),
  type: z.enum(ApplianceBaseType),
  // Cloud bases (aws-*) require this — Pulumi state backend URL,
  // typically `s3://<bucket>`. Local bases don't run Pulumi, so it
  // is optional at the schema level and enforced by the consumer
  // (e.g. ApplianceDeploymentService) when present.
  stateBackendUrl: z.string().optional(),
  domainName: z.string().optional(),
  // SDK version of the `@appliance.sh/infra` package that last
  // applied this base. Stamped by the infra component on every
  // `pulumi up`; surfaced via /api/v1/cluster-info so the desktop
  // can compare against its bundled version and offer a baseline
  // update. Absent for clusters bootstrapped before this field
  // was added — treat as "unknown" / "needs update."
  baselineVersion: z.string().optional(),
  // AWS-specific runtime config. Present for `appliance-base-aws-*`
  // bases. Optional at the schema level so `appliance-base-local`
  // (and any future non-AWS base) can omit it.
  aws: z
    .object({
      region: z.string(),
      zoneId: z.string(),
      cloudfrontDistributionId: z.string().optional(),
      cloudfrontDistributionDomainName: z.string().optional(),
      edgeRouterRoleArn: z.string().optional(),
      dataBucketName: z.string().optional(),
      ecrRepositoryUrl: z.string().optional(),
      // KMS key (ARN) used as the Pulumi stack secrets provider for
      // every stack the api-server creates against this base. Replaces
      // PULUMI_CONFIG_PASSPHRASE-based encryption — operator and
      // system Lambda roles authenticate to the key via IAM rather than
      // a shared passphrase.
      kmsKeyArn: z.string().optional(),
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
    })
    .optional(),
  // Local container runtime config. Present for
  // `appliance-base-local` bases. `dataDir` is an absolute path the
  // api-server uses as the filesystem object store root (replaces
  // S3 for projects/environments/deployments). `cluster` mirrors
  // the input shape; defaults are filled in by the consumer.
  local: z
    .object({
      dataDir: z.string(),
      cluster: z
        .object({
          clusterName: z.string().optional(),
          namespace: z.string().optional(),
          hostPort: z.number().int().min(1).max(65535).optional(),
        })
        .optional(),
    })
    .optional(),
});

export type ApplianceBaseConfig = z.infer<typeof applianceBaseConfig>;
