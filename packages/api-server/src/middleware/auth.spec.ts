import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { signRequest } from '@appliance.sh/sdk';
import { signatureAuth } from './auth';

const TEST_KEY_ID = 'ak_test-key-id';
const TEST_SECRET = 'sk_test-secret-value';
const TEST_HOST = 'test.local';

const mockKeyStore = new Map<string, { id: string; rawSecret: string; name: string }>();

vi.mock('../services/api-key.service', () => ({
  apiKeyService: {
    getByKeyId: async (keyId: string) => mockKeyStore.get(keyId) ?? null,
    updateLastUsed: async () => {},
  },
}));

function createTestApp() {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    })
  );
  app.get('/api/v1/test', signatureAuth, (_req, res) => {
    res.json({ ok: true });
  });
  app.post('/api/v1/test', signatureAuth, (req, res) => {
    res.json({ ok: true, body: req.body });
  });
  return app;
}

describe('signatureAuth middleware', () => {
  beforeEach(() => {
    mockKeyStore.clear();
    mockKeyStore.set(TEST_KEY_ID, {
      id: TEST_KEY_ID,
      rawSecret: TEST_SECRET,
      name: 'test',
    });
  });

  it('should return 401 when no signature headers', async () => {
    const app = createTestApp();
    const res = await request(app).get('/api/v1/test');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Missing signature headers');
  });

  it('should return 401 with invalid signature', async () => {
    const app = createTestApp();
    const res = await request(app)
      .get('/api/v1/test')
      .set('signature', 'sig=:invalidbase64:')
      .set('signature-input', 'sig=();created=1234567890;keyid="ak_wrong";alg="hmac-sha256"');
    expect(res.status).toBe(401);
  });

  it('should pass through with valid HMAC-SHA256 signature (GET)', async () => {
    const app = createTestApp();
    const url = `http://${TEST_HOST}/api/v1/test`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };

    const sigHeaders = await signRequest({ keyId: TEST_KEY_ID, secret: TEST_SECRET }, { method: 'GET', url, headers });

    const res = await request(app)
      .get('/api/v1/test')
      .set('host', TEST_HOST)
      .set('content-type', 'application/json')
      .set(sigHeaders);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should pass through with valid HMAC-SHA256 signature (POST with body)', async () => {
    const app = createTestApp();
    const body = JSON.stringify({ name: 'test' });
    const url = `http://${TEST_HOST}/api/v1/test`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };

    const sigHeaders = await signRequest(
      { keyId: TEST_KEY_ID, secret: TEST_SECRET },
      { method: 'POST', url, headers, body }
    );

    const res = await request(app)
      .post('/api/v1/test')
      .set('host', TEST_HOST)
      .set('content-type', 'application/json')
      .set(sigHeaders)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 401 when Content-Digest does not match body', async () => {
    const app = createTestApp();
    const body = JSON.stringify({ name: 'test' });
    const url = `http://${TEST_HOST}/api/v1/test`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };

    const sigHeaders = await signRequest(
      { keyId: TEST_KEY_ID, secret: TEST_SECRET },
      { method: 'POST', url, headers, body }
    );

    // Send different body than what was signed
    const res = await request(app)
      .post('/api/v1/test')
      .set('host', TEST_HOST)
      .set('content-type', 'application/json')
      .set(sigHeaders)
      .send(JSON.stringify({ name: 'tampered' }));

    expect(res.status).toBe(401);
  });

  it('should return 401 for unknown key', async () => {
    const app = createTestApp();
    const url = `http://${TEST_HOST}/api/v1/test`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };

    const sigHeaders = await signRequest({ keyId: 'ak_unknown', secret: 'sk_wrong' }, { method: 'GET', url, headers });

    const res = await request(app)
      .get('/api/v1/test')
      .set('host', TEST_HOST)
      .set('content-type', 'application/json')
      .set(sigHeaders);

    expect(res.status).toBe(401);
  });
});
