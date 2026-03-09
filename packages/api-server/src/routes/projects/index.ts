import { Router } from 'express';
import { projectInput } from '@appliance.sh/sdk';
import { projectService } from '../../services/project.service';

export const projectRoutes = Router();

projectRoutes.post('/', async (req, res) => {
  try {
    const input = projectInput.parse(req.body);
    const project = await projectService.create(input);
    res.status(201).json(project);
  } catch (error) {
    console.error('Create project error:', error);
    res.status(400).json({ error: 'Failed to create project', message: String(error) });
  }
});

projectRoutes.get('/', async (_req, res) => {
  try {
    const projects = await projectService.list();
    res.json(projects);
  } catch (error) {
    console.error('List projects error:', error);
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
    console.error('Get project error:', error);
    res.status(500).json({ error: 'Failed to get project', message: String(error) });
  }
});

projectRoutes.delete('/:id', async (req, res) => {
  try {
    await projectService.delete(req.params.id);
    res.status(204).send();
  } catch (error) {
    console.error('Delete project error:', error);
    res.status(500).json({ error: 'Failed to delete project', message: String(error) });
  }
});
