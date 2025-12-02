import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class ApplianceApiStackV1 extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Define your constructs here

    const imageRepository = new cdk.aws_ecr.Repository(this, `${id}`, {
      repositoryName: `${id}`,
    });

    // Output the ECR URI
    new cdk.CfnOutput(this, `${id}-image-uri`, {
      value: imageRepository.repositoryUri,
    });
  }
}
