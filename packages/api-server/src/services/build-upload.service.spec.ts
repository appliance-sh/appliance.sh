import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BuildType } from '@appliance.sh/sdk';

const store = vi.hoisted(() => new Map<string, unknown>());

vi.mock('./storage.service', () => ({
  getStorageService: () => ({
    get: async (collection: string, id: string) => store.get(`${collection}/${id}`) ?? null,
    set: async (collection: string, id: string, value: unknown) => {
      store.set(`${collection}/${id}`, value);
    },
  }),
}));

import { BuildUploadService, MissingBuilderError, supportsUploadBuilds } from './build-upload.service';
import { applianceBaseConfig } from '@appliance.sh/sdk';

const K8S_BASE = {
  type: 'appliance-base-kubernetes',
  name: 'local-runtime',
  kubernetes: {
    dataDir: '/data',
    registry: { url: 'localhost:5052', insecure: true },
    buildkit: { addr: 'unix:///run/buildkit/buildkitd.sock' },
  },
};

describe('BuildUploadService.createUpload', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    store.clear();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('mints a self-URL + one-time token on kubernetes bases with a builder', async () => {
    process.env.APPLIANCE_BASE_CONFIG = JSON.stringify(K8S_BASE);
    const service = new BuildUploadService();

    const result = await service.createUpload('http://api.appliance.localhost:8081');

    expect(result.uploadUrl).toMatch(
      new RegExp(
        `^http://api\\.appliance\\.localhost:8081/api/v1/builds/${result.buildId}/content\\?token=[0-9a-f]{64}$`
      )
    );
    const record = (await service.get(result.buildId))!;
    expect(record.type).toBe(BuildType.Upload);
    expect(record.source).toBe(`builds/${result.buildId}.zip`);
    expect(record.uploadToken).toHaveLength(64);
    expect(result.uploadUrl).toContain(record.uploadToken!);
  });

  it('rejects upload builds on kubernetes bases without a builder', async () => {
    process.env.APPLIANCE_BASE_CONFIG = JSON.stringify({
      ...K8S_BASE,
      kubernetes: { dataDir: '/data' },
    });
    const service = new BuildUploadService();
    // Typed so the builds route can map it to a 409 (vs generic 500).
    await expect(service.createUpload('http://x')).rejects.toThrow(MissingBuilderError);
    await expect(service.createUpload('http://x')).rejects.toThrow(/builder/);
  });

  it('rejects the removed docker base with migration guidance', async () => {
    process.env.APPLIANCE_BASE_CONFIG = JSON.stringify({
      type: 'appliance-base-docker',
      name: 'local',
      docker: { dataDir: '/data' },
    });
    const service = new BuildUploadService();
    await expect(service.createUpload('http://x')).rejects.toThrow(/removed local Docker runtime/);
  });

  // Mirrors createUpload's gates — /api/v1/cluster-info reports it as
  // `capabilities.uploadBuilds` so clients can warn before the 409.
  describe('supportsUploadBuilds', () => {
    it('is true on kubernetes bases with a builder, false without', () => {
      expect(supportsUploadBuilds(applianceBaseConfig.parse(K8S_BASE))).toBe(true);
      expect(supportsUploadBuilds(applianceBaseConfig.parse({ ...K8S_BASE, kubernetes: { dataDir: '/data' } }))).toBe(
        false
      );
    });

    it('on aws bases requires only the data bucket the presigned PUT targets', () => {
      const awsBase = (aws: Record<string, unknown>) =>
        applianceBaseConfig.parse({ type: 'appliance-base-aws-public', name: 'cloud', aws });
      expect(supportsUploadBuilds(awsBase({ region: 'us-east-1', zoneId: 'Z1', dataBucketName: 'b' }))).toBe(true);
      expect(supportsUploadBuilds(awsBase({ region: 'us-east-1', zoneId: 'Z1' }))).toBe(false);
    });

    it('is false for the removed docker base', () => {
      expect(
        supportsUploadBuilds(
          applianceBaseConfig.parse({ type: 'appliance-base-docker', name: 'local', docker: { dataDir: '/data' } })
        )
      ).toBe(false);
    });
  });

  it('markUploaded stamps uploadedAt and burns the token', async () => {
    process.env.APPLIANCE_BASE_CONFIG = JSON.stringify(K8S_BASE);
    const service = new BuildUploadService();
    const { buildId } = await service.createUpload('http://x');

    await service.markUploaded(buildId);

    const record = (await service.get(buildId))!;
    expect(record.uploadedAt).toBeTruthy();
    expect(record.uploadToken).toBeUndefined();
  });
});
