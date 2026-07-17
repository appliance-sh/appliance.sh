import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWithTenant } from './tenant-context';

// Capture the Key handed to PutObjectCommand so we can assert the
// build-artifact S3 key is tenant-scoped (Quinn #2). The S3 client is a
// no-op; getSignedUrl returns a stub.
const putInputs: Array<{ Key?: string }> = [];

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    async send() {
      return {};
    }
  },
  PutObjectCommand: class {
    constructor(public input: { Key?: string }) {
      putInputs.push(input);
    }
  },
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: async () => 'https://example.test/presigned',
}));

// Capture persisted build records.
const persisted: Array<{ collection: string; id: string; value: { source: string } }> = [];
vi.mock('./storage.service', () => ({
  getStorageService: () => ({
    set: async (collection: string, id: string, value: { source: string }) => {
      persisted.push({ collection, id, value });
    },
    get: async () => null,
  }),
}));

import { BuildUploadService } from './build-upload.service';

const AWS_BASE = JSON.stringify({
  type: 'appliance-base-aws-public',
  name: 'prod',
  stateBackendUrl: 's3://x',
  aws: { region: 'us-east-1', zoneId: 'Z1', dataBucketName: 'data-bucket' },
});

describe('BuildUploadService — direct-S3 build artifact is tenant-scoped (Quinn #2)', () => {
  const original = process.env.APPLIANCE_BASE_CONFIG;

  beforeEach(() => {
    putInputs.length = 0;
    persisted.length = 0;
    process.env.APPLIANCE_BASE_CONFIG = AWS_BASE;
  });

  afterEach(() => {
    delete process.env.APPLIANCE_MULTI_TENANT;
    if (original === undefined) delete process.env.APPLIANCE_BASE_CONFIG;
    else process.env.APPLIANCE_BASE_CONFIG = original;
  });

  it('flag OFF: uses the un-prefixed builds/<id>.zip key (byte-identical)', async () => {
    const svc = new BuildUploadService();
    const { buildId } = await svc.createUpload();
    expect(putInputs[0].Key).toBe(`builds/${buildId}.zip`);
    expect(persisted[0].value.source).toBe(`builds/${buildId}.zip`);
  });

  it('flag ON: scopes the artifact key under the caller tenant', async () => {
    process.env.APPLIANCE_MULTI_TENANT = 'true';
    const svc = new BuildUploadService();
    const { buildId } = await runWithTenant('acme', () => svc.createUpload());
    expect(putInputs[0].Key).toBe(`tenants/acme/builds/${buildId}.zip`);
    // The scoped key is persisted as `source`, so resolve() reads it back
    // already-scoped (no double-prefix at deploy time).
    expect(persisted[0].value.source).toBe(`tenants/acme/builds/${buildId}.zip`);
  });
});
