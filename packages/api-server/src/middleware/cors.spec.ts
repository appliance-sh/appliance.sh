import { describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import { corsMiddleware } from './cors';

function createTestApp() {
  const app = express();
  app.use(corsMiddleware);
  app.get('/api/v1/cluster-info', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('cors middleware', () => {
  it('allows the SDK headers (including x-appliance-client) in preflight', async () => {
    const res = await request(createTestApp())
      .options('/api/v1/cluster-info')
      .set('Origin', 'tauri://localhost')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'content-type,signature,signature-input,x-appliance-client');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('tauri://localhost');
    const allowed = (res.headers['access-control-allow-headers'] ?? '').toLowerCase();
    for (const header of ['content-type', 'content-digest', 'signature', 'signature-input', 'x-appliance-client']) {
      expect(allowed).toContain(header);
    }
  });

  it('accepts localhost dev-shell and hosted-console origins', async () => {
    for (const origin of ['http://localhost:5173', 'https://console.appliance.sh']) {
      const res = await request(createTestApp())
        .options('/api/v1/cluster-info')
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'GET');
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    }
  });

  it('rejects unknown origins', async () => {
    const res = await request(createTestApp())
      .options('/api/v1/cluster-info')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'GET');
    // The cors error propagates to Express's default handler — the
    // point is that no allow-origin header is granted.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
