import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import { applianceBaseConfig, applianceInput } from '@appliance.sh/sdk';
import type { ApplianceContainer, ApplianceFrameworkApp } from '@appliance.sh/sdk';
import { execSync } from 'child_process';
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
      const entries = execSync(`zipinfo -1 "${zipPath}"`, { encoding: 'utf-8' }).trim().split('\n');
      for (const entryPath of entries) {
        const resolved = path.resolve(tmpDir, entryPath);
        if (!resolved.startsWith(tmpDir + path.sep) && resolved !== tmpDir) {
          throw new Error(`Zip contains path traversal: ${entryPath}`);
        }
      }

      execSync(`unzip -o -q "${zipPath}" -d "${tmpDir}"`, { stdio: 'pipe' });

      // Read the manifest
      const manifestPath = path.join(tmpDir, 'appliance.json');
      if (!fs.existsSync(manifestPath)) throw new Error('Build missing appliance.json');
      const manifest = applianceInput.parse(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')));

      if (manifest.type === 'container') {
        return this.resolveContainer(tmpDir, manifest, tag, config);
      } else if (manifest.type === 'framework') {
        return this.resolveFramework(tmpDir, manifest, tag, config);
      } else {
        return { codeS3Key: s3Key };
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  private async resolveFramework(
    tmpDir: string,
    manifest: ApplianceFrameworkApp,
    tag: string,
    config: ReturnType<typeof getBaseConfig>
  ): Promise<ResolvedBuild> {
    if (!config.aws.dataBucketName) throw new Error('Data bucket not configured');

    const port = manifest.port ?? 8080;
    const framework = manifest.framework ?? 'auto';
    const detectedFramework = framework === 'auto' ? this.detectFramework(tmpDir) : framework;
    const runtime = FRAMEWORK_RUNTIMES[detectedFramework] ?? FRAMEWORK_RUNTIMES['node'];

    // Generate a run.sh that starts the web server
    const startCommand = manifest.scripts?.start ?? this.defaultStartCommand(detectedFramework, tmpDir);
    const runSh = ['#!/bin/bash', `export PORT=${port}`, `exec ${startCommand}`].join('\n');
    fs.writeFileSync(path.join(tmpDir, 'run.sh'), runSh, { mode: 0o755 });

    // Repackage as a new zip (excluding the original zip and manifest-only artifacts)
    const repackagedKey = `builds/${tag}.zip`;
    const repackagedZip = path.join(tmpDir, 'repackaged.zip');
    execSync(`cd "${tmpDir}" && zip -r "${repackagedZip}" . -x "appliance.zip" -x "repackaged.zip"`, { stdio: 'pipe' });

    // Upload the repackaged zip
    const s3 = new S3Client({ region: config.aws.region });
    await s3.send(
      new PutObjectCommand({
        Bucket: config.aws.dataBucketName,
        Key: repackagedKey,
        Body: fs.readFileSync(repackagedZip),
        ContentType: 'application/zip',
      })
    );

    // Resolve the Lambda Web Adapter layer ARN and architecture for this region
    const platform = manifest.platform;
    const layerArn = LAMBDA_ADAPTER_LAYER[platform]?.replace('${region}', config.aws.region);
    if (!layerArn) throw new Error(`No Lambda Web Adapter layer for platform: ${platform}`);
    const architecture = FRAMEWORK_ARCHITECTURES[platform];
    if (!architecture) throw new Error(`No Lambda architecture for platform: ${platform}`);

    // The Web Adapter layer uses AWS_LAMBDA_EXEC_WRAPPER to intercept the
    // Lambda runtime bootstrap. It starts run.sh (the web server) and proxies
    // Lambda invocations to it as HTTP requests. The handler value is not
    // called directly but must point to a valid file to pass validation.
    return {
      codeS3Key: repackagedKey,
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

  private detectFramework(tmpDir: string): string {
    if (fs.existsSync(path.join(tmpDir, 'package.json'))) return 'node';
    if (fs.existsSync(path.join(tmpDir, 'requirements.txt'))) return 'python';
    if (fs.existsSync(path.join(tmpDir, 'Pipfile'))) return 'python';
    if (fs.existsSync(path.join(tmpDir, 'pyproject.toml'))) return 'python';
    return 'node';
  }

  private defaultStartCommand(framework: string, tmpDir: string): string {
    if (framework === 'python') {
      return 'python app.py';
    }
    // Node default
    if (fs.existsSync(path.join(tmpDir, 'package.json'))) {
      const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'package.json'), 'utf-8'));
      if (pkg.scripts?.start) return 'npm start';
    }
    return 'node index.js';
  }

  private async resolveContainer(
    tmpDir: string,
    manifest: ApplianceContainer,
    tag: string,
    config: ReturnType<typeof getBaseConfig>
  ): Promise<ResolvedBuild> {
    const ecrRepositoryUrl = config.aws.ecrRepositoryUrl;
    if (!ecrRepositoryUrl) throw new Error('ECR repository not configured');

    const imageTarPath = path.join(tmpDir, 'image.tar');
    if (!fs.existsSync(imageTarPath)) throw new Error('Build missing image.tar');

    // Load the user's original image into Docker and capture the loaded image reference
    const loadOutput = execSync(`docker load -i "${imageTarPath}"`, { encoding: 'utf-8' });
    // Output is like "Loaded image: name:tag" or "Loaded image ID: sha256:abc..."
    const loadedMatch = loadOutput.match(/Loaded image(?: ID)?:\s*(.+)/);
    if (!loadedMatch) throw new Error(`Failed to parse docker load output: ${loadOutput}`);
    const loadedImage = loadedMatch[1].trim();

    // Wrap the image with the Lambda Web Adapter so the same plain HTTP
    // container works on both Lambda and ECS/Fargate without any changes.
    const lambdaImageName = `${manifest.name}-lambda`;
    const wrapperDockerfile = path.join(tmpDir, 'Dockerfile.lambda');
    fs.writeFileSync(
      wrapperDockerfile,
      [
        `FROM --platform=${manifest.platform} public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 AS adapter`,
        `FROM ${loadedImage}`,
        `COPY --from=adapter /lambda-adapter /opt/extensions/lambda-adapter`,
        `ENV AWS_LWA_PORT=${manifest.port}`,
      ].join('\n')
    );
    execSync(
      `docker build --platform ${manifest.platform} --provenance=false -f "${wrapperDockerfile}" -t "${lambdaImageName}" "${tmpDir}"`,
      { stdio: 'pipe' }
    );

    // Auth with ECR
    const ecr = new ECRClient({ region: config.aws.region });
    const authResult = await ecr.send(new GetAuthorizationTokenCommand({}));
    const authData = authResult.authorizationData?.[0];
    if (!authData?.authorizationToken || !authData?.proxyEndpoint) {
      throw new Error('Failed to get ECR auth');
    }

    const decoded = Buffer.from(authData.authorizationToken, 'base64').toString();
    const [username, password] = decoded.split(':');
    execSync(`docker login --username ${username} --password-stdin ${authData.proxyEndpoint}`, {
      input: password,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Tag and push the Lambda-wrapped image
    const remoteTag = `${ecrRepositoryUrl}:${tag}`;
    execSync(`docker tag ${lambdaImageName} ${remoteTag}`, { stdio: 'pipe' });
    execSync(`docker push ${remoteTag}`, { stdio: 'pipe' });

    // Get digest
    let imageUri: string;
    try {
      imageUri = execSync(`docker inspect --format='{{index .RepoDigests 0}}' ${remoteTag}`, {
        encoding: 'utf-8',
      }).trim();
    } catch {
      imageUri = remoteTag;
    }

    return { imageUri };
  }
}

export const buildService = new BuildService();
