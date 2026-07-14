import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { BuildType } from '@appliance.sh/sdk';
import { requestLogger } from '../../logger';

const mockBuildUploadService = vi.hoisted(() => ({
  createUpload: vi.fn(),
  createRemoteImage: vi.fn(),
}));

vi.mock('../../services/build-upload.service', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/build-upload.service')>();
  return {
    ...original,
    buildUploadService: mockBuildUploadService,
  };
});

import { MissingBuilderError } from '../../services/build-upload.service';
import { buildRoutes } from './index';

// requestLogger is mounted so req.requestId threads into error bodies
// exactly as in createApp(); the x-request-id header pins its value.
function createTestApp() {
  const app = express();
  app.use(requestLogger);
  app.use(express.json());
  app.use('/api/v1/builds', buildRoutes);
  return app;
}

const REQUEST_ID = 'req-test-1234';

describe('POST /api/v1/builds', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('201s the upload result on success', async () => {
    mockBuildUploadService.createUpload.mockResolvedValue({
      buildId: 'build_1',
      uploadUrl: 'http://host/api/v1/builds/build_1/content?token=t',
    });

    const res = await request(createTestApp()).post('/api/v1/builds').send({ type: BuildType.Upload });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      buildId: 'build_1',
      uploadUrl: 'http://host/api/v1/builds/build_1/content?token=t',
    });
  });

  it('409s with the builder message + requestId when the base has no builder', async () => {
    mockBuildUploadService.createUpload.mockRejectedValue(new MissingBuilderError());

    const res = await request(createTestApp())
      .post('/api/v1/builds')
      .set('x-request-id', REQUEST_ID)
      .send({ type: BuildType.Upload });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error:
        'Upload-flow builds need a builder, and this base has none configured (kubernetes.buildkit.addr). ' +
        'Use a remote-image build referencing a container image instead.',
      requestId: REQUEST_ID,
    });
  });

  it('500s with detail + requestId on unexpected failures', async () => {
    mockBuildUploadService.createUpload.mockRejectedValue(new Error('storage exploded'));

    const res = await request(createTestApp())
      .post('/api/v1/builds')
      .set('x-request-id', REQUEST_ID)
      .send({ type: BuildType.Upload });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: 'Failed to create build',
      detail: 'storage exploded',
      requestId: REQUEST_ID,
    });
  });
});
