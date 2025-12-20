import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

interface ApplianceApiStackV1Props extends cdk.StackProps {
  hostedZone: cdk.aws_route53.PublicHostedZone;
  cfDistribution: cdk.aws_cloudfront.Distribution;
  domain: string;
}

export class ApplianceApiStackV1 extends cdk.Stack {
  public apiLambda;
  public apiLambdaUrl;
  public localCertificate;

  constructor(scope: Construct, id: string, props: ApplianceApiStackV1Props) {
    super(scope, id, props);

    const stages = {
      stage1: true, // Permanent constructs, like the DNS zone, VPC, and IAM roles
      stage2: true,
      stage3: true,
    };

    const domainName = props.domain;

    if (stages.stage2) {
      const apiLambdaEcr = new cdk.aws_ecr.Repository(this, `${id}`, {
        repositoryName: `${id}`,
      });

      this.apiLambda = new cdk.aws_lambda.Function(this, `${id}-api-server`, {
        runtime: cdk.aws_lambda.Runtime.NODEJS_24_X,
        handler: 'index.handler',
        code: cdk.aws_lambda.Code.fromInline(`exports.handler = async () => "Hello ${'ap-southeast-1'}!";`),
      });

      this.apiLambdaUrl = this.apiLambda.addFunctionUrl({
        authType: cdk.aws_lambda.FunctionUrlAuthType.AWS_IAM,
      });

      // Output the ECR URI
      new cdk.CfnOutput(this, `${id}-image-uri`, {
        value: apiLambdaEcr.repositoryUri,
      });
    }

    if (stages.stage3 && props.hostedZone && this.apiLambdaUrl) {
      this.localCertificate = new cdk.aws_certificatemanager.Certificate(this, `${id}-certificate`, {
        domainName: `*.${domainName}`,
        validation: cdk.aws_certificatemanager.CertificateValidation.fromDns(props.hostedZone),
        subjectAlternativeNames: [`*.${domainName}`],
      });
    }
  }
}
