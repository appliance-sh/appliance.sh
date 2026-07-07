import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BuildType } from '@appliance.sh/sdk';

const mockBuildUploadService = vi.hoisted(() => ({
  get: vi.fn(),
  markUploaded: vi.fn(),
}));

vi.mock('../../services/build-upload.service', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/build-upload.service')>();
  return {
    ...original,
    buildUploadService: mockBuildUploadService,
  };
});

import { buildContentRoutes } from './content';

function createTestApp() {
  const app = express();
  app.use('/api/v1/builds', buildContentRoutes);
  return app;
}

const TOKEN = 'a'.repeat(64);

function uploadBuild(overrides: Record<string, unknown> = {}) {
  return {
    id: 'build_1',
    type: BuildType.Upload,
    source: 'builds/build_1.zip',
    uploadToken: TOKEN,
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('PUT /api/v1/builds/:id/content', () => {
  const originalEnv = process.env;
  let dataDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-content-spec-'));
    process.env = {
      ...originalEnv,
      APPLIANCE_BASE_CONFIG: JSON.stringify({
        type: 'appliance-base-kubernetes',
        name: 'local-runtime',
        kubernetes: { dataDir },
      }),
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('receives content with a valid token, writes the zip, and burns the token', async () => {
    mockBuildUploadService.get.mockResolvedValue(uploadBuild());
    mockBuildUploadService.markUploaded.mockResolvedValue(undefined);

    const res = await request(createTestApp())
      .put(`/api/v1/builds/build_1/content?token=${TOKEN}`)
      .set('content-type', 'application/zip')
      .send(Buffer.from('zip-bytes'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ buildId: 'build_1', bytes: 9 });
    expect(fs.readFileSync(path.join(dataDir, 'builds', 'build_1.zip'), 'utf-8')).toBe('zip-bytes');
    expect(mockBuildUploadService.markUploaded).toHaveBeenCalledWith('build_1');
  });

  it('404s on a wrong token without writing anything', async () => {
    mockBuildUploadService.get.mockResolvedValue(uploadBuild());

    const res = await request(createTestApp())
      .put(`/api/v1/builds/build_1/content?token=${'b'.repeat(64)}`)
      .send(Buffer.from('zip-bytes'));

    expect(res.status).toBe(404);
    expect(fs.existsSync(path.join(dataDir, 'builds', 'build_1.zip'))).toBe(false);
    expect(mockBuildUploadService.markUploaded).not.toHaveBeenCalled();
  });

  it('404s when the token is missing', async () => {
    mockBuildUploadService.get.mockResolvedValue(uploadBuild());
    const res = await request(createTestApp()).put('/api/v1/builds/build_1/content').send(Buffer.from('x'));
    expect(res.status).toBe(404);
  });

  it('404s for an unknown build', async () => {
    mockBuildUploadService.get.mockResolvedValue(null);
    const res = await request(createTestApp())
      .put(`/api/v1/builds/build_x/content?token=${TOKEN}`)
      .send(Buffer.from('x'));
    expect(res.status).toBe(404);
  });

  it('404s for remote-image builds', async () => {
    mockBuildUploadService.get.mockResolvedValue(uploadBuild({ type: BuildType.RemoteImage }));
    const res = await request(createTestApp())
      .put(`/api/v1/builds/build_1/content?token=${TOKEN}`)
      .send(Buffer.from('x'));
    expect(res.status).toBe(404);
  });

  it('404s when content was already uploaded (one-time token)', async () => {
    mockBuildUploadService.get.mockResolvedValue(uploadBuild({ uploadedAt: '2025-01-02T00:00:00.000Z' }));
    const res = await request(createTestApp())
      .put(`/api/v1/builds/build_1/content?token=${TOKEN}`)
      .send(Buffer.from('x'));
    expect(res.status).toBe(404);
  });

  it('413s content over the size cap and leaves no zip behind', async () => {
    process.env.APPLIANCE_MAX_BUILD_SIZE_MB = '1';
    mockBuildUploadService.get.mockResolvedValue(uploadBuild());

    const res = await request(createTestApp())
      .put(`/api/v1/builds/build_1/content?token=${TOKEN}`)
      .set('content-type', 'application/zip')
      .send(Buffer.alloc(1024 * 1024 + 1));

    expect(res.status).toBe(413);
    expect(fs.existsSync(path.join(dataDir, 'builds', 'build_1.zip'))).toBe(false);
  });
});
