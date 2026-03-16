import { Router } from 'express';
import { deploymentInput } from '@appliance.sh/sdk';
import { deploymentService } from '../../services/deployment.service';
import { logger } from '../../logger';

export const deploymentRoutes = Router();

deploymentRoutes.post('/', async (req, res) => {
  try {
    const input = deploymentInput.parse(req.body);
    logger.info('deployment started', {
      requestId: req.requestId,
      environmentId: input.environmentId,
      action: input.action,
      buildId: input.buildId,
    });
    const deployment = await deploymentService.execute(input);
    logger.info('deployment completed', {
      requestId: req.requestId,
      deploymentId: deployment.id,
      status: deployment.status,
    });
    res.status(201).json(deployment);
  } catch (error) {
    logger.error('execute deployment failed', error, { requestId: req.requestId });
    res.status(400).json({ error: 'Failed to execute deployment', message: String(error) });
  }
});

deploymentRoutes.get('/:id', async (req, res) => {
  try {
    const deployment = await deploymentService.get(req.params.id);
    if (!deployment) {
      res.status(404).json({ error: 'Deployment not found' });
      return;
    }
    res.json(deployment);
  } catch (error) {
    logger.error('get deployment failed', error, { requestId: req.requestId, deploymentId: req.params.id });
    res.status(500).json({ error: 'Failed to get deployment', message: String(error) });
  }
});
