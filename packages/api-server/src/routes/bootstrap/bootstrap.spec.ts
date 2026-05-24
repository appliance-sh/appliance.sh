import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockApiKeyService = vi.hoisted(() => ({
  create: vi.fn(),
  exists: vi.fn(),
}));

vi.mock('../../services/api-key.service', () => ({
  apiKeyService: mockApiKeyService,
}));

import { bootstrapRoutes } from './index';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/bootstrap', bootstrapRoutes);
  return app;
}

describe('Bootstrap routes', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv, BOOTSTRAP_TOKEN: 'test-token-123' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('POST /bootstrap/create-key', () => {
    it('should create API key with valid bootstrap token', async () => {
      mockApiKeyService.create.mockResolvedValue({
        id: 'ak_test',
        name: 'cli',
        secret: 'sk_secret',
        createdAt: '2025-01-01T00:00:00.000Z',
      });

      const app = createTestApp();
      const res = await request(app)
        .post('/bootstrap/create-key')
        .set('x-bootstrap-token', 'test-token-123')
        .send({ name: 'cli' });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('ak_test');
      expect(res.body.secret).toBe('sk_secret');
      expect(mockApiKeyService.create).toHaveBeenCalledWith('cli');
    });

    it('should return 403 for invalid bootstrap token', async () => {
      const app = createTestApp();
      const res = await request(app)
        .post('/bootstrap/create-key')
        .set('x-bootstrap-token', 'wrong-token')
        .send({ name: 'cli' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Invalid bootstrap token');
    });

    it('should return 403 when no token provided', async () => {
      const app = createTestApp();
      const res = await request(app).post('/bootstrap/create-key').send({ name: 'cli' });

      expect(res.status).toBe(403);
    });

    it('should return 500 when BOOTSTRAP_TOKEN not configured', async () => {
      delete process.env.BOOTSTRAP_TOKEN;

      const app = createTestApp();
      const res = await request(app)
        .post('/bootstrap/create-key')
        .set('x-bootstrap-token', 'any')
        .send({ name: 'cli' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Bootstrap token not configured');
    });

    it('should return 400 for invalid body', async () => {
      const app = createTestApp();
      const res = await request(app).post('/bootstrap/create-key').set('x-bootstrap-token', 'test-token-123').send({});

      expect(res.status).toBe(400);
    });
  });

  describe('GET /bootstrap/status', () => {
    it('should return initialized: false when no keys exist', async () => {
      mockApiKeyService.exists.mockResolvedValue(false);

      const app = createTestApp();
      const res = await request(app).get('/bootstrap/status');

      expect(res.status).toBe(200);
      expect(res.body.initialized).toBe(false);
    });

    it('should return initialized: true when keys exist', async () => {
      mockApiKeyService.exists.mockResolvedValue(true);

      const app = createTestApp();
      const res = await request(app).get('/bootstrap/status');

      expect(res.status).toBe(200);
      expect(res.body.initialized).toBe(true);
    });
  });
});
