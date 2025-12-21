import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

interface ApplianceApiGlobalStackV1Props extends cdk.StackProps {
  hostedZone: cdk.aws_route53.PublicHostedZone;
  functionUrl: cdk.aws_lambda.FunctionUrl;
  globalCertificate: cdk.aws_certificatemanager.Certificate;
  cfDistribution: cdk.aws_cloudfront.Distribution;
}

export class ApplianceApiGlobalStackV1 extends cdk.Stack {
  public cfDistribution;
  public cfCname;

  constructor(scope: Construct, id: string, props: ApplianceApiGlobalStackV1Props) {
    super(scope, id, props);

    if (props.hostedZone && props.functionUrl) {
      const domainName = `api.${props.hostedZone.zoneName}`;

      // check if this is the cfDistribution is actually already created using the aws sdk api
      // not using the cdk resource because it's not available in the construct library yet

      // list aws cloudfront distributions by domain name
      // const client = new CloudFrontClient({});
      // const command = new ListDistributionsCommand({});
      // const response = client.send(command).then((data) => {
      //   const existingDistribution = data.DistributionList?.Items?.find(
      //     distribution => distribution.Aliases?.Items?.includes(domainName),
      //   );
      //   return existingDistribution;
      // });
      const isFirstRun = false;

      this.cfDistribution = new cdk.aws_cloudfront.Distribution(this, `${id}-distribution`, {
        // domainNames is undefined on the first run, and only defined after the cname record is created on the next run
        domainNames: isFirstRun ? undefined : [domainName],
        certificate: props.globalCertificate,
        defaultBehavior: {
          origin: cdk.aws_cloudfront_origins.FunctionUrlOrigin.withOriginAccessControl(props.functionUrl),
        },
      });

      // const apiConnectionGroup = new cdk.aws_cloudfront.CfnConnectionGroup(this, `${id}-connection-pool`, {
      //   name: `${id}-connection-pool`,
      // })
      //
      // const apiTenant = new cdk.aws_cloudfront.CfnDistributionTenant(this, `${id}-distribution-tenant`, {
      //   distributionId: props.cfDistribution.distributionId,
      //   name: `${id}-tenant`,
      //
      //   domains: [domainName],
      //   enabled: false,
      // })

      this.cfCname = new cdk.aws_route53.CnameRecord(this, `${id}-cname`, {
        zone: props.hostedZone,
        recordName: domainName,
        domainName: props.cfDistribution.distributionDomainName,
        ttl: cdk.Duration.seconds(30),
      });
    }
  }
}
