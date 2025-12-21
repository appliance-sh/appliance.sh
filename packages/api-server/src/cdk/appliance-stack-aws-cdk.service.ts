import { Injectable, Logger } from '@nestjs/common';
import * as cdk from 'aws-cdk-lib';
import { ApplianceStack } from './appliance-stack';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
} from '@aws-sdk/client-cloudformation';
import {
  waitUntilStackCreateComplete,
  waitUntilStackUpdateComplete,
  waitUntilStackDeleteComplete,
} from '@aws-sdk/client-cloudformation';

export type CdkAction = 'deploy' | 'destroy';

export interface CdkResult {
  action: CdkAction;
  ok: boolean;
  idempotentNoop: boolean;
  message: string;
  stackName: string;
}

@Injectable()
export class ApplianceStackAwsCdkService {
  private readonly logger = new Logger(ApplianceStackAwsCdkService.name);
  private readonly region = process.env.AWS_REGION || 'us-east-1';

  private client(): CloudFormationClient {
    return new CloudFormationClient({ region: this.region });
  }

  private synthTemplate(stackName: string): { templateBody: string; outdir: string } {
    const outdir = mkdtempSync(path.join(tmpdir(), 'appliance-cdk-'));
    const app = new cdk.App({ outdir });
    new ApplianceStack(app, stackName, {});
    const assembly = app.synth();
    const artifact = assembly.getStackByName(stackName);
    const templatePath = path.join(assembly.directory, artifact.templateFile);
    const templateBody = readFileSync(templatePath, 'utf-8');
    return { templateBody, outdir: assembly.directory };
  }

  async deploy(stackName = 'appliance-api-managed'): Promise<CdkResult> {
    const { templateBody, outdir } = this.synthTemplate(stackName);
    try {
      // Does stack exist?
      const cf = this.client();
      const exists = await this.stackExists(cf, stackName);
      if (!exists) {
        await cf.send(
          new CreateStackCommand({
            StackName: stackName,
            TemplateBody: templateBody,
            Capabilities: ['CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
          }),
        );
        await waitUntilStackCreateComplete(
          { client: cf, maxWaitTime: 30 * 60, minDelay: 5, maxDelay: 20 },
          { StackName: stackName },
        );
        return { action: 'deploy', ok: true, idempotentNoop: false, message: 'Stack created', stackName };
      }

      try {
        await cf.send(
          new UpdateStackCommand({
            StackName: stackName,
            TemplateBody: templateBody,
            Capabilities: ['CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
          }),
        );
        await waitUntilStackUpdateComplete(
          { client: cf, maxWaitTime: 30 * 60, minDelay: 5, maxDelay: 20 },
          { StackName: stackName },
        );
        return { action: 'deploy', ok: true, idempotentNoop: false, message: 'Stack updated', stackName };
      } catch (e: any) {
        if (typeof e?.message === 'string' && e.message.includes('No updates are to be performed')) {
          return { action: 'deploy', ok: true, idempotentNoop: true, message: 'No changes (idempotent)', stackName };
        }
        throw e;
      }
    } finally {
      // cleanup synth output
      try {
        rmSync(outdir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  async destroy(stackName = 'appliance-api-managed'): Promise<CdkResult> {
    const cf = this.client();
    const exists = await this.stackExists(cf, stackName);
    if (!exists) {
      return { action: 'destroy', ok: true, idempotentNoop: true, message: 'Stack not found (idempotent)', stackName };
    }
    await cf.send(new DeleteStackCommand({ StackName: stackName }));
    await waitUntilStackDeleteComplete(
      { client: cf, maxWaitTime: 30 * 60, minDelay: 5, maxDelay: 20 },
      { StackName: stackName },
    );
    return { action: 'destroy', ok: true, idempotentNoop: false, message: 'Stack deleted', stackName };
  }

  private async stackExists(cf: CloudFormationClient, stackName: string): Promise<boolean> {
    try {
      const res = await cf.send(new DescribeStacksCommand({ StackName: stackName }));
      return !!res.Stacks && res.Stacks.length > 0;
    } catch (e: any) {
      const code = e?.name || e?.Code || e?.code;
      const message = e?.message || '';
      if (code === 'ValidationError' && message.includes('does not exist')) return false;
      if (message.includes('does not exist')) return false;
      throw e;
    }
  }
}
