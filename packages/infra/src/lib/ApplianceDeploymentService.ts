import * as auto from '@pulumi/pulumi/automation';
import * as aws from '@pulumi/aws';
import * as awsNative from '@pulumi/aws-native';
import { ApplianceStack, ApplianceStackMetadata, toResourceId } from './aws/ApplianceStack';
import { applianceBaseConfig, ApplianceBaseConfig } from '@appliance.sh/sdk';

export type PulumiAction = 'deploy' | 'destroy';

export interface PulumiResult {
  action: PulumiAction;
  ok: boolean;
  idempotentNoop: boolean;
  message: string;
  stackName: string;
}

export interface ResolvedBuildParams {
  imageUri?: string;
  codeS3Key?: string;
  runtime?: string;
  handler?: string;
  layers?: string[];
  architectures?: string[];
  environment?: Record<string, string>;
}

export interface ApplianceDeploymentServiceOptions {
  baseConfig?: ApplianceBaseConfig;
}

export class ApplianceDeploymentService {
  private readonly projectName = 'appliance-api-managed-proj';
  private readonly baseConfig: ApplianceBaseConfig | undefined;
  private readonly region: string;

  constructor(options?: ApplianceDeploymentServiceOptions) {
    this.baseConfig =
      options?.baseConfig ??
      (process.env.APPLIANCE_BASE_CONFIG
        ? applianceBaseConfig.parse(JSON.parse(process.env.APPLIANCE_BASE_CONFIG))
        : undefined);
    this.region = this.baseConfig?.aws.region || 'us-east-1';
  }

  private inlineProgram(stackName: string, metadata?: ApplianceStackMetadata, build?: ResolvedBuildParams) {
    return async () => {
      if (!this.baseConfig) {
        throw new Error('Missing base config');
      }

      const rid = toResourceId(stackName);
      const regionalProvider = new aws.Provider(`${rid}-regional`, {
        region: (this.baseConfig?.aws.region as aws.Region) ?? 'ap-southeast-1',
      });
      const globalProvider = new aws.Provider(`${rid}-global`, {
        region: 'us-east-1',
      });
      const nativeRegionalProvider = new awsNative.Provider(`${rid}-native-regional`, {
        region: (this.baseConfig?.aws.region as awsNative.Region) ?? 'ap-southeast-1',
      });

      const nativeGlobalProvider = new awsNative.Provider(`${rid}-native-global`, {
        region: 'us-east-1',
      });

      const applianceStack = new ApplianceStack(
        stackName,
        {
          metadata,
          config: this.baseConfig,
          imageUri: build?.imageUri,
          codeS3Key: build?.codeS3Key,
          runtime: build?.runtime,
          handler: build?.handler,
          layers: build?.layers,
          architectures: build?.architectures,
          environment: build?.environment,
        },
        {
          globalProvider,
          provider: regionalProvider,
          nativeProvider: nativeRegionalProvider,
          nativeGlobalProvider: nativeGlobalProvider,
        }
      );

      return {
        applianceStack,
      };
    };
  }

  private async getOrCreateStack(
    stackName: string,
    metadata?: ApplianceStackMetadata,
    build?: ResolvedBuildParams
  ): Promise<auto.Stack> {
    const program = this.inlineProgram(stackName, metadata, build);
    const envVars: Record<string, string> = {
      AWS_REGION: this.region,
    };
    if (!this.baseConfig) {
      throw new Error('Missing base config');
    }
    if (this.baseConfig) {
      envVars['PULUMI_BACKEND_URL'] = this.baseConfig.stateBackendUrl;
    }

    const stack = await auto.LocalWorkspace.createOrSelectStack(
      { projectName: this.projectName, stackName, program },
      { envVars }
    );
    await stack.setConfig('aws:region', { value: this.baseConfig.aws.region });
    return stack;
  }

  private async selectExistingStack(stackName: string): Promise<auto.Stack> {
    const envVars: Record<string, string> = {
      AWS_REGION: this.region,
    };
    if (!this.baseConfig) {
      throw new Error('Missing base config');
    }
    if (this.baseConfig) {
      envVars['PULUMI_BACKEND_URL'] = this.baseConfig.stateBackendUrl;
    }

    const ws = await auto.LocalWorkspace.create({
      projectSettings: { name: this.projectName, runtime: 'nodejs' },
      envVars,
    });

    return auto.Stack.createOrSelect(stackName, ws);
  }

  async deploy(
    stackName: string,
    metadata?: ApplianceStackMetadata,
    build?: ResolvedBuildParams
  ): Promise<PulumiResult> {
    const stack = await this.getOrCreateStack(stackName, metadata, build);
    const result = await stack.up({ onOutput: (m) => console.log(m) });
    const changes = result.summary.resourceChanges || {};
    const totalChanges = Object.entries(changes)
      .filter(([k]) => k !== 'same')
      .reduce((acc, [, v]) => acc + (v || 0), 0);
    const idempotentNoop = totalChanges === 0;
    return {
      action: 'deploy',
      ok: true,
      idempotentNoop,
      message: idempotentNoop ? 'No changes (idempotent)' : 'Stack updated',
      stackName,
    };
  }

  async destroy(stackName: string): Promise<PulumiResult> {
    try {
      const stack = await this.selectExistingStack(stackName);
      await stack.destroy({ onOutput: (m) => console.log(m) });
      return { action: 'destroy', ok: true, idempotentNoop: false, message: 'Stack resources deleted', stackName };
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      const msg = String(e?.message || e);
      if (msg.includes('no stack named') || msg.includes('not found')) {
        return {
          action: 'destroy',
          ok: true,
          idempotentNoop: true,
          message: 'Stack not found (idempotent)',
          stackName,
        };
      }
      throw e;
    }
  }
}

// Factory function to create the service
export function createApplianceDeploymentService(
  options?: ApplianceDeploymentServiceOptions
): ApplianceDeploymentService {
  return new ApplianceDeploymentService(options);
}
