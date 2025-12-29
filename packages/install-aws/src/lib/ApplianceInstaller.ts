import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class ApplianceInstaller extends cdk.Stack {
  public readonly name: cdk.CfnParameter;
  public readonly domainName: cdk.CfnParameter;
  public readonly state: cdk.aws_s3.Bucket;

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

    this.state = new cdk.aws_s3.Bucket(this, `state`, {
      encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
      bucketKeyEnabled: true,
      blockPublicAccess: cdk.aws_s3.BlockPublicAccess.BLOCK_ALL,
    });
  }
}
