import { Router } from 'express';
import { projectInput } from '@appliance.sh/sdk';
import { projectService } from '../../services/project.service';
import { logger } from '../../logger';

export const projectRoutes: Router = Router();

projectRoutes.post('/', async (req, res) => {
  try {
    const input = projectInput.parse(req.body);
    const project = await projectService.create(input);
    logger.info('project created', { requestId: req.requestId, projectId: project.id, projectName: project.name });
    res.status(201).json(project);
  } catch (error) {
    logger.error('create project failed', error, { requestId: req.requestId });
    res.status(400).json({ error: 'Failed to create project', message: String(error) });
  }
});

projectRoutes.get('/', async (req, res) => {
  try {
    const projects = await projectService.list();
    res.json(projects);
  } catch (error) {
    logger.error('list projects failed', error, { requestId: req.requestId });
    res.status(500).json({ error: 'Failed to list projects', message: String(error) });
  }
});

projectRoutes.get('/:id', async (req, res) => {
  try {
    const project = await projectService.get(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json(project);
  } catch (error) {
    logger.error('get project failed', error, { requestId: req.requestId, projectId: req.params.id });
    res.status(500).json({ error: 'Failed to get project', message: String(error) });
  }
});

projectRoutes.delete('/:id', async (req, res) => {
  try {
    await projectService.delete(req.params.id);
    logger.info('project deleted', { requestId: req.requestId, projectId: req.params.id });
    res.status(204).send();
  } catch (error) {
    logger.error('delete project failed', error, { requestId: req.requestId, projectId: req.params.id });
    res.status(500).json({ error: 'Failed to delete project', message: String(error) });
  }
});
