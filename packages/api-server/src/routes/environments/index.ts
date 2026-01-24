import { Router } from 'express';
import { environmentInput } from '@appliance.sh/sdk';
import { environmentService } from '../../services/environment.service';

interface EnvironmentParams {
  projectId: string;
  id?: string;
}

export const environmentRoutes = Router({ mergeParams: true });

environmentRoutes.post('/', async (req, res) => {
  try {
    const params = req.params as EnvironmentParams;
    const input = environmentInput.parse({
      ...req.body,
      projectId: params.projectId,
    });
    const environment = await environmentService.create(input);
    res.status(201).json(environment);
  } catch (error) {
    console.error('Create environment error:', error);
    res.status(400).json({ error: 'Failed to create environment', message: String(error) });
  }
});

environmentRoutes.get('/', async (req, res) => {
  try {
    const params = req.params as EnvironmentParams;
    const environments = await environmentService.listByProject(params.projectId);
    res.json(environments);
  } catch (error) {
    console.error('List environments error:', error);
    res.status(500).json({ error: 'Failed to list environments', message: String(error) });
  }
});

environmentRoutes.get('/:id', async (req, res) => {
  try {
    const params = req.params as EnvironmentParams;
    const environment = await environmentService.get(params.id!);
    if (!environment) {
      res.status(404).json({ error: 'Environment not found' });
      return;
    }
    if (environment.projectId !== params.projectId) {
      res.status(404).json({ error: 'Environment not found' });
      return;
    }
    res.json(environment);
  } catch (error) {
    console.error('Get environment error:', error);
    res.status(500).json({ error: 'Failed to get environment', message: String(error) });
  }
});

environmentRoutes.delete('/:id', async (req, res) => {
  try {
    const params = req.params as EnvironmentParams;
    const environment = await environmentService.get(params.id!);
    if (environment && environment.projectId !== params.projectId) {
      res.status(404).json({ error: 'Environment not found' });
      return;
    }
    await environmentService.delete(params.id!);
    res.status(204).send();
  } catch (error) {
    console.error('Delete environment error:', error);
    res.status(500).json({ error: 'Failed to delete environment', message: String(error) });
  }
});
