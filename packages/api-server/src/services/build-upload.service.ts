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
import { getStorageService } from './storage.service';
import { scopePath } from './tenant-context';

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

    // Kubernetes-driven bases have no presigned-URL story — the
    // upload pipeline is the cloud path's reason for existing.
    // Callers running against a k8s base should be using
    // `createRemoteImage` with an image reference instead (pushed
    // to a registry the cluster can reach). Fail loud rather than
    // silently returning a useless empty uploadUrl.
    if (isKubernetesBase(config)) {
      throw new Error(
        `Upload-flow builds are not supported on ${config.type} bases. Use a remote-image build referencing a registry-pushed image.`
      );
    }

    if (!config.aws?.dataBucketName) {
      throw new Error('aws.dataBucketName is required for upload-flow builds');
    }
    // The build zip lives in S3 OUTSIDE the keyed `${collection}/`
    // keyspace, so it needs the same tenant scoping applied explicitly
    // (Quinn #2) — otherwise it is an unmodeled cross-tenant surface. The
    // scoped key is persisted as the build's `source`, so `resolve()`
    // reads it back already-scoped (no double-prefix). Flag-off ⇒
    // unchanged `builds/<id>.zip`.
    const s3Key = scopePath(`builds/${buildId}.zip`);
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

  async get(buildId: string): Promise<Build | null> {
    const storage = getStorageService();
    return storage.get<Build>(COLLECTION, buildId);
  }

  private async persist(record: Build): Promise<void> {
    const storage = getStorageService();
    await storage.set(COLLECTION, record.id, record);
  }
}

function getBaseConfig(): ApplianceBaseConfig {
  const raw = process.env.APPLIANCE_BASE_CONFIG;
  if (!raw) throw new Error('APPLIANCE_BASE_CONFIG not set');
  return applianceBaseConfig.parse(JSON.parse(raw));
}

export const buildUploadService = new BuildUploadService();
