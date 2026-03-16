import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { applianceBaseConfig, generateId } from '@appliance.sh/sdk';

export interface UploadRequest {
  buildId: string;
  uploadUrl: string;
}

export class BuildUploadService {
  async createUpload(): Promise<UploadRequest> {
    const configRaw = process.env.APPLIANCE_BASE_CONFIG;
    if (!configRaw) throw new Error('APPLIANCE_BASE_CONFIG not set');
    const config = applianceBaseConfig.parse(JSON.parse(configRaw));
    if (!config.aws.dataBucketName) throw new Error('Data bucket not configured');

    const buildId = generateId('build');
    const s3Key = `builds/${buildId}.zip`;

    const s3 = new S3Client({ region: config.aws.region });
    const command = new PutObjectCommand({
      Bucket: config.aws.dataBucketName,
      Key: s3Key,
      ContentType: 'application/zip',
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

    return { buildId, uploadUrl };
  }
}

export const buildUploadService = new BuildUploadService();
