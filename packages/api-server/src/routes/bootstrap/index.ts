import { Router } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import { apiKeyInput } from '@appliance.sh/sdk';
import { apiKeyService } from '../../services/api-key.service';
import { logger } from '../../logger';

function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export const bootstrapRoutes: Router = Router();

bootstrapRoutes.post('/create-key', async (req, res) => {
  try {
    const bootstrapToken = process.env.BOOTSTRAP_TOKEN;
    if (!bootstrapToken) {
      res.status(500).json({ error: 'Bootstrap token not configured' });
      return;
    }

    const providedToken = req.headers['x-bootstrap-token'] as string | undefined;
    if (!providedToken || !constantTimeEqual(providedToken, bootstrapToken)) {
      logger.warn('bootstrap auth failed', { requestId: req.requestId });
      res.status(403).json({ error: 'Invalid bootstrap token' });
      return;
    }

    const input = apiKeyInput.parse(req.body);
    const result = await apiKeyService.create(input.name);
    logger.info('api key created', { requestId: req.requestId, keyName: input.name });
    res.status(201).json(result);
  } catch (error) {
    logger.error('create key failed', error, { requestId: req.requestId });
    res.status(400).json({ error: 'Failed to create API key', message: String(error) });
  }
});

bootstrapRoutes.get('/status', async (req, res) => {
  try {
    const initialized = await apiKeyService.exists();
    res.json({ initialized });
  } catch (error) {
    logger.error('bootstrap status check failed', error, { requestId: req.requestId });
    res.status(500).json({ error: 'Failed to check bootstrap status', message: String(error) });
  }
});
