import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express, { type Request, type Response, type NextFunction } from 'express';

const mockApiKeyService = vi.hoisted(() => ({
  rotate: vi.fn(),
}));

vi.mock('../../services/api-key.service', () => ({
  apiKeyService: mockApiKeyService,
}));

import { keyRoutes } from './index';

// Stand-in for signatureAuth: the route only depends on req.apiKeyId,
// which the real middleware populates after verifying the signature.
// Passing `null` simulates an unauthenticated request reaching the
// handler (defence-in-depth check inside the route).
function createTestApp(apiKeyId: string | null) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (apiKeyId) req.apiKeyId = apiKeyId;
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
});
