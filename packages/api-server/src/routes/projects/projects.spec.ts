import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockProjectService = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../../services/project.service', () => ({
  projectService: mockProjectService,
}));

import { projectRoutes } from './index';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/projects', projectRoutes);
  return app;
}

describe('Project routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('POST /api/v1/projects', () => {
    it('should create a project', async () => {
      const mockProject = {
        id: 'proj-1',
        name: 'my-project',
        status: 'active',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      };
      mockProjectService.create.mockResolvedValue(mockProject);

      const app = createTestApp();
      const res = await request(app).post('/api/v1/projects').send({ name: 'my-project' });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('proj-1');
      expect(res.body.name).toBe('my-project');
    });

    it('should return 400 for invalid input', async () => {
      const app = createTestApp();
      const res = await request(app).post('/api/v1/projects').send({});

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/projects', () => {
    it('should list all projects', async () => {
      mockProjectService.list.mockResolvedValue([
        { id: 'proj-1', name: 'project-1' },
        { id: 'proj-2', name: 'project-2' },
      ]);

      const app = createTestApp();
      const res = await request(app).get('/api/v1/projects');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it('should return empty array when no projects', async () => {
      mockProjectService.list.mockResolvedValue([]);

      const app = createTestApp();
      const res = await request(app).get('/api/v1/projects');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });
  });

  describe('GET /api/v1/projects/:id', () => {
    it('should return a project by id', async () => {
      mockProjectService.get.mockResolvedValue({
        id: 'proj-1',
        name: 'my-project',
      });

      const app = createTestApp();
      const res = await request(app).get('/api/v1/projects/proj-1');

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('proj-1');
    });

    it('should return 404 when project not found', async () => {
      mockProjectService.get.mockResolvedValue(null);

      const app = createTestApp();
      const res = await request(app).get('/api/v1/projects/non-existent');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Project not found');
    });
  });

  describe('DELETE /api/v1/projects/:id', () => {
    it('should delete a project', async () => {
      mockProjectService.delete.mockResolvedValue(undefined);

      const app = createTestApp();
      const res = await request(app).delete('/api/v1/projects/proj-1');

      expect(res.status).toBe(204);
      expect(mockProjectService.delete).toHaveBeenCalledWith('proj-1');
    });
  });
});
