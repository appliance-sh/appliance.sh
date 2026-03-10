import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import * as awsNative from '@pulumi/aws-native';
import type { ApplianceBaseConfig } from '@appliance.sh/sdk';
import { createHash } from 'crypto';

// AWS resource name limits (IAM roles, Lambda functions) are 64 chars.
// Pulumi appends an 8-char suffix (-xxxxxxx). The longest resource
// suffix we add is "-handler" (8 chars). Budget: 64 - 8 - 8 = 48.
const MAX_RESOURCE_ID_LENGTH = 48;

// DNS labels (each segment between dots) are limited to 63 chars.
const MAX_DNS_LABEL_LENGTH = 63;

function truncateWithHash(name: string, maxLength: number): string {
  if (name.length <= maxLength) return name;
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 7);
  return `${name.slice(0, maxLength - 8)}-${hash}`;
}

/**
 * Derive a short, deterministic resource ID from a stack name.
 * If the name fits within the limit it is returned as-is.
 * Otherwise it is truncated and a 7-char hash suffix is appended
 * to preserve uniqueness.
 */
export function toResourceId(name: string): string {
  return truncateWithHash(name, MAX_RESOURCE_ID_LENGTH);
}

/**
 * Derive a DNS-safe label from a stack name (max 63 chars).
 */
export function toDnsLabel(name: string): string {
  return truncateWithHash(name, MAX_DNS_LABEL_LENGTH);
}

export interface ApplianceStackMetadata {
  projectId: string;
  projectName: string;
  environmentId: string;
  environmentName: string;
  deploymentId: string;
  stackName: string;
}

export interface ApplianceStackArgs {
  metadata?: ApplianceStackMetadata;
  config: ApplianceBaseConfig;
  imageUri?: string;
  codeS3Key?: string;
  runtime?: string;
  handler?: string;
  layers?: string[];
  architectures?: string[];
  environment?: Record<string, string>;
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

    // Short ID for AWS resource names (subject to 64-char limits)
    const rid = toResourceId(name);
    // DNS-safe label (max 63 chars per label)
    const dnsLabel = toDnsLabel(name);

    const defaultOpts = { parent: this, provider: opts.provider };
    const defaultNativeOpts = { parent: this, provider: opts.nativeProvider };
    const defaultTags: Record<string, string> = {
      'appliance:managed': 'true',
      'appliance:stack-name': name,
    };
    if (args.metadata) {
      defaultTags['appliance:project-id'] = args.metadata.projectId;
      defaultTags['appliance:project-name'] = args.metadata.projectName;
      defaultTags['appliance:environment-id'] = args.metadata.environmentId;
      defaultTags['appliance:environment-name'] = args.metadata.environmentName;
      defaultTags['appliance:deployment-id'] = args.metadata.deploymentId;
    }

    this.lambdaRole = new aws.iam.Role(`${rid}-role`, {
      path: `/appliance/${name}/`,
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: 'lambda.amazonaws.com' }),
      tags: defaultTags,
    });

    const policyStatements = [
      { Effect: 'Allow' as const, Action: 'logs:CreateLogGroup', Resource: '*' },
      { Effect: 'Allow' as const, Action: 'logs:CreateLogStream', Resource: '*' },
      { Effect: 'Allow' as const, Action: 'logs:PutLogEvents', Resource: '*' },
    ];

    if (args.imageUri) {
      policyStatements.push(
        {
          Effect: 'Allow' as const,
          Action: 'ecr:GetDownloadUrlForLayer',
          Resource: '*',
        },
        {
          Effect: 'Allow' as const,
          Action: 'ecr:BatchGetImage',
          Resource: '*',
        },
        {
          Effect: 'Allow' as const,
          Action: 'ecr:BatchCheckLayerAvailability',
          Resource: '*',
        },
        {
          Effect: 'Allow' as const,
          Action: 'ecr:GetAuthorizationToken',
          Resource: '*',
        }
      );
    }

    if (args.codeS3Key && args.config.aws.dataBucketName) {
      policyStatements.push({
        Effect: 'Allow' as const,
        Action: 's3:GetObject',
        Resource: `arn:aws:s3:::${args.config.aws.dataBucketName}/${args.codeS3Key}`,
      });
    }

    this.lambdaRolePolicy = new aws.iam.Policy(`${rid}-policy`, {
      path: `/appliance/${name}/`,
      policy: {
        Version: '2012-10-17',
        Statement: policyStatements,
      },
    });

    new aws.iam.RolePolicyAttachment(`${rid}-role-policy-attachment`, {
      role: this.lambdaRole.name,
      policyArn: this.lambdaRolePolicy.arn,
    });

    if (args.imageUri) {
      this.lambda = new aws.lambda.Function(
        `${rid}-handler`,
        {
          packageType: 'Image',
          imageUri: args.imageUri,
          role: this.lambdaRole.arn,
          timeout: 30,
          memorySize: 512,
          tags: defaultTags,
        },
        defaultOpts
      );
    } else if (args.codeS3Key && args.config.aws.dataBucketName) {
      this.lambda = new aws.lambda.Function(
        `${rid}-handler`,
        {
          packageType: 'Zip',
          runtime: args.runtime ?? 'nodejs22.x',
          handler: args.handler ?? 'index.handler',
          s3Bucket: args.config.aws.dataBucketName,
          s3Key: args.codeS3Key,
          role: this.lambdaRole.arn,
          timeout: 30,
          memorySize: 512,
          layers: args.layers,
          architectures: args.architectures,
          environment: args.environment ? { variables: args.environment } : undefined,
          tags: defaultTags,
        },
        defaultOpts
      );
    } else {
      this.lambda = new aws.lambda.CallbackFunction(
        `${rid}-handler`,
        {
          runtime: 'nodejs22.x',
          callback: async () => {
            return { statusCode: 200, body: JSON.stringify({ message: 'Hello world!' }) };
          },
          tags: defaultTags,
        },
        defaultOpts
      );
    }

    // lambda url
    this.lambdaUrl = new aws.lambda.FunctionUrl(
      `${rid}-url`,
      {
        functionName: this.lambda.name,
        authorizationType: args.config.aws.cloudfrontDistributionId ? 'AWS_IAM' : 'NONE',
      },
      defaultOpts
    );

    // DNS uses the full stack name, not the truncated resource ID
    this.dnsRecord = pulumi.interpolate`${dnsLabel}.${args.config.domainName ?? ''}`;

    if (args.config.aws.cloudfrontDistributionId) {
      new aws.lambda.Permission(
        `${rid}-cf-invoke-url`,
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
          `${rid}-edge-invoke-url`,
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
          `${rid}-edge-invoke`,
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
        `${rid}-public-invoke-url`,
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
        `${rid}-cf-invoke`,
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
        `${rid}-cname`,
        {
          zoneId: args.config.aws.zoneId,
          name: pulumi.interpolate`${dnsLabel}.${args.config.domainName ?? ''}`,
          type: 'CNAME',
          ttl: 60,
          records: [args.config.aws.cloudfrontDistributionDomainName],
        },
        { parent: this, provider: opts.globalProvider }
      );

      new aws.route53.Record(
        `${rid}-txt`,
        {
          zoneId: args.config.aws.zoneId,
          name: pulumi.interpolate`origin.${dnsLabel}.${args.config.domainName ?? ''}`,
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
