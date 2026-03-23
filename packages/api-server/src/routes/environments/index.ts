import { Router } from 'express';
import { environmentInput } from '@appliance.sh/sdk';
import { environmentService } from '../../services/environment.service';
import { projectService } from '../../services/project.service';
import { logger } from '../../logger';

interface EnvironmentParams {
  projectId: string;
  id?: string;
}

export const environmentRoutes: Router = Router({ mergeParams: true });

environmentRoutes.post('/', async (req, res) => {
  try {
    const params = req.params as EnvironmentParams;
    const project = await projectService.get(params.projectId);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const input = environmentInput.parse({
      ...req.body,
      projectId: params.projectId,
    });
    const environment = await environmentService.create(input, project.name);
    logger.info('environment created', {
      requestId: req.requestId,
      projectId: params.projectId,
      environmentId: environment.id,
      environmentName: environment.name,
    });
    res.status(201).json(environment);
  } catch (error) {
    logger.error('create environment failed', error, {
      requestId: req.requestId,
      projectId: (req.params as EnvironmentParams).projectId,
    });
    res.status(400).json({ error: 'Failed to create environment', message: String(error) });
  }
});

environmentRoutes.get('/', async (req, res) => {
  try {
    const params = req.params as EnvironmentParams;
    const environments = await environmentService.listByProject(params.projectId);
    res.json(environments);
  } catch (error) {
    logger.error('list environments failed', error, {
      requestId: req.requestId,
      projectId: (req.params as EnvironmentParams).projectId,
    });
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
    logger.error('get environment failed', error, {
      requestId: req.requestId,
      projectId: (req.params as EnvironmentParams).projectId,
      environmentId: (req.params as EnvironmentParams).id,
    });
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
    logger.info('environment deleted', {
      requestId: req.requestId,
      projectId: params.projectId,
      environmentId: params.id,
    });
    res.status(204).send();
  } catch (error) {
    logger.error('delete environment failed', error, {
      requestId: req.requestId,
      projectId: (req.params as EnvironmentParams).projectId,
      environmentId: (req.params as EnvironmentParams).id,
    });
    res.status(500).json({ error: 'Failed to delete environment', message: String(error) });
  }
});
