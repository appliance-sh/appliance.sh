import * as fs from 'node:fs';
import * as path from 'node:path';
import * as auto from '@pulumi/pulumi/automation';
import * as aws from '@pulumi/aws';
import * as awsNative from '@pulumi/aws-native';
import { ApplianceStack, ApplianceStackMetadata, toResourceId } from './aws/ApplianceStack';
import { applianceBaseConfig, ApplianceBaseConfig } from '@appliance.sh/sdk';

// Shared across every deployment on a given worker. Plugins cached at
// build time into /opt/pulumi-cache/plugins are symlinked into
// ${PULUMI_HOME}/plugins on first use so cold starts avoid downloading
// them.
const PULUMI_HOME = '/tmp/.pulumi';
const PLUGIN_CACHE_DIR = '/opt/pulumi-cache/plugins';

export type PulumiAction = 'deploy' | 'destroy' | 'refresh';

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
  memory?: number;
  timeout?: number;
  storage?: number;
  // Pre-existing IAM role ARN. When set, ApplianceStack binds the
  // Lambda to this role instead of minting one. Used by the dogfooded
  // bootstrap path for the system api-server + worker appliances,
  // which need broader IAM than ApplianceStack's per-appliance role.
  lambdaRoleArn?: string;
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
          memory: build?.memory,
          timeout: build?.timeout,
          storage: build?.storage,
          lambdaRoleArn: build?.lambdaRoleArn,
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

  /**
   * Build the env vars passed to the Pulumi Automation API workspace.
   * PULUMI_HOME is shared across every project the worker handles — this
   * keeps one plugin cache (pre-seeded from /opt at image build time)
   * reused across projects. Per-project isolation is handled via
   * `workDir` instead.
   */
  private buildEnvVars(): Record<string, string> {
    if (!this.baseConfig) {
      throw new Error('Missing base config');
    }
    this.ensurePluginCache();
    return {
      AWS_REGION: this.region,
      PULUMI_BACKEND_URL: this.baseConfig.stateBackendUrl,
      PULUMI_HOME,
    };
  }

  /**
   * Idempotently symlink each precached plugin subdir from
   * /opt/pulumi-cache/plugins into ${PULUMI_HOME}/plugins. Linking
   * individual subdirs (not the parent) keeps the plugins/ dir itself
   * writable so Pulumi can still drop its own metadata/lock files while
   * reading plugin binaries from the read-only /opt cache.
   */
  private ensurePluginCache(): void {
    if (!fs.existsSync(PLUGIN_CACHE_DIR)) return;
    const target = path.join(PULUMI_HOME, 'plugins');
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(PLUGIN_CACHE_DIR)) {
      const linkPath = path.join(target, entry);
      try {
        fs.lstatSync(linkPath);
      } catch {
        fs.symlinkSync(path.join(PLUGIN_CACHE_DIR, entry), linkPath);
      }
    }
  }

  /**
   * Per-project scratch directory that Pulumi uses as the inline program's
   * workDir. Isolating this dir per project prevents concurrent deploys
   * across projects from racing on Pulumi.yaml or the local tmp state
   * that the Automation API writes during a run.
   */
  private workDirFor(projectId?: string): string {
    const dir = projectId ? `/tmp/pulumi-workdir-${projectId}` : '/tmp/pulumi-workdir';
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Build the AWS KMS secrets provider URL for stack init. Pulumi's
   * `awskms://` form takes the key ARN/ID + region. Returns undefined
   * when the base hasn't been provisioned with a state KMS key (older
   * clusters), in which case the workspace falls back to whatever
   * PULUMI_CONFIG_PASSPHRASE is set to.
   */
  private secretsProvider(): string | undefined {
    const arn = this.baseConfig?.aws.kmsKeyArn;
    if (!arn) return undefined;
    return `awskms://${arn}?region=${this.region}`;
  }

  private async getOrCreateStack(
    stackName: string,
    metadata?: ApplianceStackMetadata,
    build?: ResolvedBuildParams
  ): Promise<auto.Stack> {
    const program = this.inlineProgram(stackName, metadata, build);
    const envVars = this.buildEnvVars();
    const workDir = this.workDirFor(metadata?.projectId);
    const secretsProvider = this.secretsProvider();

    const stack = await auto.LocalWorkspace.createOrSelectStack(
      { projectName: this.projectName, stackName, program },
      { envVars, workDir, ...(secretsProvider ? { secretsProvider } : {}) }
    );
    await stack.setConfig('aws:region', { value: this.baseConfig!.aws.region });
    return stack;
  }

  private async selectExistingStack(stackName: string, projectId?: string): Promise<auto.Stack> {
    const envVars = this.buildEnvVars();
    const workDir = this.workDirFor(projectId);

    const ws = await auto.LocalWorkspace.create({
      projectSettings: { name: this.projectName, runtime: 'nodejs' },
      workDir,
      envVars,
    });

    return auto.Stack.createOrSelect(stackName, ws);
  }

  async deploy(
    stackName: string,
    metadata?: ApplianceStackMetadata,
    build?: ResolvedBuildParams,
    opts?: PulumiOpOptions
  ): Promise<PulumiResult> {
    const stack = await this.getOrCreateStack(stackName, metadata, build);
    opts?.onStack?.(stack);
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

  async destroy(stackName: string, projectId?: string, opts?: PulumiOpOptions): Promise<PulumiResult> {
    try {
      const stack = await this.selectExistingStack(stackName, projectId);
      opts?.onStack?.(stack);
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

  async refresh(stackName: string, projectId?: string, opts?: PulumiOpOptions): Promise<PulumiResult> {
    try {
      const stack = await this.selectExistingStack(stackName, projectId);
      opts?.onStack?.(stack);
      const result = await stack.refresh({ onOutput: (m) => console.log(m) });
      const changes = result.summary.resourceChanges || {};
      const totalChanges = Object.entries(changes)
        .filter(([k]) => k !== 'same')
        .reduce((acc, [, v]) => acc + (v || 0), 0);
      const idempotentNoop = totalChanges === 0;
      return {
        action: 'refresh',
        ok: true,
        idempotentNoop,
        message: idempotentNoop ? 'No drift (state matched reality)' : 'State refreshed',
        stackName,
      };
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      const msg = String(e?.message || e);
      if (msg.includes('no stack named') || msg.includes('not found')) {
        return {
          action: 'refresh',
          ok: true,
          idempotentNoop: true,
          message: 'Stack not found (nothing to refresh)',
          stackName,
        };
      }
      throw e;
    }
  }
}

// Options for in-flight Pulumi operations. `onStack` hands the
// caller a structural handle to the live Pulumi Stack so it can
// invoke stack.cancel() / stack.refresh() out of band — used by the
// api-server's cancel-aware executor. Structural typing here avoids
// pinning consumers to a specific @pulumi/pulumi resolution
// (workspace packages can otherwise end up with two parallel copies
// that fail nominal type identity).
export interface PulumiOpOptions {
  onStack?: (stack: PulumiStackHandle) => void;
}

export interface PulumiStackHandle {
  cancel(): Promise<void>;
  refresh(opts?: { onOutput?: (m: string) => void }): Promise<unknown>;
}

// Factory function to create the service
export function createApplianceDeploymentService(
  options?: ApplianceDeploymentServiceOptions
): ApplianceDeploymentService {
  return new ApplianceDeploymentService(options);
}
