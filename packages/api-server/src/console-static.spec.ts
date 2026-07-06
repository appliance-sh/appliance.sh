import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { mountConsole } from './console-static';

let consoleDir: string;

beforeAll(() => {
  consoleDir = mkdtempSync(path.join(tmpdir(), 'appliance-console-'));
  writeFileSync(
    path.join(consoleDir, 'index.html'),
    '<!doctype html><html><head><title>Appliance</title></head><body><div id="root"></div></body></html>'
  );
  mkdirSync(path.join(consoleDir, 'assets'));
  writeFileSync(path.join(consoleDir, 'assets', 'app-abc123.js'), 'console.log("app")');
});

afterAll(() => {
  rmSync(consoleDir, { recursive: true, force: true });
});

function createTestApp() {
  const app = express();
  mountConsole(app, consoleDir);
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/api/v1/projects', (_req, res) => {
    res.status(401).json({ error: 'Missing signature headers' });
  });
  return app;
}

describe('mountConsole', () => {
  it('serves index.html at / with the runtime config injected', async () => {
    const res = await request(createTestApp()).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('window.__APPLIANCE_CONFIG__=Object.assign({apiServerUrl:window.location.origin}');
    expect(res.text).toContain('"consoleMode":"full"');
  });

  it('serves the SPA shell for deep links (client-side routes)', async () => {
    const res = await request(createTestApp()).get('/projects/some-project');
    expect(res.status).toBe(200);
    expect(res.text).toContain('__APPLIANCE_CONFIG__');
  });

  it('serves static assets untouched', async () => {
    const res = await request(createTestApp()).get('/assets/app-abc123.js');
    expect(res.status).toBe(200);
    expect(res.text).toBe('console.log("app")');
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('does not swallow API or health routes', async () => {
    const app = createTestApp();
    const health = await request(app).get('/healthz');
    expect(health.body).toEqual({ ok: true });

    const api = await request(app).get('/api/v1/projects');
    expect(api.status).toBe(401);
    expect(api.body.error).toBe('Missing signature headers');
  });

  it('404s asset-like misses instead of rendering HTML', async () => {
    const res = await request(createTestApp()).get('/assets/missing-file.js');
    expect(res.status).toBe(404);
  });

  it('registers nothing when no bundle dir exists', async () => {
    const app = express();
    mountConsole(app, null);
    app.get('/', (_req, res) => {
      res.send('Hello World!');
    });
    const res = await request(app).get('/');
    expect(res.text).toBe('Hello World!');
  });

  it('serves nothing when mode is off, even with a bundle staged', async () => {
    const app = express();
    mountConsole(app, consoleDir, 'off');
    app.get('/', (_req, res) => {
      res.send('Hello World!');
    });
    const res = await request(app).get('/');
    expect(res.text).toBe('Hello World!');
  });

  it('injects the bootstrap mode + external console URL into the config', async () => {
    process.env.APPLIANCE_CONSOLE_URL = 'https://console.internal.example.com/';
    try {
      const app = express();
      mountConsole(app, consoleDir, 'bootstrap');
      const res = await request(app).get('/');
      expect(res.text).toContain('"consoleMode":"bootstrap"');
      expect(res.text).toContain('"consoleUrl":"https://console.internal.example.com"');
    } finally {
      delete process.env.APPLIANCE_CONSOLE_URL;
    }
  });
});
