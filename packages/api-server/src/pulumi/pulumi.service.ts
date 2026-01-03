import { Injectable, Logger } from '@nestjs/common';
import * as auto from '@pulumi/pulumi/automation';
import * as aws from '@pulumi/aws';
import { ApplianceStack } from './ApplianceStack';
import { applianceBaseConfig } from '@appliance.sh/sdk';

export type PulumiAction = 'deploy' | 'destroy';

export interface PulumiResult {
  action: PulumiAction;
  ok: boolean;
  idempotentNoop: boolean;
  message: string;
  stackName: string;
}

@Injectable()
export class PulumiService {
  private readonly logger = new Logger(PulumiService.name);
  private readonly region = process.env.AWS_REGION || 'us-east-1';
  private readonly projectName = 'appliance-api-managed-proj';

  private readonly baseConfig = process.env.APPLIANCE_BASE_CONFIG
    ? applianceBaseConfig.parse(JSON.parse(process.env.APPLIANCE_BASE_CONFIG))
    : undefined;

  private inlineProgram() {
    return async () => {
      const name = 'appliance';
      const regionalProvider = new aws.Provider(`${name}-regional`, {
        region: this.baseConfig?.region ?? 'ap-southeast-1',
      });
      const globalProvider = new aws.Provider(`${name}-global`, {
        region: 'us-east-1',
      });

      const applianceStack = new ApplianceStack(
        `${name}-stack`,
        {
          tags: { project: name },
        },
        {
          globalProvider,
          provider: regionalProvider,
        }
      );

      return {
        applianceStack,
      };
    };
  }

  private async getOrCreateStack(stackName: string): Promise<auto.Stack> {
    const program = this.inlineProgram();
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
    await stack.setConfig('aws:region', { value: this.region });
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

  async deploy(stackName = 'appliance-api-managed'): Promise<PulumiResult> {
    const stack = await this.getOrCreateStack(stackName);
    const result = await stack.up({ onOutput: (m) => this.logger.log(m) });
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

  async destroy(stackName = 'appliance-api-managed'): Promise<PulumiResult> {
    try {
      const stack = await this.selectExistingStack(stackName);
      await stack.destroy({ onOutput: (m) => this.logger.log(m) });
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
