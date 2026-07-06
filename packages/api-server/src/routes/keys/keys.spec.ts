import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express, { type Request, type Response, type NextFunction } from 'express';

const mockApiKeyService = vi.hoisted(() => ({
  rotate: vi.fn(),
  getByKeyId: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../../services/api-key.service', () => ({
  apiKeyService: mockApiKeyService,
  roleOf: (key: { role?: string }) => key.role ?? 'admin',
}));

import { keyRoutes } from './index';

// Stand-in for signatureAuth: the routes only depend on req.apiKeyId +
// req.apiKeyRole, which the real middleware populates after verifying
// the signature. Passing `null` simulates an unauthenticated request
// reaching the handler (defence-in-depth check inside the route).
function createTestApp(apiKeyId: string | null, role: 'admin' | 'member' = 'admin') {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (apiKeyId) {
      req.apiKeyId = apiKeyId;
      req.apiKeyRole = role;
    }
    next();
  });
  app.use('/api/v1/keys', keyRoutes);
  return app;
}

describe('Key routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('POST /api/v1/keys/rotate', () => {
    it('rotates the calling key and returns the new credential', async () => {
      mockApiKeyService.rotate.mockResolvedValue({
        id: 'apikey_new',
        name: 'cli',
        secret: 'sk_new',
        createdAt: '2025-01-01T00:00:00.000Z',
      });

      const app = createTestApp('apikey_old');
      const res = await request(app).post('/api/v1/keys/rotate').send();

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('apikey_new');
      expect(res.body.secret).toBe('sk_new');
      expect(mockApiKeyService.rotate).toHaveBeenCalledWith('apikey_old');
    });

    it('returns 401 when the request is unauthenticated', async () => {
      const app = createTestApp(null);
      const res = await request(app).post('/api/v1/keys/rotate').send();

      expect(res.status).toBe(401);
      expect(mockApiKeyService.rotate).not.toHaveBeenCalled();
    });

    it('returns 404 when the calling key no longer exists', async () => {
      mockApiKeyService.rotate.mockResolvedValue(null);

      const app = createTestApp('apikey_gone');
      const res = await request(app).post('/api/v1/keys/rotate').send();

      expect(res.status).toBe(404);
    });

    it('returns 500 when rotation throws', async () => {
      mockApiKeyService.rotate.mockRejectedValue(new Error('storage down'));

      const app = createTestApp('apikey_old');
      const res = await request(app).post('/api/v1/keys/rotate').send();

      expect(res.status).toBe(500);
    });
  });

  describe('GET /api/v1/keys/self', () => {
    it('returns the calling key with role, without the secret', async () => {
      mockApiKeyService.getByKeyId.mockResolvedValue({
        id: 'apikey_me',
        name: 'eliot',
        secret: 'sk_never-leak',
        createdAt: '2025-01-01T00:00:00.000Z',
        role: 'member',
      });

      const app = createTestApp('apikey_me', 'member');
      const res = await request(app).get('/api/v1/keys/self');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id: 'apikey_me',
        name: 'eliot',
        role: 'member',
        createdAt: '2025-01-01T00:00:00.000Z',
      });
      expect(res.body.secret).toBeUndefined();
    });

    it('reads pre-role keys as admin', async () => {
      mockApiKeyService.getByKeyId.mockResolvedValue({
        id: 'apikey_legacy',
        name: 'operator',
        secret: 'sk_x',
        createdAt: '2025-01-01T00:00:00.000Z',
      });

      const app = createTestApp('apikey_legacy');
      const res = await request(app).get('/api/v1/keys/self');

      expect(res.status).toBe(200);
      expect(res.body.role).toBe('admin');
    });
  });

  describe('GET /api/v1/keys', () => {
    it('lists key summaries for admins', async () => {
      mockApiKeyService.list.mockResolvedValue([
        { id: 'apikey_a', name: 'operator', role: 'admin', createdAt: '2025-01-01T00:00:00.000Z' },
        { id: 'apikey_b', name: 'teammate', role: 'member', createdAt: '2025-01-02T00:00:00.000Z' },
      ]);

      const app = createTestApp('apikey_a', 'admin');
      const res = await request(app).get('/api/v1/keys');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it('refuses member keys with 403', async () => {
      const app = createTestApp('apikey_b', 'member');
      const res = await request(app).get('/api/v1/keys');

      expect(res.status).toBe(403);
      expect(mockApiKeyService.list).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/keys', () => {
    it('mints a member key by default', async () => {
      mockApiKeyService.create.mockResolvedValue({
        id: 'apikey_new',
        name: 'teammate',
        secret: 'sk_new',
        createdAt: '2025-01-01T00:00:00.000Z',
        role: 'member',
      });

      const app = createTestApp('apikey_admin', 'admin');
      const res = await request(app).post('/api/v1/keys').send({ name: 'teammate' });

      expect(res.status).toBe(201);
      expect(mockApiKeyService.create).toHaveBeenCalledWith('teammate', 'member');
    });

    it('refuses member keys with 403', async () => {
      const app = createTestApp('apikey_member', 'member');
      const res = await request(app).post('/api/v1/keys').send({ name: 'x' });

      expect(res.status).toBe(403);
      expect(mockApiKeyService.create).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/v1/keys/:id', () => {
    it('revokes another key', async () => {
      mockApiKeyService.getByKeyId.mockResolvedValue({
        id: 'apikey_other',
        name: 'x',
        secret: 'sk_x',
        createdAt: '2025-01-01T00:00:00.000Z',
      });

      const app = createTestApp('apikey_admin', 'admin');
      const res = await request(app).delete('/api/v1/keys/apikey_other');

      expect(res.status).toBe(204);
      expect(mockApiKeyService.delete).toHaveBeenCalledWith('apikey_other');
    });

    it('refuses to revoke the calling key (409)', async () => {
      const app = createTestApp('apikey_admin', 'admin');
      const res = await request(app).delete('/api/v1/keys/apikey_admin');

      expect(res.status).toBe(409);
      expect(mockApiKeyService.delete).not.toHaveBeenCalled();
    });

    it('returns 404 for unknown keys', async () => {
      mockApiKeyService.getByKeyId.mockResolvedValue(null);

      const app = createTestApp('apikey_admin', 'admin');
      const res = await request(app).delete('/api/v1/keys/apikey_missing');

      expect(res.status).toBe(404);
    });

    it('refuses member keys with 403', async () => {
      const app = createTestApp('apikey_member', 'member');
      const res = await request(app).delete('/api/v1/keys/apikey_other');

      expect(res.status).toBe(403);
      expect(mockApiKeyService.delete).not.toHaveBeenCalled();
    });
  });
});
