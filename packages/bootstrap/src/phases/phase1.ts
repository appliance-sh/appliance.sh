import * as path from 'node:path';
import * as fs from 'node:fs';
import * as auto from '@pulumi/pulumi/automation';
import { applianceInfra, ApplianceBaseAwsPublic } from '@appliance.sh/infra';
import type { BootstrapEvent, BootstrapInput } from '../types';
import { awsCredsFromEnv, forwardPulumiEvent, homeEnv } from './helpers';

export interface Phase1Options {
  cacheDir: string;
  emit: (event: BootstrapEvent) => void;
}

export interface Phase1Output {
  stateBackendUrl: string;
}

const PROJECT_NAME = 'appliance-installer';
const STACK_NAME = 'bootstrap';

/**
 * Phase 1: deploy the base infra with `enableApiServer: false`
 * against a local file-backed Pulumi state. The base component
 * creates its own S3 state bucket — phase 3 later moves the
 * installer stack's state into that bucket.
 */
export async function runPhase1(input: BootstrapInput, opts: Phase1Options): Promise<Phase1Output> {
  const workDir = path.join(opts.cacheDir, 'pulumi-workdir');
  const stateDir = path.join(opts.cacheDir, 'pulumi-state');
  const pulumiHome = path.join(opts.cacheDir, 'pulumi-home');

  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(pulumiHome, { recursive: true });

  const program = async () => {
    const { applianceBases } = await applianceInfra({
      bases: { [input.base.name]: input.base.config },
      enableApiServer: false,
    });

    // Return a flat map so Automation API reads them via stack.outputs().
    // The first (and only) base is always the installer's own base in v1.
    // Public-only for now — VPC bases don't run the installer flow.
    const base = applianceBases[0];
    if (!(base instanceof ApplianceBaseAwsPublic)) {
      throw new Error('phase 1 only supports aws-public bases in v1');
    }
    return {
      stateBackendUrl: base.config.stateBackendUrl,
    };
  };

  const stack = await auto.LocalWorkspace.createOrSelectStack(
    {
      projectName: PROJECT_NAME,
      stackName: STACK_NAME,
      program,
    },
    {
      workDir,
      envVars: {
        PULUMI_BACKEND_URL: `file://${stateDir}`,
        PULUMI_HOME: pulumiHome,
        PULUMI_CONFIG_PASSPHRASE: process.env.PULUMI_CONFIG_PASSPHRASE ?? '',
        AWS_REGION: input.base.config.region ?? 'us-east-1',
        ...awsCredsFromEnv(),
        ...homeEnv(),
      },
    }
  );

  await stack.setConfig('aws:region', { value: input.base.config.region ?? 'us-east-1' });

  const result = await stack.up({
    onEvent: (e) => forwardPulumiEvent(e, opts.emit),
    onOutput: (line) => opts.emit({ type: 'log', level: 'info', message: line.trimEnd() }),
  });

  if (result.summary.result !== 'succeeded') {
    throw new Error(`pulumi up failed: ${result.summary.result}`);
  }

  const outputs = await stack.outputs();
  const stateBackendUrl = String(outputs.stateBackendUrl?.value ?? '');
  if (!stateBackendUrl) {
    throw new Error('phase 1 succeeded but stateBackendUrl output is missing');
  }

  return { stateBackendUrl };
}
