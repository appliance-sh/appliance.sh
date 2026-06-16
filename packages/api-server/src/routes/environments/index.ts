import { Router, type Request, type Response } from 'express';
import { environmentInput, envVarsInput } from '@appliance.sh/sdk';
import { environmentService } from '../../services/environment.service';
import { envVarService } from '../../services/env-var.service';
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
    // Drop the environment's stored variables too — they're meaningless
    // without the environment and shouldn't linger as orphaned secrets.
    await envVarService.clear(params.id!);
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

// ---- per-environment variables ("environment secrets") -----------------
//
// Stored server-side on the environment and injected into every deploy
// (see deployment.service). Listing returns key names only — values are
// never read back, so a leaked listing can't leak a secret.

/** Resolve the environment in the path and confirm it belongs to the
 *  project. Returns the id on success; writes a 404 and returns null
 *  otherwise so callers can `return` straight away. */
async function resolveEnvId(req: Request, res: Response): Promise<string | null> {
  // Express types req.params as ParamsDictionary on a bare Request; the
  // route is mounted with mergeParams so projectId + id are present.
  const params = req.params as unknown as EnvironmentParams;
  const environment = await environmentService.get(params.id!);
  if (!environment || environment.projectId !== params.projectId) {
    res.status(404).json({ error: 'Environment not found' });
    return null;
  }
  return environment.id;
}

environmentRoutes.get('/:id/env', async (req, res) => {
  try {
    const envId = await resolveEnvId(req, res);
    if (!envId) return;
    const keys = await envVarService.listKeys(envId);
    res.json({ keys });
  } catch (error) {
    logger.error('list env vars failed', error, { requestId: req.requestId });
    res.status(500).json({ error: 'Failed to list environment variables' });
  }
});

environmentRoutes.put('/:id/env', async (req, res) => {
  try {
    const envId = await resolveEnvId(req, res);
    if (!envId) return;
    const input = envVarsInput.parse(req.body);
    const keys = await envVarService.setMany(envId, input.variables);
    // Log the key names that were set — never the values.
    logger.info('env vars set', {
      requestId: req.requestId,
      environmentId: envId,
      keys: Object.keys(input.variables).sort(),
    });
    res.json({ keys });
  } catch (error) {
    logger.error('set env vars failed', error, { requestId: req.requestId });
    res.status(400).json({ error: 'Failed to set environment variables', message: String(error) });
  }
});

environmentRoutes.delete('/:id/env/:key', async (req, res) => {
  try {
    const envId = await resolveEnvId(req, res);
    if (!envId) return;
    const key = req.params.key;
    const keys = await envVarService.unset(envId, [key]);
    logger.info('env var unset', { requestId: req.requestId, environmentId: envId, key });
    res.json({ keys });
  } catch (error) {
    logger.error('unset env var failed', error, { requestId: req.requestId });
    res.status(500).json({ error: 'Failed to unset environment variable' });
  }
});
