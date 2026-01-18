import { Router } from 'express';
import { pulumiService } from '../../services/pulumi.service';

export const infraRoutes = Router();

infraRoutes.post('/deploy', async (_req, res) => {
  try {
    const result = await pulumiService.deploy();
    res.json(result);
  } catch (error) {
    console.error('Deploy error:', error);
    res.status(500).json({ error: 'Deploy failed', message: String(error) });
  }
});

infraRoutes.post('/destroy', async (_req, res) => {
  try {
    const result = await pulumiService.destroy();
    res.json(result);
  } catch (error) {
    console.error('Destroy error:', error);
    res.status(500).json({ error: 'Destroy failed', message: String(error) });
  }
});
