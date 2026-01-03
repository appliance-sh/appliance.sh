import * as pulumi from '@pulumi/pulumi';
import { ApplianceBaseConfigInput, ApplianceBaseType } from '@appliance.sh/sdk';

export type ApplianceBaseAwsVpcArgs = {
  config: ApplianceBaseConfigInput;
};

export interface ApplianceBaseAwsVpcOpts extends pulumi.ComponentResourceOptions {
  globalProvider?: pulumi.ProviderResource;
  nativeProvider?: pulumi.ProviderResource;
  nativeGlobalProvider?: pulumi.ProviderResource;
}

export class ApplianceBaseAwsVpc extends pulumi.ComponentResource {
  constructor(name: string, args: ApplianceBaseAwsVpcArgs, opts?: ApplianceBaseAwsVpcOpts) {
    super('appliance-infra:appliance-base-aws-vpc', name, args, opts);

    if (args.config.type !== ApplianceBaseType.ApplianceAwsVpc) {
      throw new Error('Invalid config');
    }
  }
}
