import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import * as awsNative from '@pulumi/aws-native';
import type { ApplianceBaseConfig } from '@appliance.sh/sdk';

export interface ApplianceStackArgs {
  tags?: Record<string, string>;
  config: ApplianceBaseConfig;
}

export interface ApplianceStackOpts extends pulumi.ComponentResourceOptions {
  globalProvider: aws.Provider;
  provider: aws.Provider;
  nativeProvider: awsNative.Provider;
  nativeGlobalProvider: awsNative.Provider;
}

export class ApplianceStack extends pulumi.ComponentResource {
  lambdaRole: aws.iam.Role;
  lambdaRolePolicy: aws.iam.Policy;
  lambda: aws.lambda.Function;
  lambdaUrl: aws.lambda.FunctionUrl;
  dnsRecord: pulumi.Output<string>;

  constructor(name: string, args: ApplianceStackArgs, opts: ApplianceStackOpts) {
    super('appliance:aws:ApplianceStack', name, args, opts);

    const defaultOpts = { parent: this, provider: opts.provider };
    const defaultNativeOpts = { parent: this, provider: opts.nativeProvider };
    const defaultTags = { stack: name, managed: 'appliance', ...args.tags };

    this.lambdaRole = new aws.iam.Role(`${name}-role`, {
      path: `/appliance/${name}/`,
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: 'lambda.amazonaws.com' }),
      tags: defaultTags,
    });

    this.lambdaRolePolicy = new aws.iam.Policy(`${name}-policy`, {
      path: `/appliance/${name}/`,
      policy: {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: 'logs:CreateLogGroup', Resource: '*' }],
      },
    });

    new aws.iam.RolePolicyAttachment(`${name}-role-policy-attachment`, {
      role: this.lambdaRole.name,
      policyArn: this.lambdaRolePolicy.arn,
    });

    this.lambda = new aws.lambda.CallbackFunction(
      `${name}-handler`,
      {
        runtime: 'nodejs22.x',
        callback: async () => {
          return { statusCode: 200, body: JSON.stringify({ message: 'Hello world!' }) };
        },
        tags: defaultTags,
      },
      defaultOpts
    );

    // lambda url
    this.lambdaUrl = new aws.lambda.FunctionUrl(
      `${name}-url`,
      {
        functionName: this.lambda.name,
        authorizationType: args.config.aws.cloudfrontDistributionId ? 'AWS_IAM' : 'NONE',
      },
      defaultOpts
    );

    this.dnsRecord = pulumi.interpolate`${name}.${args.config.domainName ?? ''}`;

    if (args.config.aws.cloudfrontDistributionId) {
      new aws.lambda.Permission(
        `${name}-url-invoke-url-permission`,
        {
          function: this.lambda.name,
          action: 'lambda:InvokeFunctionUrl',
          principal: 'cloudfront.amazonaws.com',
          functionUrlAuthType: 'AWS_IAM',
          sourceArn: pulumi.interpolate`arn:aws:cloudfront::${
            aws.getCallerIdentityOutput({}, { provider: opts.provider }).accountId
          }:distribution/${args.config.aws.cloudfrontDistributionId}`,
          statementId: 'FunctionURLAllowCloudFrontAccess',
        },
        defaultOpts
      );

      // Grant the edge router role permission to invoke the Lambda Function URL
      // The edge router role is the execution role of the Lambda@Edge function that signs requests
      if (args.config.aws.edgeRouterRoleArn) {
        new aws.lambda.Permission(
          `${name}-invoke-url-edge-router-permission`,
          {
            function: this.lambda.name,
            action: 'lambda:InvokeFunctionUrl',
            principal: args.config.aws.edgeRouterRoleArn,
            functionUrlAuthType: 'AWS_IAM',
            statementId: 'FunctionURLAllowEdgeRouterRoleAccess',
          },
          defaultOpts
        );

        new awsNative.lambda.Permission(
          `${name}-invoke-edge-router-permission`,
          {
            action: 'lambda:InvokeFunction',
            principal: args.config.aws.edgeRouterRoleArn,
            functionName: this.lambda.name,
            invokedViaFunctionUrl: true,
          },
          defaultNativeOpts
        );
      }
    } else {
      new aws.lambda.Permission(
        `${name}-url-invoke-url-permission`,
        {
          function: this.lambda.name,
          action: 'lambda:InvokeFunctionUrl',
          principal: '*',
          functionUrlAuthType: 'NONE',
          statementId: 'FunctionURLAllowPublicAccess',
        },
        defaultOpts
      );
    }

    if (args.config.aws.cloudfrontDistributionId && args.config.aws.cloudfrontDistributionDomainName) {
      new awsNative.lambda.Permission(
        `${name}-url-invoke-lambda-native-permission`,
        {
          action: 'lambda:InvokeFunction',
          principal: 'cloudfront.amazonaws.com',
          sourceArn: pulumi.interpolate`arn:aws:cloudfront::${
            aws.getCallerIdentityOutput({}, { provider: opts.provider }).accountId
          }:distribution/${args.config.aws.cloudfrontDistributionId}`,
          functionName: this.lambda.name,
          invokedViaFunctionUrl: true,
        },
        defaultNativeOpts
      );

      new aws.route53.Record(
        `${name}-cname-record`,
        {
          zoneId: args.config.aws.zoneId,
          name: pulumi.interpolate`${name}.${args.config.domainName ?? ''}`,
          type: 'CNAME',
          ttl: 60,
          records: [args.config.aws.cloudfrontDistributionDomainName],
        },
        { parent: this, provider: opts.globalProvider }
      );

      new aws.route53.Record(
        `${name}-txt-record`,
        {
          zoneId: args.config.aws.zoneId,
          name: pulumi.interpolate`origin.${name}.${args.config.domainName ?? ''}`,
          type: 'TXT',
          ttl: 60,
          records: [this.lambdaUrl.functionUrl],
        },
        { parent: this, provider: opts.globalProvider }
      );
    }

    this.registerOutputs({
      lambda: this.lambda,
      lambdaUrl: this.lambdaUrl,
    });
  }
}
