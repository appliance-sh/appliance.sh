import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockDeploymentService = vi.hoisted(() => ({
  execute: vi.fn(),
  get: vi.fn(),
}));

vi.mock('../../services/deployment.service', () => ({
  deploymentService: mockDeploymentService,
  // The real class must survive the module mock — the route's catch
  // branches on `instanceof EnvironmentBusyError`, and an undefined
  // right-hand side turns every 400 into a 500 TypeError.
  EnvironmentBusyError: class EnvironmentBusyError extends Error {},
}));

const mockApiKeyService = vi.hoisted(() => ({
  getByKeyId: vi.fn(),
}));

vi.mock('../../services/api-key.service', () => ({
  apiKeyService: mockApiKeyService,
}));

import { deploymentRoutes } from './index';

function createTestApp() {
  const app = express();
  app.use(express.json());
  // Stand-in for the signature-auth middleware: the POST route reads
  // req.apiKeyId to re-sign the worker dispatch with the caller's key.
  app.use((req, _res, next) => {
    req.apiKeyId = 'ak_test';
    next();
  });
  app.use('/api/v1/deployments', deploymentRoutes);
  return app;
}

describe('Deployment routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockApiKeyService.getByKeyId.mockResolvedValue({ id: 'ak_test', secret: 'sk_test' });
  });

  describe('POST /api/v1/deployments', () => {
    it('should execute a deploy action', async () => {
      const mockDeployment = {
        id: 'deploy-1',
        environmentId: 'env-1',
        projectId: 'proj-1',
        action: 'deploy',
        status: 'succeeded',
        startedAt: '2025-01-01T00:00:00.000Z',
        completedAt: '2025-01-01T00:01:00.000Z',
      };
      mockDeploymentService.execute.mockResolvedValue(mockDeployment);

      const app = createTestApp();
      const res = await request(app).post('/api/v1/deployments').send({
        environmentId: 'env-1',
        action: 'deploy',
      });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('deploy-1');
      expect(res.body.action).toBe('deploy');
    });

    it('should execute a destroy action', async () => {
      const mockDeployment = {
        id: 'deploy-2',
        environmentId: 'env-1',
        action: 'destroy',
        status: 'succeeded',
      };
      mockDeploymentService.execute.mockResolvedValue(mockDeployment);

      const app = createTestApp();
      const res = await request(app).post('/api/v1/deployments').send({
        environmentId: 'env-1',
        action: 'destroy',
      });

      expect(res.status).toBe(201);
      expect(res.body.action).toBe('destroy');
    });

    it('should return 400 for invalid action', async () => {
      const app = createTestApp();
      const res = await request(app).post('/api/v1/deployments').send({
        environmentId: 'env-1',
        action: 'restart',
      });

      expect(res.status).toBe(400);
    });

    it('should return 400 for missing environmentId', async () => {
      const app = createTestApp();
      const res = await request(app).post('/api/v1/deployments').send({
        action: 'deploy',
      });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/deployments/:id', () => {
    it('should return a deployment by id', async () => {
      mockDeploymentService.get.mockResolvedValue({
        id: 'deploy-1',
        status: 'succeeded',
      });

      const app = createTestApp();
      const res = await request(app).get('/api/v1/deployments/deploy-1');

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('deploy-1');
    });

    it('should return 404 when deployment not found', async () => {
      mockDeploymentService.get.mockResolvedValue(null);

      const app = createTestApp();
      const res = await request(app).get('/api/v1/deployments/non-existent');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Deployment not found');
    });
  });
});
