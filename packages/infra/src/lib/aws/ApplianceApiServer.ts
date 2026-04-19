import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

export interface ApplianceApiServerArgs {
  imageUri: pulumi.Input<string>;
  bootstrapToken: pulumi.Input<string>;
  stateBackendUrl: pulumi.Input<string>;
  baseConfig: pulumi.Input<unknown>;
  dataBucketArn: pulumi.Input<string>;
  stateBucketArn: pulumi.Input<string>;
  memory?: number;
  timeout?: number;
}

export interface ApplianceApiServerOpts extends pulumi.ComponentResourceOptions {
  provider?: pulumi.ProviderResource;
}

export class ApplianceApiServer extends pulumi.ComponentResource {
  public readonly functionUrl: pulumi.Output<string>;
  public readonly functionArn: pulumi.Output<string>;
  public readonly roleArn: pulumi.Output<string>;

  constructor(name: string, args: ApplianceApiServerArgs, opts?: ApplianceApiServerOpts) {
    super('appliance-infra:appliance-api-server', name, args, opts);

    const logGroup = new aws.cloudwatch.LogGroup(
      `${name}-logs`,
      {
        name: `/aws/lambda/${name}`,
        retentionInDays: 14,
      },
      { parent: this, provider: opts?.provider }
    );

    const role = new aws.iam.Role(
      `${name}-role`,
      {
        assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
          Service: 'lambda.amazonaws.com',
        }),
      },
      { parent: this, provider: opts?.provider }
    );

    new aws.iam.RolePolicyAttachment(
      `${name}-role-basic`,
      {
        role: role.name,
        policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
      },
      { parent: this, provider: opts?.provider }
    );

    new aws.iam.RolePolicy(
      `${name}-role-buckets`,
      {
        role: role.id,
        policy: pulumi.jsonStringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Action: ['s3:ListBucket', 's3:GetBucketLocation'],
              Resource: [args.stateBucketArn, args.dataBucketArn],
            },
            {
              Effect: 'Allow',
              Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
              Resource: [pulumi.interpolate`${args.stateBucketArn}/*`, pulumi.interpolate`${args.dataBucketArn}/*`],
            },
          ],
        }),
      },
      { parent: this, provider: opts?.provider }
    );

    // v1 bootstrap grants broad AWS access so api-server's Pulumi
    // automation can provision per-appliance deployment stacks
    // end-to-end. Follow-up: replace with a tight policy derived
    // from the resources ApplianceStack actually creates.
    new aws.iam.RolePolicyAttachment(
      `${name}-role-admin`,
      {
        role: role.name,
        policyArn: 'arn:aws:iam::aws:policy/AdministratorAccess',
      },
      { parent: this, provider: opts?.provider }
    );

    const fn = new aws.lambda.Function(
      `${name}-fn`,
      {
        packageType: 'Image',
        imageUri: args.imageUri,
        role: role.arn,
        memorySize: args.memory ?? 1024,
        timeout: args.timeout ?? 300,
        loggingConfig: {
          logGroup: logGroup.name,
          logFormat: 'Text',
        },
        environment: {
          variables: {
            PORT: '3000',
            AWS_LWA_PORT: '3000',
            PULUMI_BACKEND_URL: args.stateBackendUrl,
            BOOTSTRAP_TOKEN: args.bootstrapToken,
            APPLIANCE_BASE_CONFIG: pulumi.jsonStringify(args.baseConfig),
            // The api-server sits behind CloudFront + an edge Lambda
            // that rewrites Host to the Function URL's internal
            // hostname and stashes the viewer's original Host in
            // X-Forwarded-Host. HTTP Message Signatures sign
            // @authority derived from the viewer's URL, so the
            // server must reconstruct the same authority via the
            // forwarded header — which requires Express to trust
            // the proxy. Without this, all signed requests from a
            // browser fail with "Signature verification failed".
            APPLIANCE_TRUST_PROXY: 'true',
          },
        },
      },
      { parent: this, provider: opts?.provider, dependsOn: [logGroup] }
    );

    // NONE auth: api-server enforces its own X-Bootstrap-Token and
    // X-Access-Key-Id / X-Secret-Access-Key header checks. A follow-up
    // commit wires this behind the base's CloudFront + edge router so
    // the Function URL stops being internet-reachable directly.
    const furl = new aws.lambda.FunctionUrl(
      `${name}-furl`,
      {
        functionName: fn.name,
        authorizationType: 'NONE',
        invokeMode: 'BUFFERED',
      },
      { parent: this, provider: opts?.provider }
    );

    this.functionUrl = furl.functionUrl;
    this.functionArn = fn.arn;
    this.roleArn = role.arn;

    this.registerOutputs({
      functionUrl: this.functionUrl,
      functionArn: this.functionArn,
      roleArn: this.roleArn,
    });
  }
}
