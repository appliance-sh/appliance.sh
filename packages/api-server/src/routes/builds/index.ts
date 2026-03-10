import { Router, raw } from 'express';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { applianceBaseConfig, generateId } from '@appliance.sh/sdk';

export const buildRoutes = Router();

// Accept raw binary body up to 500MB
buildRoutes.post('/', raw({ type: 'application/octet-stream', limit: '500mb' }), async (req, res) => {
  try {
    const configRaw = process.env.APPLIANCE_BASE_CONFIG;
    if (!configRaw) {
      res.status(500).json({ error: 'Base config not available' });
      return;
    }
    const config = applianceBaseConfig.parse(JSON.parse(configRaw));

    if (!config.aws.dataBucketName) {
      res.status(500).json({ error: 'Data bucket not configured' });
      return;
    }

    const body = req.body as Buffer;
    if (!body || body.length === 0) {
      res.status(400).json({ error: 'Empty body' });
      return;
    }

    const buildId = generateId('build');
    const s3Key = `builds/${buildId}.zip`;

    const s3 = new S3Client({ region: config.aws.region });
    await s3.send(
      new PutObjectCommand({
        Bucket: config.aws.dataBucketName,
        Key: s3Key,
        Body: body,
        ContentType: 'application/zip',
      })
    );

    res.status(201).json({ buildId, size: body.length });
  } catch (error) {
    console.error('Build upload error:', error);
    res.status(500).json({ error: 'Failed to upload build' });
  }
});
