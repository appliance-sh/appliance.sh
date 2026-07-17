import * as aws from '@pulumi/aws';
import * as awsNative from '@pulumi/aws-native';
import { lookup } from './controller';
import { applianceBaseConfigInput, ApplianceBaseConfigInput, isDockerBase, isKubernetesBase } from '@appliance.sh/sdk';
import { ApplianceBaseAwsPublic } from './aws/ApplianceBaseAwsPublic';
import { ApplianceBaseAwsVpc } from './aws/ApplianceBaseAwsVpc';

export interface ApplianceInfraInput {
  bases: Record<string, ApplianceBaseConfigInput>;
  // Self-hosted state bucket protection. Default: protected and
  // non-force-destroy. The desktop's two-phase destroy flow flips
  // both after confirming no managed stacks remain in the backend.
  protectState?: boolean;
  forceDestroyState?: boolean;
}

export interface ApplianceInfraOutput {
  applianceBases: (ApplianceBaseAwsPublic | ApplianceBaseAwsVpc)[];
}

export async function applianceInfra(input: ApplianceInfraInput): Promise<ApplianceInfraOutput> {
  const applianceBases: (ApplianceBaseAwsPublic | ApplianceBaseAwsVpc)[] = [];

  for (const baseName in input.bases) {
    const parsed = applianceBaseConfigInput.safeParse({
      ...input.bases[baseName],
      name: baseName,
    });

    if (!parsed.success) {
      throw parsed.error;
    }

    const baseConfig = parsed.data;
    // Kubernetes-driven bases (local k3d + generic external
    // clusters) are managed by the api-server's KubernetesDeploymentService
    // directly and not by this Pulumi program — skip them here so
    // the declarative `applianceInfra({ bases })` interface can
    // still accept mixed base lists.
    if (isKubernetesBase(baseConfig)) {
      continue;
    }
    // Docker bases (the single-binary local daemon) likewise deploy
    // through their own runtime service, never through Pulumi.
    if (isDockerBase(baseConfig)) {
      continue;
    }
    const baseController = lookup(baseConfig);

    const globalProvider = new aws.Provider(`${baseName}-global-provider`, { region: 'us-east-1' });
    const regionalProvider = new aws.Provider(`${baseName}-region-provider`, { region: baseConfig.region });
    const nativeGlobalProvider = new awsNative.Provider(`${baseName}-native-global-provider`, { region: 'us-east-1' });
    const nativeRegionalProvider = new awsNative.Provider(`${baseName}-native-region-provider`, {
      region: baseConfig.region as awsNative.Region,
    });

    const applianceBase = new baseController(
      baseName,
      {
        config: baseConfig,
        stateProtect: input.protectState ?? true,
        stateForceDestroy: input.forceDestroyState ?? false,
      },
      {
        globalProvider,
        provider: regionalProvider,
        nativeProvider: nativeRegionalProvider,
        nativeGlobalProvider,
      }
    );

    applianceBases.push(applianceBase);
  }

  return { applianceBases };
}
