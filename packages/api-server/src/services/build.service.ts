import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import { applianceBaseConfig, applianceInput } from '@appliance.sh/sdk';
import type { ApplianceContainer, ApplianceFrameworkApp } from '@appliance.sh/sdk';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface ResolvedBuild {
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

    const s3Key = `builds/${buildId}.zip`;
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

      if (manifest.type === 'container') {
        return await this.resolveContainer(tmpDir, manifest, tag, config);
      } else if (manifest.type === 'framework') {
        return this.resolveFramework(manifest, s3Key, config);
      } else {
        return { codeS3Key: s3Key };
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /**
   * Framework builds are fully pre-processed by the CLI (dependencies installed,
   * run.sh generated). The server just resolves Lambda-specific params from the
   * manifest metadata and points at the original uploaded zip.
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
      memory: manifest.memory,
      timeout: manifest.timeout,
      storage: manifest.storage,
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
    manifest: ApplianceContainer,
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

    return { imageUri, memory: manifest.memory, timeout: manifest.timeout, storage: manifest.storage };
  }
}

export const buildService = new BuildService();
