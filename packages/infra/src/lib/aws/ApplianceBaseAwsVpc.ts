import * as pulumi from '@pulumi/pulumi';
import { ApplianceBaseAwsVpcInput } from '@appliance.sh/sdk';

export type ApplianceBaseAwsVpcArgs = {
  config: ApplianceBaseAwsVpcInput;
};

export interface ApplianceBaseAwsVpcOpts extends pulumi.ComponentResourceOptions {
  globalProvider?: pulumi.ProviderResource;
}

export class ApplianceBaseAwsVpc extends pulumi.ComponentResource {
  constructor(name: string, args: ApplianceBaseAwsVpcArgs, opts?: ApplianceBaseAwsVpcOpts) {
    super('appliance-infra:appliance-base-aws-vpc', name, args, opts);
  }
}
