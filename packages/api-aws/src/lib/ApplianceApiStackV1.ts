import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class ApplianceApiStackV1 extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Define your constructs here

    // Define a Docker image asset
    const imageAsset = new cdk.aws_ecr_assets.DockerImageAsset(this, `${id}-image`, {
      directory: './docker', // Path to the directory containing the Dockerfile
    });

    // Output the ECR URI
    new cdk.CfnOutput(this, `${id}-image-uri`, {
      value: imageAsset.imageUri,
    });
  }
}
