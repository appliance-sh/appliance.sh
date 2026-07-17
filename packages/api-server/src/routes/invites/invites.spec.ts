import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express, { type Request, type Response, type NextFunction } from 'express';

const mockInviteService = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../../services/invite.service', () => ({
  inviteService: mockInviteService,
}));

import { inviteRoutes } from './index';

// Stand-in for signatureAuth (see keys.spec.ts).
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
  app.use('/api/v1/invites', inviteRoutes);
  return app;
}

const SAMPLE_INVITE = {
  id: 'invite_1',
  token: 'inv_abc',
  name: 'teammate',
  role: 'member' as const,
  createdAt: '2025-01-01T00:00:00.000Z',
  expiresAt: '2025-01-08T00:00:00.000Z',
};

describe('Invite routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('POST /api/v1/invites', () => {
    it('creates an invite and returns the token once', async () => {
      mockInviteService.create.mockResolvedValue(SAMPLE_INVITE);

      const app = createTestApp('apikey_admin', 'admin');
      const res = await request(app).post('/api/v1/invites').send({ name: 'teammate' });

      expect(res.status).toBe(201);
      expect(res.body.token).toBe('inv_abc');
      expect(mockInviteService.create).toHaveBeenCalledWith({ name: 'teammate' });
    });

    it('rejects an empty name with 400', async () => {
      const app = createTestApp('apikey_admin', 'admin');
      const res = await request(app).post('/api/v1/invites').send({ name: '' });

      expect(res.status).toBe(400);
      expect(mockInviteService.create).not.toHaveBeenCalled();
    });

    it('refuses member keys with 403', async () => {
      const app = createTestApp('apikey_member', 'member');
      const res = await request(app).post('/api/v1/invites').send({ name: 'teammate' });

      expect(res.status).toBe(403);
      expect(mockInviteService.create).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/invites', () => {
    it('lists invites for admins', async () => {
      const { token: _token, ...summary } = SAMPLE_INVITE;
      mockInviteService.list.mockResolvedValue([summary]);

      const app = createTestApp('apikey_admin', 'admin');
      const res = await request(app).get('/api/v1/invites');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].token).toBeUndefined();
    });

    it('refuses member keys with 403', async () => {
      const app = createTestApp('apikey_member', 'member');
      const res = await request(app).get('/api/v1/invites');

      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /api/v1/invites/:id', () => {
    it('revokes an invite', async () => {
      const app = createTestApp('apikey_admin', 'admin');
      const res = await request(app).delete('/api/v1/invites/invite_1');

      expect(res.status).toBe(204);
      expect(mockInviteService.delete).toHaveBeenCalledWith('invite_1');
    });

    it('refuses member keys with 403', async () => {
      const app = createTestApp('apikey_member', 'member');
      const res = await request(app).delete('/api/v1/invites/invite_1');

      expect(res.status).toBe(403);
      expect(mockInviteService.delete).not.toHaveBeenCalled();
    });
  });
});
