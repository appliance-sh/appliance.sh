import { Router } from 'express';
import { deploymentInput } from '@appliance.sh/sdk';
import { deploymentService } from '../../services/deployment.service';

export const deploymentRoutes = Router();

deploymentRoutes.post('/', async (req, res) => {
  try {
    const input = deploymentInput.parse(req.body);
    const deployment = await deploymentService.execute(input);
    res.status(201).json(deployment);
  } catch (error) {
    console.error('Execute deployment error:', error);
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
    console.error('Get deployment error:', error);
    res.status(500).json({ error: 'Failed to get deployment', message: String(error) });
  }
});
