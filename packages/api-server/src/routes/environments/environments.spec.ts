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
  });
});
