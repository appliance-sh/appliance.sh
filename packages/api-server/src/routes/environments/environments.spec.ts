import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockEnvironmentService = vi.hoisted(() => ({
  create: vi.fn(),
  listByProject: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../../services/environment.service', () => ({
  environmentService: mockEnvironmentService,
}));

const mockProjectService = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock('../../services/project.service', () => ({
  projectService: mockProjectService,
}));

const mockEnvVarService = vi.hoisted(() => ({
  listKeys: vi.fn(),
  setMany: vi.fn(),
  unset: vi.fn(),
  clear: vi.fn(),
}));

vi.mock('../../services/env-var.service', () => ({
  envVarService: mockEnvVarService,
}));

import { environmentRoutes } from './index';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/projects/:projectId/environments', environmentRoutes);
  return app;
}

describe('Environment routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // The create route resolves the project first (its name seeds the
    // environment's stackName) and 404s when missing.
    mockProjectService.get.mockResolvedValue({ id: 'proj-1', name: 'proj-1' });
  });

  describe('POST /api/v1/projects/:projectId/environments', () => {
    it('should create an environment', async () => {
      const mockEnv = {
        id: 'env-1',
        name: 'production',
        projectId: 'proj-1',
        status: 'pending',
        stackName: 'proj-1-env-1',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      };
      mockEnvironmentService.create.mockResolvedValue(mockEnv);

      const app = createTestApp();
      const res = await request(app)
        .post('/api/v1/projects/proj-1/environments')
        .send({
          name: 'production',
          baseConfig: {
            name: 'test',
            type: 'appliance-base-aws-public',
            stateBackendUrl: 's3://bucket/state',
            aws: { region: 'us-east-1', zoneId: 'Z123' },
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('env-1');
      expect(res.body.projectId).toBe('proj-1');
    });

    it('should return 400 for missing baseConfig', async () => {
      const app = createTestApp();
      const res = await request(app).post('/api/v1/projects/proj-1/environments').send({
        name: 'production',
      });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/projects/:projectId/environments', () => {
    it('should list environments for a project', async () => {
      mockEnvironmentService.listByProject.mockResolvedValue([
        { id: 'env-1', name: 'prod', projectId: 'proj-1' },
        { id: 'env-2', name: 'staging', projectId: 'proj-1' },
      ]);

      const app = createTestApp();
      const res = await request(app).get('/api/v1/projects/proj-1/environments');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(mockEnvironmentService.listByProject).toHaveBeenCalledWith('proj-1');
    });
  });

  describe('GET /api/v1/projects/:projectId/environments/:id', () => {
    it('should return an environment', async () => {
      mockEnvironmentService.get.mockResolvedValue({
        id: 'env-1',
        name: 'production',
        projectId: 'proj-1',
      });

      const app = createTestApp();
      const res = await request(app).get('/api/v1/projects/proj-1/environments/env-1');

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('env-1');
    });

    it('should return 404 when environment not found', async () => {
      mockEnvironmentService.get.mockResolvedValue(null);

      const app = createTestApp();
      const res = await request(app).get('/api/v1/projects/proj-1/environments/env-999');

      expect(res.status).toBe(404);
    });

    it('should return 404 when environment belongs to different project', async () => {
      mockEnvironmentService.get.mockResolvedValue({
        id: 'env-1',
        name: 'production',
        projectId: 'proj-2',
      });

      const app = createTestApp();
      const res = await request(app).get('/api/v1/projects/proj-1/environments/env-1');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Environment not found');
    });
  });

  describe('DELETE /api/v1/projects/:projectId/environments/:id', () => {
    it('should delete an environment', async () => {
      mockEnvironmentService.get.mockResolvedValue({
        id: 'env-1',
        projectId: 'proj-1',
      });
      mockEnvironmentService.delete.mockResolvedValue(undefined);

      const app = createTestApp();
      const res = await request(app).delete('/api/v1/projects/proj-1/environments/env-1');

      expect(res.status).toBe(204);
    });

    it('should return 404 when deleting environment from wrong project', async () => {
      mockEnvironmentService.get.mockResolvedValue({
        id: 'env-1',
        projectId: 'proj-2',
      });

      const app = createTestApp();
      const res = await request(app).delete('/api/v1/projects/proj-1/environments/env-1');

      expect(res.status).toBe(404);
    });

    it('clears the environment env vars on delete', async () => {
      mockEnvironmentService.get.mockResolvedValue({ id: 'env-1', projectId: 'proj-1' });
      mockEnvironmentService.delete.mockResolvedValue(undefined);
      mockEnvVarService.clear.mockResolvedValue(undefined);

      const app = createTestApp();
      await request(app).delete('/api/v1/projects/proj-1/environments/env-1');

      expect(mockEnvVarService.clear).toHaveBeenCalledWith('env-1');
    });
  });

  describe('per-environment variables', () => {
    beforeEach(() => {
      mockEnvironmentService.get.mockResolvedValue({ id: 'env-1', projectId: 'proj-1' });
    });

    it('lists variable key names', async () => {
      mockEnvVarService.listKeys.mockResolvedValue(['API_KEY', 'DB_URL']);

      const app = createTestApp();
      const res = await request(app).get('/api/v1/projects/proj-1/environments/env-1/env');

      expect(res.status).toBe(200);
      expect(res.body.keys).toEqual(['API_KEY', 'DB_URL']);
    });

    it('sets variables and returns resulting keys', async () => {
      mockEnvVarService.setMany.mockResolvedValue(['API_KEY']);

      const app = createTestApp();
      const res = await request(app)
        .put('/api/v1/projects/proj-1/environments/env-1/env')
        .send({ variables: { API_KEY: 'sekret' } });

      expect(res.status).toBe(200);
      expect(res.body.keys).toEqual(['API_KEY']);
      expect(mockEnvVarService.setMany).toHaveBeenCalledWith('env-1', { API_KEY: 'sekret' });
    });

    it('rejects invalid variable names', async () => {
      const app = createTestApp();
      const res = await request(app)
        .put('/api/v1/projects/proj-1/environments/env-1/env')
        .send({ variables: { '1bad-name': 'x' } });

      expect(res.status).toBe(400);
      expect(mockEnvVarService.setMany).not.toHaveBeenCalled();
    });

    it('unsets a variable', async () => {
      mockEnvVarService.unset.mockResolvedValue([]);

      const app = createTestApp();
      const res = await request(app).delete('/api/v1/projects/proj-1/environments/env-1/env/API_KEY');

      expect(res.status).toBe(200);
      expect(mockEnvVarService.unset).toHaveBeenCalledWith('env-1', ['API_KEY']);
    });

    it('404s for an env var op on an environment in the wrong project', async () => {
      mockEnvironmentService.get.mockResolvedValue({ id: 'env-1', projectId: 'proj-2' });

      const app = createTestApp();
      const res = await request(app).get('/api/v1/projects/proj-1/environments/env-1/env');

      expect(res.status).toBe(404);
    });
  });
});
