import { Router } from 'express';
import { executeDeployment, type WorkerEvent } from '../../services/deployment-executor.service';
import { logger } from '../../logger';

export const internalRoutes: Router = Router();

internalRoutes.post('/jobs/deployment', async (req, res) => {
  const event = req.body as WorkerEvent;
  if (!event?.deploymentId || !event?.input || !event?.metadata) {
    res.status(400).json({ error: 'Invalid worker event payload' });
    return;
  }

  logger.info('worker job started', {
    requestId: req.requestId,
    deploymentId: event.deploymentId,
    action: event.input.action,
  });

  try {
    await executeDeployment(event);
    logger.info('worker job completed', { requestId: req.requestId, deploymentId: event.deploymentId });
    res.status(200).json({ ok: true });
  } catch (error) {
    logger.error('worker job failed', error, { requestId: req.requestId, deploymentId: event.deploymentId });
    // Status is already persisted by executeDeployment; return 500 so retries can occur if needed.
    res.status(500).json({ error: 'Job execution failed', message: String(error) });
  }
});
