import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { BuildType, getKubernetesParams } from '@appliance.sh/sdk';
import { buildUploadService } from '../../services/build-upload.service';
import { getBaseConfig } from '../../services/build-upload.service';
import { writeBuildContent, BuildContentTooLargeError } from '../../services/image-build.service';
import { logger } from '../../logger';

// Direct build-content upload — the Kubernetes bases' counterpart to
// the cloud path's presigned S3 PUT. Mounted WITHOUT signatureAuth:
// the one-time `token` minted by `POST /api/v1/builds` is the entire
// authorization, mirroring how a presigned URL works. Everything else
// under /api/v1/builds stays behind request signing.

export const buildContentRoutes: Router = Router();

function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

buildContentRoutes.put('/:id/content', async (req, res) => {
  try {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const build = await buildUploadService.get(req.params.id);

    // One 404 for "no such build", "not an upload build", "already
    // uploaded", and "bad token" — don't oracle which it was.
    if (
      !build ||
      build.type !== BuildType.Upload ||
      build.uploadedAt ||
      !build.uploadToken ||
      !token ||
      !tokenMatches(build.uploadToken, token)
    ) {
      res.status(404).json({ error: 'Build not found' });
      return;
    }

    const k8s = getKubernetesParams(getBaseConfig());
    if (!k8s) {
      res.status(409).json({ error: 'Direct build uploads are not supported on this base' });
      return;
    }

    const bytes = await writeBuildContent(k8s.dataDir, build.id, req);
    await buildUploadService.markUploaded(build.id);
    logger.info('build content received', { requestId: req.requestId, buildId: build.id, bytes });
    res.status(200).json({ buildId: build.id, bytes });
  } catch (error) {
    if (error instanceof BuildContentTooLargeError) {
      logger.warn('build content too large', { requestId: req.requestId, buildId: req.params.id });
      res.status(413).json({ error: error.message });
      return;
    }
    logger.error('build content upload failed', error, { requestId: req.requestId, buildId: req.params.id });
    res.status(500).json({ error: 'Failed to receive build content' });
  }
});
