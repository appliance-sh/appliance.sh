import * as aws from '@pulumi/aws';
import * as awsNative from '@pulumi/aws-native';
import * as pulumi from '@pulumi/pulumi';
import { lookup } from './controller';
import { applianceBaseConfigInput } from '@appliance.sh/sdk';
import { ApplianceBaseAwsPublic } from './aws/ApplianceBaseAwsPublic';
import { ApplianceBaseAwsVpc } from './aws/ApplianceBaseAwsVpc';
import { ApplianceBaseConfigInput } from '@appliance.sh/sdk';

const name = 'appliance-infra';

export async function applianceInfra() {
  const applianceConfig = new pulumi.Config(name);
  const bases = applianceConfig.requireObject<Record<string, ApplianceBaseConfigInput>>('bases');

  const applianceBases: (ApplianceBaseAwsPublic | ApplianceBaseAwsVpc)[] = [];
  for (const base in bases) {
    const baseConfig = applianceBaseConfigInput.safeParse({
      ...bases[base],
      name: base,
    });

    if (!baseConfig.success) {
      throw baseConfig.error;
    }

    const baseController = lookup(baseConfig.data);

    const baseGlobalProvider = new aws.Provider(`${base}-global-provider`, { region: 'us-east-1' });
    const baseRegionalProvider = new aws.Provider(`${base}-region-provider`, { region: baseConfig.data.region });

    const baseNativeGlobalProvider = new awsNative.Provider(`${base}-native-global-provider`, { region: 'us-east-1' });
    const baseNativeRegionalProvider = new awsNative.Provider(`${base}-native-region-provider`, {
      region: baseConfig.data.region as awsNative.Region,
    });
    const applianceBase = new baseController(
      `${base}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { config: baseConfig.data },
      {
        globalProvider: baseGlobalProvider,
        provider: baseRegionalProvider,
        nativeProvider: baseNativeRegionalProvider,
        nativeGlobalProvider: baseNativeGlobalProvider,
      }
    );

    applianceBases.push(applianceBase);
  }

  return { applianceBases };
}
