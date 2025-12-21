import { Injectable, Logger } from '@nestjs/common';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as auto from '@pulumi/pulumi/automation';
import * as aws from '@pulumi/aws';

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
  private readonly backendDir = this.ensureDir(path.resolve(__dirname, '../../.pulumi-state'));
  private readonly projectName = 'appliance-api-managed-proj';

  private ensureDir(dir: string): string {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private inlineProgram() {
    return async () => {
      const bucket = new aws.s3.Bucket('dummy-bucket', {
        forceDestroy: true,
        versioning: { enabled: true },
        tags: { app: 'appliance-api' },
      });
      return {
        bucketName: bucket.bucket,
      };
    };
  }

  private async getOrCreateStack(stackName: string): Promise<auto.Stack> {
    const program = this.inlineProgram();
    const envVars: Record<string, string> = {
      PULUMI_BACKEND_URL: 'file://' + this.backendDir,
      AWS_REGION: this.region,
    };
    const stack = await auto.LocalWorkspace.createOrSelectStack(
      { projectName: this.projectName, stackName, program },
      { envVars }
    );
    await stack.setConfig('aws:region', { value: this.region });
    return stack;
  }

  private async selectExistingStack(stackName: string): Promise<auto.Stack> {
    const envVars: Record<string, string> = {
      PULUMI_BACKEND_URL: 'file://' + this.backendDir,
      AWS_REGION: this.region,
    };
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
