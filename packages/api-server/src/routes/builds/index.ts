import { Router } from 'express';
import { buildUploadService } from '../../services/build-upload.service';
import { logger } from '../../logger';

export const buildRoutes: Router = Router();

buildRoutes.post('/', async (req, res) => {
  try {
    const result = await buildUploadService.createUpload();
    logger.info('build upload created', { requestId: req.requestId, buildId: result.buildId });
    res.status(201).json(result);
  } catch (error) {
    logger.error('create build upload failed', error, { requestId: req.requestId });
    res.status(500).json({ error: 'Failed to create build upload' });
  }
});
