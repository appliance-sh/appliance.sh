import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class ApplianceBase extends cdk.Stack {
  public readonly name: cdk.CfnParameter;
  public readonly domainName: cdk.CfnParameter;

  constructor(scope: Construct, id: string, props: cdk.StackProps = {}) {
    super(scope, id, props);

    this.name = new cdk.CfnParameter(this, 'name', {
      type: 'String',
      description: 'The name of the appliance stack',
      default: 'stack',
    });

    this.domainName = new cdk.CfnParameter(this, 'domainName', {
      type: 'String',
      description: 'The domain name of the appliance stack',
      default: 'appliance.sh',
    });
  }
}
