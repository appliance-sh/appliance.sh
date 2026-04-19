import * as aws from '@pulumi/aws';
import * as awsNative from '@pulumi/aws-native';
import * as pulumi from '@pulumi/pulumi';
import { lookup } from './controller';
import { applianceBaseConfigInput, ApplianceBaseConfigInput } from '@appliance.sh/sdk';
import { ApplianceBaseAwsPublic } from './aws/ApplianceBaseAwsPublic';
import { ApplianceBaseAwsVpc } from './aws/ApplianceBaseAwsVpc';
import { ApplianceApiServer } from './aws/ApplianceApiServer';

export interface ApplianceInfraInput {
  bases: Record<string, ApplianceBaseConfigInput>;
  enableApiServer?: boolean;
  apiServerImageUri?: pulumi.Input<string>;
  bootstrapToken?: pulumi.Input<string>;
  // Self-hosted state bucket protection. Default: protected and
  // non-force-destroy. The desktop's two-phase destroy flow flips
  // both after confirming no managed stacks remain in the backend.
  protectState?: boolean;
  forceDestroyState?: boolean;
}

export interface ApplianceInfraOutput {
  applianceBases: (ApplianceBaseAwsPublic | ApplianceBaseAwsVpc)[];
  apiServers: ApplianceApiServer[];
}

export async function applianceInfra(input: ApplianceInfraInput): Promise<ApplianceInfraOutput> {
  if (input.enableApiServer) {
    if (!input.apiServerImageUri) {
      throw new Error('apiServerImageUri is required when enableApiServer is true');
    }
    if (!input.bootstrapToken) {
      throw new Error('bootstrapToken is required when enableApiServer is true');
    }
  }

  const applianceBases: (ApplianceBaseAwsPublic | ApplianceBaseAwsVpc)[] = [];
  const apiServers: ApplianceApiServer[] = [];

  for (const baseName in input.bases) {
    const parsed = applianceBaseConfigInput.safeParse({
      ...input.bases[baseName],
      name: baseName,
    });

    if (!parsed.success) {
      throw parsed.error;
    }

    const baseConfig = parsed.data;
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

    if (input.enableApiServer && applianceBase instanceof ApplianceBaseAwsPublic) {
      const apiServer = new ApplianceApiServer(
        `${baseName}-api-server`,
        {
          imageUri: input.apiServerImageUri!,
          bootstrapToken: input.bootstrapToken!,
          stateBackendUrl: applianceBase.config.stateBackendUrl,
          baseConfig: applianceBase.config,
          stateBucketArn: applianceBase.stateBucket.arn,
          dataBucketArn: applianceBase.dataBucket.arn,
        },
        { parent: applianceBase, provider: regionalProvider }
      );
      apiServers.push(apiServer);
    }
  }

  return { applianceBases, apiServers };
}
