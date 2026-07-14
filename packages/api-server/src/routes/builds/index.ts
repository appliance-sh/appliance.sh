import { Router } from 'express';
import { buildCreateInput, BuildType } from '@appliance.sh/sdk';
import { buildUploadService, MissingBuilderError } from '../../services/build-upload.service';
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

    // Kubernetes bases mint a self-URL for the content PUT — derive
    // the origin from the request so the URL is reachable wherever
    // the caller reached us (host-forwarded port, ingress hostname…).
    const requestOrigin = `${req.protocol}://${req.get('host')}`;
    const result =
      parsed.data.type === BuildType.RemoteImage
        ? await buildUploadService.createRemoteImage(parsed.data.uploadUrl, parsed.data.port)
        : await buildUploadService.createUpload(requestOrigin);

    logger.info('build created', {
      requestId: req.requestId,
      buildId: result.buildId,
      type: parsed.data.type,
    });
    res.status(201).json(result);
  } catch (error) {
    // Base precondition, not a fault: no builder is advertised on this
    // base. 409 carries the remediation for clients to show verbatim.
    if (error instanceof MissingBuilderError) {
      logger.warn('build rejected: no builder on this base', {
        requestId: req.requestId,
        error: error.message,
      });
      res.status(409).json({ error: error.message, requestId: req.requestId });
      return;
    }
    logger.error('create build failed', error, { requestId: req.requestId });
    // `detail` + `requestId` let a client surface something actionable
    // (and quotable against the server log) instead of a bare 500.
    res.status(500).json({
      error: 'Failed to create build',
      detail: error instanceof Error ? error.message : String(error),
      requestId: req.requestId,
    });
  }
});
