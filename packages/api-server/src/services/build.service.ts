import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import { applianceBaseConfig, applianceInput } from '@appliance.sh/sdk';
import type { ApplianceContainer } from '@appliance.sh/sdk';
import { execSync } from 'child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface ResolvedBuild {
  imageUri?: string;
  codeS3Key?: string;
}

function getBaseConfig() {
  const raw = process.env.APPLIANCE_BASE_CONFIG;
  if (!raw) throw new Error('APPLIANCE_BASE_CONFIG not set');
  return applianceBaseConfig.parse(JSON.parse(raw));
}

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
      execSync(`unzip -o -q "${zipPath}" -d "${tmpDir}"`, { stdio: 'pipe' });

      // Read the manifest
      const manifestPath = path.join(tmpDir, 'appliance.json');
      if (!fs.existsSync(manifestPath)) throw new Error('Build missing appliance.json');
      const manifest = applianceInput.parse(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')));

      if (manifest.type === 'container') {
        return this.resolveContainer(tmpDir, manifest, tag, config);
      } else {
        // For framework/other, the zip is already in S3 — just reference it
        return { codeS3Key: s3Key };
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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

    // Load the user's original image into Docker
    execSync(`docker load -i "${imageTarPath}"`, { stdio: 'pipe' });

    // Wrap the image with the Lambda Web Adapter so the same plain HTTP
    // container works on both Lambda and ECS/Fargate without any changes.
    const lambdaImageName = `${manifest.name}-lambda`;
    const wrapperDockerfile = path.join(tmpDir, 'Dockerfile.lambda');
    fs.writeFileSync(
      wrapperDockerfile,
      [
        `FROM --platform=${manifest.platform} public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 AS adapter`,
        `FROM ${manifest.name}`,
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
