import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import { applianceBaseConfig, applianceInput, BuildType } from '@appliance.sh/sdk';
import type { ApplianceFrameworkApp } from '@appliance.sh/sdk';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildUploadService } from './build-upload.service';

export interface ResolvedBuild {
  imageUri?: string;
  codeS3Key?: string;
  runtime?: string;
  handler?: string;
  layers?: string[];
  architectures?: string[];
  // Resolver-owned env — system correctness keys (AWS_LWA_PORT,
  // AWS_LAMBDA_EXEC_WRAPPER). Manifest-declared env vars travel
  // through the deploy payload's `environment` parameter (rendered
  // client-side at deploy time with full ManifestContext); the
  // executor merges them under these resolver values.
  environment?: Record<string, string>;
  memory?: number;
  timeout?: number;
  storage?: number;
  // Pre-existing IAM role ARN injected by the executor for system
  // appliances (project=`system`). Threaded through to ApplianceStack
  // so the dogfood-deployed api-server / worker bind to the
  // base-pre-created roles instead of getting per-deploy roles.
  lambdaRoleArn?: string;
}

function getBaseConfig() {
  const raw = process.env.APPLIANCE_BASE_CONFIG;
  if (!raw) throw new Error('APPLIANCE_BASE_CONFIG not set');
  return applianceBaseConfig.parse(JSON.parse(raw));
}

const LAMBDA_ADAPTER_LAYER: Record<string, string> = {
  'linux/amd64': 'arn:aws:lambda:${region}:753240598075:layer:LambdaAdapterLayerX86:26',
  'linux/arm64': 'arn:aws:lambda:${region}:753240598075:layer:LambdaAdapterLayerArm64:26',
};

const FRAMEWORK_RUNTIMES: Record<string, string> = {
  node: 'nodejs22.x',
  python: 'python3.13',
  auto: 'nodejs22.x',
  other: 'nodejs22.x',
};

const FRAMEWORK_ARCHITECTURES: Record<string, string> = {
  'linux/amd64': 'x86_64',
  'linux/arm64': 'arm64',
};

export class BuildService {
  async resolve(buildId: string, tag: string): Promise<ResolvedBuild> {
    const config = getBaseConfig();
    if (!config.aws.dataBucketName) throw new Error('Data bucket not configured');

    // Look up the Build record. `remote-image` builds short-circuit
    // straight to an imageUri — no zip download, no manifest parse.
    // The `upload` flow falls through to the zip-extract path below.
    // (A missing record implies an older upload-flow build created
    // before build-record persistence; tolerate by treating it as
    // upload-flow with the derived S3 key.)
    const stored = await buildUploadService.get(buildId);
    if (stored?.type === BuildType.RemoteImage) {
      return { imageUri: stored.source };
    }

    const s3Key = stored?.source ?? `builds/${buildId}.zip`;
    const s3 = new S3Client({ region: config.aws.region });

    // Download the build zip
    const result = await s3.send(new GetObjectCommand({ Bucket: config.aws.dataBucketName, Key: s3Key }));
    const body = await result.Body?.transformToByteArray();
    if (!body) throw new Error('Empty build');

    // Extract to temp dir
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-build-'));
    const zipPath = path.join(tmpDir, 'appliance.zip');
    fs.writeFileSync(zipPath, body);

    try {
      // List zip contents and validate paths before extracting
      // Validate zip contents before extracting
      const entries = execFileSync('zipinfo', ['-1', zipPath], { encoding: 'utf-8' }).trim().split('\n');
      for (const entryPath of entries) {
        const resolved = path.resolve(tmpDir, entryPath);
        if (!resolved.startsWith(tmpDir + path.sep) && resolved !== tmpDir) {
          throw new Error(`Zip contains path traversal: ${entryPath}`);
        }
      }

      execFileSync('unzip', ['-o', '-q', zipPath, '-d', tmpDir], { stdio: 'pipe' });

      // Reject symlinks after extraction
      for (const entryPath of entries) {
        const fullPath = path.join(tmpDir, entryPath);
        if (fs.existsSync(fullPath) && fs.lstatSync(fullPath).isSymbolicLink()) {
          throw new Error(`Zip contains symlink: ${entryPath}`);
        }
      }

      // Read the manifest
      const manifestPath = path.join(tmpDir, 'appliance.json');
      if (!fs.existsSync(manifestPath)) throw new Error('Build missing appliance.json');
      const manifest = applianceInput.parse(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')));

      // The build artifact is environment-invariant: per-environment
      // runtime config (env, memory, timeout, storage) is stripped at
      // archive time and rendered fresh per-deploy from the source
      // manifest, then forwarded on the deploy payload. Anything in
      // appliance.json beyond the build-time schema is ignored here.
      return manifest.type === 'container'
        ? await this.resolveContainer(tmpDir, tag, config)
        : manifest.type === 'framework'
          ? this.resolveFramework(manifest, s3Key, config)
          : { codeS3Key: s3Key };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /**
   * Framework builds are fully pre-processed by the CLI (dependencies installed,
   * run.sh generated). The server resolves the platform-specific Lambda wiring
   * from the manifest (runtime, handler, adapter layer, architecture). Memory /
   * timeout / storage are runtime configuration — they travel through the
   * deploy payload, not the build artifact.
   */
  private resolveFramework(
    manifest: ApplianceFrameworkApp,
    s3Key: string,
    config: ReturnType<typeof getBaseConfig>
  ): ResolvedBuild {
    const port = manifest.port ?? 8080;
    const framework = manifest.framework ?? 'auto';
    const runtime = FRAMEWORK_RUNTIMES[framework] ?? FRAMEWORK_RUNTIMES['node'];

    const platform = manifest.platform;
    const layerArn = LAMBDA_ADAPTER_LAYER[platform]?.replace('${region}', config.aws.region);
    if (!layerArn) throw new Error(`No Lambda Web Adapter layer for platform: ${platform}`);
    const architecture = FRAMEWORK_ARCHITECTURES[platform];
    if (!architecture) throw new Error(`No Lambda architecture for platform: ${platform}`);

    return {
      codeS3Key: s3Key,
      runtime,
      handler: 'run.sh',
      layers: [layerArn],
      architectures: [architecture],
      environment: {
        AWS_LAMBDA_EXEC_WRAPPER: '/opt/bootstrap',
        AWS_LWA_PORT: String(port),
      },
    };
  }

  /**
   * Container builds are fully pre-processed by the CLI (Lambda Web Adapter
   * already injected). The server pushes the image tar directly to ECR using
   * crane (no Docker daemon required).
   * All subprocess calls use execFileSync (array args) to prevent shell injection.
   */
  private async resolveContainer(
    tmpDir: string,
    tag: string,
    config: ReturnType<typeof getBaseConfig>
  ): Promise<ResolvedBuild> {
    const ecrRepositoryUrl = config.aws.ecrRepositoryUrl;
    if (!ecrRepositoryUrl) throw new Error('ECR repository not configured');

    const imageTarPath = path.join(tmpDir, 'image.tar');
    if (!fs.existsSync(imageTarPath)) {
      const extracted = fs.readdirSync(tmpDir);
      throw new Error(`Build missing image.tar. Extracted contents: ${extracted.join(', ')}`);
    }

    // Auth with ECR via crane
    const ecr = new ECRClient({ region: config.aws.region });
    const authResult = await ecr.send(new GetAuthorizationTokenCommand({}));
    const authData = authResult.authorizationData?.[0];
    if (!authData?.authorizationToken || !authData?.proxyEndpoint) {
      throw new Error('Failed to get ECR auth');
    }

    const decoded = Buffer.from(authData.authorizationToken, 'base64').toString();
    const [username, password] = decoded.split(':');
    const registryHost = authData.proxyEndpoint.replace(/^https?:\/\//, '');
    execFileSync('crane', ['auth', 'login', registryHost, '-u', username, '--password-stdin'], {
      input: password,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Push image tar directly to ECR (no daemon, no load/tag step)
    const remoteTag = `${ecrRepositoryUrl}:${tag}`;
    execFileSync('crane', ['push', imageTarPath, remoteTag], { stdio: 'pipe' });

    // Get digest for immutable image reference
    let imageUri: string;
    try {
      const digest = execFileSync('crane', ['digest', remoteTag], { encoding: 'utf-8' }).trim();
      imageUri = `${ecrRepositoryUrl}@${digest}`;
    } catch {
      imageUri = remoteTag;
    }

    return { imageUri };
  }
}

export const buildService = new BuildService();
