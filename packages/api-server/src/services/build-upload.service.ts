import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { applianceBaseConfig, BuildType, generateId, type Build } from '@appliance.sh/sdk';
import { getStorageService } from './storage.service';

const COLLECTION = 'builds';

export interface BuildUploadResult {
  buildId: string;
  /** Presigned PUT URL — present only for upload-flow builds. */
  uploadUrl?: string;
}

/**
 * Create a Build record. Two paths:
 *   - `createUpload()` (no args) → upload flow. Presigned S3 URL
 *     returned for the caller to PUT their zip to.
 *   - `createExternal(uploadUrl)` → external reference. The caller's
 *     URL is recorded as the build source; no upload.
 *
 * Both paths produce a Build record the deploy resolver can dispatch
 * on. For backwards compat with existing clients, calling the route
 * with no body preserves the upload-flow behavior.
 */
export class BuildUploadService {
  async createUpload(): Promise<BuildUploadResult> {
    const config = getBaseConfig();
    const buildId = generateId('build');
    const s3Key = `builds/${buildId}.zip`;

    const s3 = new S3Client({ region: config.aws.region });
    const command = new PutObjectCommand({
      Bucket: config.aws.dataBucketName!,
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

  async createRemoteImage(uploadUrl: string): Promise<BuildUploadResult> {
    const buildId = generateId('build');
    await this.persist({
      id: buildId,
      type: BuildType.RemoteImage,
      source: uploadUrl,
      createdAt: new Date().toISOString(),
    });
    return { buildId };
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

function getBaseConfig() {
  const raw = process.env.APPLIANCE_BASE_CONFIG;
  if (!raw) throw new Error('APPLIANCE_BASE_CONFIG not set');
  const config = applianceBaseConfig.parse(JSON.parse(raw));
  if (!config.aws.dataBucketName) throw new Error('Data bucket not configured');
  return config;
}

export const buildUploadService = new BuildUploadService();
