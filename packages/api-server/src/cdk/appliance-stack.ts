import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class ApplianceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Simple dummy resource: S3 bucket with a stable logical ID
    const bucket = new cdk.aws_s3.Bucket(this, 'DummyBucket', {
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      // autoDeleteObjects: true,
    });

    const lambdaUrl = new cdk.aws_lambda.Function(this, 'DummyLambda', {
      runtime: cdk.aws_lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => "Hello World!";'),
    });

    const fnUrl = lambdaUrl.addFunctionUrl({
      authType: cdk.aws_lambda.FunctionUrlAuthType.AWS_IAM,
    });

    const fnDistribution = new cdk.aws_cloudfront.Distribution(this, 'DummyDistribution', {
      defaultBehavior: {
        origin: cdk.aws_cloudfront_origins.FunctionUrlOrigin.withOriginAccessControl(fnUrl),
      },
    });

    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'FunctionUrl', { value: fnUrl.url });
    new cdk.CfnOutput(this, 'Distribution', { value: fnDistribution.distributionDomainName });
  }
}
