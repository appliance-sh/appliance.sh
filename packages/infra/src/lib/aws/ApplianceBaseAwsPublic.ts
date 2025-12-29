import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import { ApplianceBaseAwsPublicInput } from '@appliance.sh/sdk';

export type ApplianceBaseAwsPublicArgs = {
  config: ApplianceBaseAwsPublicInput;
};

export interface ApplianceBaseAwsPublicOpts extends pulumi.ComponentResourceOptions {
  globalProvider?: pulumi.ProviderResource;
}

export class ApplianceBaseAwsPublic extends pulumi.ComponentResource {
  public readonly zoneId?: pulumi.Output<string>;
  public readonly zone?: aws.route53.Zone;
  constructor(name: string, args: ApplianceBaseAwsPublicArgs, opts?: ApplianceBaseAwsPublicOpts) {
    super('appliance-infra:appliance-base-aws-public', name, args, opts);

    if (args.config.dns.createZone) {
      this.zone = new aws.route53.Zone(
        `${name}-zone`,
        {
          name: args.config.dns.domainName,
        },
        { parent: this, provider: opts?.globalProvider }
      );

      this.zoneId = this.zone.zoneId;
    }
  }
}
