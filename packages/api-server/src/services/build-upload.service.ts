import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  applianceBaseConfig,
  BuildType,
  generateId,
  isKubernetesBase,
  type ApplianceBaseConfig,
  type Build,
} from '@appliance.sh/sdk';
import { randomBytes } from 'node:crypto';
import { getStorageService } from './storage.service';
import { assertSupportedBase } from './deployment-backend';

const COLLECTION = 'builds';

export interface BuildUploadResult {
  buildId: string;
  /** Presigned PUT URL — present only for upload-flow builds. */
  uploadUrl?: string;
}

/**
 * Create a Build record. Two paths:
 *   - `createUpload()` (no args) → upload flow. A PUT URL is returned
 *     for the caller to send their zip to: a presigned S3 URL on
 *     cloud bases, or this server's own `/api/v1/builds/:id/content`
 *     endpoint (secured by a one-time token) on Kubernetes bases.
 *   - `createExternal(uploadUrl)` → external reference. The caller's
 *     URL is recorded as the build source; no upload.
 *
 * Both paths produce a Build record the deploy resolver can dispatch
 * on. For backwards compat with existing clients, calling the route
 * with no body preserves the upload-flow behavior.
 */
export class BuildUploadService {
  async createUpload(requestOrigin?: string): Promise<BuildUploadResult> {
    const config = getBaseConfig();
    // The single base fork (deployment-backend.ts) rejects the
    // removed docker base with migration guidance.
    assertSupportedBase(config);
    const buildId = generateId('build');

    // Kubernetes bases receive content directly: the server builds
    // the image itself (in-guest buildkitd → in-VM registry), so the
    // upload lands on the base's filesystem dataDir via a self-URL.
    // Requires a builder — bases without one (BYO clusters that
    // didn't advertise buildkit) keep the remote-image-only contract.
    if (isKubernetesBase(config)) {
      const buildkitAddr = config.kubernetes?.buildkit?.addr;
      if (!buildkitAddr) {
        throw new Error(
          'Upload-flow builds need a builder, and this base has none configured (kubernetes.buildkit.addr). ' +
            'Use a remote-image build referencing a container image instead.'
        );
      }
      if (!requestOrigin) {
        throw new Error('Upload-flow builds need the request origin to mint an upload URL');
      }
      const uploadToken = randomBytes(32).toString('hex');
      await this.persist({
        id: buildId,
        type: BuildType.Upload,
        source: `builds/${buildId}.zip`,
        uploadToken,
        createdAt: new Date().toISOString(),
      });
      const uploadUrl = `${requestOrigin}/api/v1/builds/${buildId}/content?token=${uploadToken}`;
      return { buildId, uploadUrl };
    }

    if (!config.aws?.dataBucketName) {
      throw new Error('aws.dataBucketName is required for upload-flow builds');
    }
    const s3Key = `builds/${buildId}.zip`;
    const s3 = new S3Client({ region: config.aws.region });
    const command = new PutObjectCommand({
      Bucket: config.aws.dataBucketName,
      Key: s3Key,
      ContentType: 'application/zip',
    });
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

    await this.persist({
      id: buildId,
      type: BuildType.Upload,
      source: s3Key,
      createdAt: new Date().toISOString(),
    });

    return { buildId, uploadUrl };
  }

  async createRemoteImage(uploadUrl: string, port?: number): Promise<BuildUploadResult> {
    const buildId = generateId('build');
    await this.persist({
      id: buildId,
      type: BuildType.RemoteImage,
      source: uploadUrl,
      port,
      createdAt: new Date().toISOString(),
    });
    return { buildId };
  }

  /** Flip an upload build to received: stamp uploadedAt, burn the token. */
  async markUploaded(buildId: string): Promise<void> {
    const build = await this.get(buildId);
    if (!build) throw new Error(`Build not found: ${buildId}`);
    await this.persist({
      ...build,
      uploadToken: undefined,
      uploadedAt: new Date().toISOString(),
    });
  }

  async get(buildId: string): Promise<Build | null> {
    const storage = getStorageService();
    return storage.get<Build>(COLLECTION, buildId);
  }

  private async persist(record: Build): Promise<void> {
    const storage = getStorageService();
    await storage.set(COLLECTION, record.id, record);
  }
}

export function getBaseConfig(): ApplianceBaseConfig {
  const raw = process.env.APPLIANCE_BASE_CONFIG;
  if (!raw) throw new Error('APPLIANCE_BASE_CONFIG not set');
  return applianceBaseConfig.parse(JSON.parse(raw));
}

export const buildUploadService = new BuildUploadService();
