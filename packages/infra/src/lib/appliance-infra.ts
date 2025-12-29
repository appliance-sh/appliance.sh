import * as aws from '@pulumi/aws';
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
    const applianceBase = new baseController(
      `${base}`,
      { config: baseConfig.data },
      { globalProvider: baseGlobalProvider, provider: baseRegionalProvider }
    );

    applianceBases.push(applianceBase);
  }

  return { applianceBases };
}
