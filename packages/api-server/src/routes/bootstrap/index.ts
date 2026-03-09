import { Router } from 'express';
import { timingSafeEqual } from 'crypto';
import { apiKeyInput } from '@appliance.sh/sdk';
import { apiKeyService } from '../../services/api-key.service';

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export const bootstrapRoutes = Router();

bootstrapRoutes.post('/create-key', async (req, res) => {
  try {
    const bootstrapToken = process.env.BOOTSTRAP_TOKEN;
    if (!bootstrapToken) {
      res.status(500).json({ error: 'Bootstrap token not configured' });
      return;
    }

    const providedToken = req.headers['x-bootstrap-token'] as string | undefined;
    if (!providedToken || !constantTimeEqual(providedToken, bootstrapToken)) {
      res.status(403).json({ error: 'Invalid bootstrap token' });
      return;
    }

    const input = apiKeyInput.parse(req.body);
    const result = await apiKeyService.create(input.name);
    res.status(201).json(result);
  } catch (error) {
    console.error('Create key error:', error);
    res.status(400).json({ error: 'Failed to create API key', message: String(error) });
  }
});

bootstrapRoutes.get('/status', async (_req, res) => {
  try {
    const initialized = await apiKeyService.exists();
    res.json({ initialized });
  } catch (error) {
    console.error('Bootstrap status error:', error);
    res.status(500).json({ error: 'Failed to check bootstrap status', message: String(error) });
  }
});
