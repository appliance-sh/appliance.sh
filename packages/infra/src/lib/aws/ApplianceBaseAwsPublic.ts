import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';

import { ApplianceBaseConfigInput, ApplianceBaseType } from '@appliance.sh/sdk';

export type ApplianceBaseAwsPublicArgs = {
  config: ApplianceBaseConfigInput;
};

export interface ApplianceBaseAwsPublicOpts extends pulumi.ComponentResourceOptions {
  globalProvider?: pulumi.ProviderResource;
  nativeProvider?: pulumi.ProviderResource;
  nativeGlobalProvider?: pulumi.ProviderResource;
}

export class ApplianceBaseAwsPublic extends pulumi.ComponentResource {
  public readonly zoneId: pulumi.Output<string>;
  public readonly zone?: aws.route53.Zone;
  public readonly globalCert?: aws.acm.Certificate;
  public readonly certificateArn?: pulumi.Output<string>;
  public readonly cloudfrontDistribution?: aws.cloudfront.Distribution;

  public readonly config;

  constructor(name: string, args: ApplianceBaseAwsPublicArgs, opts?: ApplianceBaseAwsPublicOpts) {
    super('appliance-infra:appliance-base-aws-public', name, args, opts);

    if (args.config.type !== ApplianceBaseType.ApplianceAwsPublic) {
      throw new Error('Invalid config');
    }

    if (args.config.dns.createZone) {
      this.zone = new aws.route53.Zone(
        `${name}-zone`,
        {
          name: args.config.dns.domainName,
        },
        { parent: this, provider: opts?.globalProvider }
      );

      this.zoneId = this.zone.zoneId;
    } else {
      this.zoneId = aws.route53.getZoneOutput({
        name: args.config.dns.domainName,
      }).id;
    }

    const wildcardDomain = `*.${args.config.dns.domainName}`;
    const createCertificate = true;
    if (createCertificate) {
      this.globalCert = new aws.acm.Certificate(
        `${name}-global-certificate`,
        {
          domainName: wildcardDomain,
          subjectAlternativeNames: [wildcardDomain],
          validationMethod: 'DNS',
          region: 'us-east-1',
        },
        { parent: this, provider: opts?.globalProvider }
      );

      const globalCertValidationRecords = this.globalCert.domainValidationOptions.apply((certValOpts) => {
        return certValOpts.map((certValOpt, idx) => {
          return new aws.route53.Record(
            `${name}-global-cert-val-${idx}`,
            {
              zoneId: this.zoneId,
              name: certValOpt.resourceRecordName,
              type: certValOpt.resourceRecordType,
              records: [certValOpt.resourceRecordValue],
              ttl: 60,
            },
            { parent: this, provider: opts?.globalProvider }
          );
        });
      });

      new aws.acm.CertificateValidation(
        `${name}-global-cert-validation`,
        {
          region: 'us-east-1',
          validationRecordFqdns: globalCertValidationRecords.apply((records) => records.map((record) => record.fqdn)),
          certificateArn: this.globalCert.arn,
        },
        { parent: this, provider: opts?.globalProvider }
      );

      this.certificateArn = this.globalCert.arn;
    } else {
      this.certificateArn = aws.acm.getCertificateOutput(
        {
          region: 'us-east-1',
          domain: wildcardDomain,
        },
        { parent: this, provider: opts?.globalProvider }
      ).arn;
    }

    const state = new aws.s3.Bucket(
      `${name}-state`,
      {
        acl: 'private',
        forceDestroy: true,
      },
      { parent: this, provider: opts?.provider }
    );

    new aws.s3.BucketVersioning(
      `${name}-state-versioning`,
      {
        bucket: state.bucket,
        versioningConfiguration: { status: 'Enabled' },
      },
      { parent: this, provider: opts?.provider }
    );

    new aws.s3.BucketServerSideEncryptionConfiguration(
      `${name}-state-sse`,
      {
        bucket: state.bucket,
        rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: 'AES256' } }],
      },
      { parent: this, provider: opts?.provider }
    );

    const lambdaOrigin = new aws.lambda.CallbackFunction(
      `${name}-origin`,
      {
        name: `${name}-origin`.replaceAll('.', '-'),
        runtime: 'nodejs22.x',
        callback: async () => {
          const result = {
            message: 'Hello world!',
            time: new Date().toISOString(),
          };
          return { statusCode: 200, body: JSON.stringify(result) };
        },
      },
      { parent: this, provider: opts?.provider }
    );

    const lambdaOriginFunctionUrl = new aws.lambda.FunctionUrl(
      `${name}-origin-url`,
      {
        functionName: lambdaOrigin.name,
        authorizationType: 'AWS_IAM',
        invokeMode: 'BUFFERED',
        cors: {
          allowCredentials: true,
          allowOrigins: [`https://api.${args.config.dns.domainName}`],
          allowMethods: ['GET', 'POST'],
          allowHeaders: ['date', 'keep-alive'],
          exposeHeaders: ['keep-alive', 'date'],
          maxAge: 60,
        },
        region: 'ap-southeast-1',
      },
      { parent: this, provider: opts?.provider }
    );

    const lambdaOac = new aws.cloudfront.OriginAccessControl(
      `${name}-origin-access-control`,
      {
        name: 'MyLambdaOAC',
        originAccessControlOriginType: 'lambda',
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
      },
      { parent: this, provider: opts?.globalProvider }
    );

    const edgeRouterRole = new aws.iam.Role(
      `${name}-edge-router-role`,
      {
        assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
          Service: ['lambda.amazonaws.com', 'edgelambda.amazonaws.com'],
        }),
      },
      { parent: this, provider: opts?.globalProvider }
    );

    new aws.iam.RolePolicyAttachment(
      `${name}-edge-router-role-logging`,
      {
        role: edgeRouterRole.name,
        policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
      },
      { parent: this, provider: opts?.globalProvider }
    );

    const edgeFunction = new aws.lambda.CallbackFunction(
      `${name.replaceAll('.', '-')}-edge-router`,
      {
        role: edgeRouterRole,
        runtime: 'nodejs22.x',
        timeout: 5,
        publish: true,
        loggingConfig: {
          logGroup: `/appliance/base/${name}/edge-router-logs`,
          logFormat: 'Text',
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        callback: async (event: any) => {
          const request = event.Records[0].cf.request;
          const headers = request.headers;
          const host = headers.host[0].value;

          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const dns = require('dns').promises;

          let originUrl: URL;
          try {
            const txtRecords = await dns.resolveTxt(`origin.${host}`);
            const functionUrl = txtRecords[0][0];
            originUrl = new URL(functionUrl);
          } catch (e) {
            console.error(`Failed to resolve TXT record for origin.${host}`, e);
            originUrl = new URL(lambdaOriginFunctionUrl.functionUrl.get());
          }

          request.origin = {
            custom: {
              domainName: originUrl.hostname,
              port: 443,
              protocol: 'https',
              path: request.path,
              sslProtocols: ['TLSv1', 'TLSv1.1', 'TLSv1.2'],
              readTimeout: 30,
              keepaliveTimeout: 5,
              customHeaders: {},
            },
          };
          request.headers['host'] = [{ key: 'host', value: originUrl.hostname }];
          request.headers['X-Forwarded-Host'] = [{ key: 'X-Forwarded-Host', value: host }];

          return request;
        },
      },
      { parent: this, provider: opts?.globalProvider }
    );

    new aws.lambda.Permission(
      `${name}-edge-router-invoke-url-permission`,
      {
        function: edgeFunction.name,
        action: 'lambda:InvokeFunction',
        principal: 'edgelambda.amazonaws.com',
        statementId: 'AllowExecutionFromCloudFront',
      },
      { parent: this, provider: opts?.globalProvider }
    );

    const distributionLogs = new aws.cloudwatch.LogGroup(
      `${name}-distribution-logs`,
      {
        name: pulumi.interpolate`/appliance/base/${name}/distribution-logs`,
        retentionInDays: 7,
      },
      { parent: this, provider: opts?.globalProvider }
    );

    const distributionDeliveryDestination = new aws.cloudwatch.LogDeliveryDestination(
      `${name.replace('.', '-')}-distribution-delivery-destination`,
      {
        outputFormat: 'json',
        deliveryDestinationType: 'CWL',
        deliveryDestinationConfiguration: {
          destinationResourceArn: distributionLogs.arn,
        },
      },
      { parent: this, provider: opts?.globalProvider }
    );

    this.cloudfrontDistribution = new aws.cloudfront.Distribution(
      `${name}-distribution`,
      {
        defaultCacheBehavior: {
          cachePolicyId: aws.cloudfront
            .getCachePolicyOutput(
              { name: 'Managed-CachingDisabled' },
              {
                parent: this,
                provider: opts?.globalProvider,
              }
            )
            .apply((res) => res.id ?? ''),
          originRequestPolicyId: aws.cloudfront
            .getOriginRequestPolicyOutput(
              { name: 'Managed-AllViewer' },
              {
                parent: this,
                provider: opts?.globalProvider,
              }
            )
            .apply((res) => res.id ?? ''),
          allowedMethods: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
          cachedMethods: ['GET', 'HEAD'],
          targetOriginId: 'LambdaOrigin',
          viewerProtocolPolicy: 'redirect-to-https',
          lambdaFunctionAssociations: [
            {
              eventType: 'origin-request',
              lambdaArn: edgeFunction.qualifiedArn,
              includeBody: true,
            },
          ],
        },
        origins: [
          {
            originId: 'LambdaOrigin',
            domainName: lambdaOriginFunctionUrl.functionUrl.apply((url) => new URL(url).hostname),
            originAccessControlId: lambdaOac.id,
            customOriginConfig: {
              httpPort: 80,
              httpsPort: 443,
              originProtocolPolicy: 'https-only',
              originSslProtocols: ['TLSv1', 'TLSv1.1', 'TLSv1.2'],
            },
          },
        ],
        restrictions: { geoRestriction: { restrictionType: 'none' } },
        viewerCertificate: {
          acmCertificateArn: this.certificateArn,
          sslSupportMethod: 'sni-only',
          minimumProtocolVersion: 'TLSv1',
        },
        enabled: true,
        aliases: [wildcardDomain],
      },
      { parent: this, provider: opts?.globalProvider }
    );

    const distributionDeliverySource = new aws.cloudwatch.LogDeliverySource(
      `${name.replace('.', '-')}-distribution-delivery-source`,
      {
        region: 'us-east-1',
        logType: 'ACCESS_LOGS',
        resourceArn: this.cloudfrontDistribution.arn,
      },
      { parent: this, provider: opts?.globalProvider }
    );

    new aws.cloudwatch.LogDelivery(
      `${name.replace('.', '-')}-distribution-logging`,
      {
        region: 'us-east-1',
        deliverySourceName: distributionDeliverySource.name,
        deliveryDestinationArn: distributionDeliveryDestination.arn,
      },
      { parent: this, provider: opts?.globalProvider }
    );

    new aws.route53.Record(
      `${name}-wildcard-cloudfront-record`,
      {
        name: wildcardDomain,
        zoneId: this.zoneId,
        type: 'CNAME',
        records: [this.cloudfrontDistribution.domainName],
        ttl: 60,
      },
      { parent: this, provider: opts?.globalProvider }
    );

    this.config = {
      name: name,
      stateBackendUrl: pulumi.interpolate`s3://${state.bucket}`,
      domainName: args.config.dns.domainName,
      type: ApplianceBaseType.ApplianceAwsPublic,
      aws: {
        region: args.config.region,
        zoneId: this.zoneId,
        cloudfrontDistributionId: this.cloudfrontDistribution.id,
        cloudfrontDistributionDomainName: this.cloudfrontDistribution.domainName,
      },
    };

    new aws.ssm.Parameter(
      `${name}-base-config`,
      {
        name: `/appliance/base/${name}/config`,
        type: 'SecureString',
        value: pulumi.jsonStringify(this.config),
      },
      { parent: this, provider: opts?.provider }
    );

    this.registerOutputs(this.config);
  }
}
