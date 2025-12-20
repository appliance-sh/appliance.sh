import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface ApplianceGlobalStackV1Props extends cdk.StackProps {
  domain: string;
}

export class ApplianceGlobalStackV1 extends cdk.Stack {
  public hostedZone;
  public apiLambda;
  public apiLambdaUrl;
  public globalCertificate;
  public cfDistribution;

  constructor(scope: Construct, id: string, props: ApplianceGlobalStackV1Props) {
    super(scope, id, props);

    const stages = {
      stage1: true, // Permanent constructs, like the DNS zone, VPC, and IAM roles
      stage2: true,
      stage3: true,
      stage4: true,
    };

    const domainName = props.domain;

    if (stages.stage1) {
      this.hostedZone = new cdk.aws_route53.PublicHostedZone(this, `${id}-zone`, {
        zoneName: domainName,
      });

      new cdk.CfnOutput(this, `${id}-zone-name`, {
        value: this.hostedZone.zoneName,
      });
    }

    if (stages.stage2 && this.hostedZone) {
      this.globalCertificate = new cdk.aws_certificatemanager.Certificate(this, `${id}-certificate`, {
        domainName: `*.${domainName}`,
        validation: cdk.aws_certificatemanager.CertificateValidation.fromDns(this.hostedZone),
        subjectAlternativeNames: [`*.${domainName}`],
      });
    }

    if (stages.stage3 && this.globalCertificate) {
      this.apiLambda = new cdk.aws_lambda.Function(this, `${id}-api-server`, {
        runtime: cdk.aws_lambda.Runtime.NODEJS_24_X,
        handler: 'index.handler',
        code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => "Hello World!";'),
      });

      this.apiLambdaUrl = this.apiLambda.addFunctionUrl({
        authType: cdk.aws_lambda.FunctionUrlAuthType.AWS_IAM,
      });

      this.cfDistribution = new cdk.aws_cloudfront.Distribution(this, `${id}-distribution`, {
        domainNames: [`*.${domainName}`],
        certificate: this.globalCertificate,
        defaultBehavior: {
          origin: cdk.aws_cloudfront_origins.FunctionUrlOrigin.withOriginAccessControl(this.apiLambdaUrl),
        },
      });

      new cdk.CfnOutput(this, `${id}-distribution-domain`, { value: this.cfDistribution.distributionDomainName });
    }

    if (stages.stage4 && this.hostedZone && this.cfDistribution) {
      new cdk.aws_route53.CnameRecord(this, `${id}-cname`, {
        zone: this.hostedZone,
        recordName: `*.${domainName}`,
        domainName: this.cfDistribution.distributionDomainName,
        ttl: cdk.Duration.seconds(30),
      });
    }
  }
}
