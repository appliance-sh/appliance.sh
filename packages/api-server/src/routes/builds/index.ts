import { Router } from 'express';
import { buildCreateInput, BuildType } from '@appliance.sh/sdk';
import { buildUploadService } from '../../services/build-upload.service';
import { logger } from '../../logger';

export const buildRoutes: Router = Router();

buildRoutes.post('/', async (req, res) => {
  try {
    const parsed = buildCreateInput.safeParse(req.body ?? {});
    if (!parsed.success) {
      logger.warn('invalid build input', { requestId: req.requestId, error: parsed.error.message });
      res.status(400).json({ error: 'Invalid build input', message: parsed.error.message });
      return;
    }

    const result =
      parsed.data.type === BuildType.RemoteImage
        ? await buildUploadService.createRemoteImage(parsed.data.uploadUrl)
        : await buildUploadService.createUpload();

    logger.info('build created', {
      requestId: req.requestId,
      buildId: result.buildId,
      type: parsed.data.type,
    });
    res.status(201).json(result);
  } catch (error) {
    logger.error('create build failed', error, { requestId: req.requestId });
    res.status(500).json({ error: 'Failed to create build' });
  }
});
