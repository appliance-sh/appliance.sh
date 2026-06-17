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

const mockEnvironmentHealthService = vi.hoisted(() => ({
  getForEnvironment: vi.fn(),
}));

vi.mock('../../services/environment-health.service', () => ({
  environmentHealthService: mockEnvironmentHealthService,
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

  describe('GET /api/v1/projects/:projectId/environments/:id/health', () => {
    it('returns health for an environment in the project', async () => {
      mockEnvironmentService.get.mockResolvedValue({ id: 'env-1', projectId: 'proj-1' });
      mockEnvironmentHealthService.getForEnvironment.mockResolvedValue({
        environmentId: 'env-1',
        status: 'healthy',
        desiredReplicas: 1,
        readyReplicas: 1,
        restarts: 0,
        pods: [{ name: 'env-1-abc', phase: 'Running', ready: true, restarts: 0 }],
        usage: { cpuMillicores: 12, memoryBytes: 67108864 },
      });

      const app = createTestApp();
      const res = await request(app).get('/api/v1/projects/proj-1/environments/env-1/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('healthy');
      expect(res.body.usage.cpuMillicores).toBe(12);
      expect(mockEnvironmentHealthService.getForEnvironment).toHaveBeenCalledWith('env-1');
    });

    it('returns 404 when the environment does not exist', async () => {
      mockEnvironmentService.get.mockResolvedValue(null);

      const app = createTestApp();
      const res = await request(app).get('/api/v1/projects/proj-1/environments/env-999/health');

      expect(res.status).toBe(404);
      expect(mockEnvironmentHealthService.getForEnvironment).not.toHaveBeenCalled();
    });

    it('returns 404 when the environment belongs to a different project', async () => {
      mockEnvironmentService.get.mockResolvedValue({ id: 'env-1', projectId: 'proj-2' });

      const app = createTestApp();
      const res = await request(app).get('/api/v1/projects/proj-1/environments/env-1/health');

      expect(res.status).toBe(404);
      expect(mockEnvironmentHealthService.getForEnvironment).not.toHaveBeenCalled();
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
  });
});
