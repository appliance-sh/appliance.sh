import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';

export interface ApplianceStackArgs {
  tags?: Record<string, string>;
  cloudfrontDistributionId?: pulumi.Input<string>;
}

export interface ApplianceStackOpts extends pulumi.ComponentResourceOptions {
  globalProvider: aws.Provider;
  provider: aws.Provider;
}

export class ApplianceStack extends pulumi.ComponentResource {
  lambdaRole: aws.iam.Role;
  lambdaRolePolicy: aws.iam.Policy;
  lambda: aws.lambda.Function;
  lambdaUrl: aws.lambda.FunctionUrl;

  constructor(name: string, args: ApplianceStackArgs, opts: ApplianceStackOpts) {
    super('appliance:aws:ApplianceStack', name, args, opts);

    const defaultOpts = { parent: this, provider: opts.provider };
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
        authorizationType: args.cloudfrontDistributionId ? 'AWS_IAM' : 'NONE',
      },
      defaultOpts
    );

    if (args.cloudfrontDistributionId) {
      new aws.lambda.Permission(`${name}-url-invoke-url-permission`, {
        function: this.lambda.name,
        action: 'lambda:InvokeFunctionUrl',
        principal: 'cloudfront.amazonaws.com',
        functionUrlAuthType: 'AWS_IAM',
        sourceArn: pulumi.interpolate`arn:aws:cloudfront::${
          aws.getCallerIdentityOutput({}, { provider: opts.provider }).accountId
        }:distribution/${args.cloudfrontDistributionId}`,
        statementId: 'FunctionURLAllowCloudFrontAccess',
      });
    } else {
      new aws.lambda.Permission(`${name}-url-invoke-url-permission`, {
        function: this.lambda.name,
        action: 'lambda:InvokeFunctionUrl',
        principal: '*',
        functionUrlAuthType: 'NONE',
        statementId: 'FunctionURLAllowPublicAccess',
      });
    }

    new aws.lambda.Permission(`${name}-url-invoke-lambda-permission`, {
      function: this.lambda.name,
      action: 'lambda:InvokeFunction',
      principal: '*',
      statementId: 'FunctionURLAllowInvokeAction',
    });

    this.registerOutputs({
      lambda: this.lambda,
      lambdaUrl: this.lambdaUrl,
    });
  }
}
