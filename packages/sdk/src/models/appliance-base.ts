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
  // Generic Kubernetes base: api-server drives an arbitrary k8s
  // cluster identified by URL + credentials. Same machinery as
  // ApplianceLocal under the hood, but without the desktop-managed
  // k3d lifecycle assumptions — connection details are explicit
  // rather than discovered from the host's default kubeconfig.
  ApplianceKubernetes = 'appliance-base-kubernetes',
}

// True for any base whose deploys go through the Kubernetes API
// client (KubernetesDeploymentService), rather than Pulumi. Use
// this to gate branches that are about "is this a k8s-driven base"
// rather than "is this specifically the k3d-on-developer-laptop
// base." Doubles as a TypeScript type guard: callers that pass a
// discriminated-union value get the union narrowed to the k8s
// variants on the truthy branch and the non-k8s variants on the
// falsy branch.
export function isKubernetesBase<T extends { type: ApplianceBaseType }>(
  config: T
): config is T & { type: ApplianceBaseType.ApplianceLocal | ApplianceBaseType.ApplianceKubernetes } {
  return config.type === ApplianceBaseType.ApplianceLocal || config.type === ApplianceBaseType.ApplianceKubernetes;
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

// Generic Kubernetes base. The caller supplies enough to construct a
// `@kubernetes/client-node` KubeConfig and the api-server takes it
// from there. Exactly one of `token` (with optional `ca` + required
// `server`) or `kubeconfig` (inline YAML) must be supplied — when
// running in-cluster, both can be omitted and the api-server will
// fall back to `kc.loadFromCluster()`.
export const applianceKubernetesInput = applianceBaseInput.omit({ dns: true }).extend({
  type: z.literal(ApplianceBaseType.ApplianceKubernetes),
  kubernetes: z.object({
    // https://kube.example.com:6443. Required when authenticating
    // with a bearer token. Omit when supplying `kubeconfig` or
    // relying on in-cluster discovery.
    server: z.string().optional(),
    // base64-encoded CA bundle for the apiserver's TLS cert.
    ca: z.string().optional(),
    // ServiceAccount bearer token. Mutex with `kubeconfig`.
    token: z.string().optional(),
    // Inline kubeconfig YAML. Mutex with `server`/`token`.
    kubeconfig: z.string().optional(),
    // Namespace appliances deploy into. Defaults to `appliance`.
    namespace: z.string().optional(),
    // DNS suffix appended to per-appliance Ingress hostnames
    // (`<stackName>.<suffix>`). No default — operators must supply
    // a routable suffix for the cluster (e.g. `apps.example.com`).
    hostnameSuffix: z.string().optional(),
    // Ingress controller class. Cluster-dependent; common values
    // are `nginx`, `traefik`, `alb`.
    ingressClassName: z.string().optional(),
    // Host-side port the cluster's ingress/LB is reachable on from
    // the operator's machine — used only to compose the URLs reported
    // back from deploys (`http://<host>[:<hostPort>]`). Defaults to
    // 80 (a directly-routable cluster); the desktop-managed k3d
    // runtime publishes its serverlb on 8081 and sets this.
    hostPort: z.number().int().min(1).max(65535).optional(),
    // Path mounted into the api-server pod that backs the
    // FilesystemObjectStore. Typically a PVC mount such as `/data`.
    dataDir: z.string(),
    // Optional registry hint. When set, builds may tag/push images
    // here before triggering a deploy — leaves the deploy itself
    // pointing at the resulting `<registry.url>/<image>` reference.
    registry: z
      .object({
        url: z.string(),
        insecure: z.boolean().optional(),
      })
      .optional(),
  }),
});

export type ApplianceKubernetesInput = z.infer<typeof applianceKubernetesInput>;

export const applianceBaseConfigInput = z.discriminatedUnion('type', [
  applianceAwsPublicInput,
  applianceAwsVpcInput,
  applianceLocalInput,
  applianceKubernetesInput,
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
          // DNS suffix appended to each deploy's hostname to form
          // `<stackName>.<suffix>` Ingress routes. Defaults to
          // `appliance.localhost` — `.localhost` is RFC 6761
          // reserved and auto-resolves to 127.0.0.1 in every modern
          // browser + OS resolver, so no /etc/hosts setup is needed.
          // Override to `appliance.local` or your own domain for
          // setups that route via custom DNS.
          hostnameSuffix: z.string().optional(),
          // Ingress class the per-appliance Ingress declares.
          // Defaults to k3s/k3d's built-in `traefik` controller.
          // Override for clusters that swapped in nginx-ingress or
          // similar.
          ingressClassName: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  // Generic Kubernetes runtime config. Present for
  // `appliance-base-kubernetes` bases. Same role as `local` but the
  // cluster connection is explicit (server URL + credentials or an
  // inline kubeconfig) rather than discovered from the host's
  // default kubeconfig. Omit all of `server`, `kubeconfig`, and
  // `token` to fall back to `kc.loadFromCluster()` when running
  // inside a pod with a mounted ServiceAccount.
  kubernetes: z
    .object({
      server: z.string().optional(),
      ca: z.string().optional(),
      token: z.string().optional(),
      kubeconfig: z.string().optional(),
      namespace: z.string().optional(),
      hostnameSuffix: z.string().optional(),
      ingressClassName: z.string().optional(),
      // Host-side ingress/LB port for reported URLs. See the input
      // schema's field of the same name.
      hostPort: z.number().int().min(1).max(65535).optional(),
      dataDir: z.string(),
      registry: z
        .object({
          url: z.string(),
          insecure: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
});

export type ApplianceBaseConfig = z.infer<typeof applianceBaseConfig>;

/**
 * Common Kubernetes deploy parameters extracted from either an
 * `appliance-base-local` or `appliance-base-kubernetes` config.
 * Returns null for non-Kubernetes bases (AWS). `dataDir` is required
 * for both variants; the other fields fall back to consumer-side
 * defaults when undefined.
 */
export function getKubernetesParams(config: ApplianceBaseConfig): {
  dataDir: string;
  namespace?: string;
  hostnameSuffix?: string;
  ingressClassName?: string;
} | null {
  if (config.type === ApplianceBaseType.ApplianceLocal) {
    if (!config.local) return null;
    return {
      dataDir: config.local.dataDir,
      namespace: config.local.cluster?.namespace,
      hostnameSuffix: config.local.cluster?.hostnameSuffix,
      ingressClassName: config.local.cluster?.ingressClassName,
    };
  }
  if (config.type === ApplianceBaseType.ApplianceKubernetes) {
    if (!config.kubernetes) return null;
    return {
      dataDir: config.kubernetes.dataDir,
      namespace: config.kubernetes.namespace,
      hostnameSuffix: config.kubernetes.hostnameSuffix,
      ingressClassName: config.kubernetes.ingressClassName,
    };
  }
  return null;
}
