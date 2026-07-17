import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { VERSION } from '@appliance.sh/sdk';
import { clusterInfoRoutes } from './index';

function createTestApp() {
  const app = express();
  app.use('/api/v1/cluster-info', clusterInfoRoutes);
  return app;
}

const K8S_BASE = {
  type: 'appliance-base-kubernetes',
  name: 'local-runtime',
  kubernetes: { dataDir: '/data' },
};

describe('GET /api/v1/cluster-info', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('reports serverVersion and uploadBuilds=true on a kubernetes base with a builder', async () => {
    process.env.APPLIANCE_BASE_CONFIG = JSON.stringify({
      ...K8S_BASE,
      kubernetes: { dataDir: '/data', buildkit: { addr: 'tcp://127.0.0.1:5054' } },
    });

    const res = await request(createTestApp()).get('/api/v1/cluster-info');

    expect(res.status).toBe(200);
    expect(res.body.serverVersion).toBe(VERSION);
    expect(res.body.capabilities).toEqual({ uploadBuilds: true });
  });

  it('reports an advisory minClientVersion', async () => {
    process.env.APPLIANCE_BASE_CONFIG = JSON.stringify(K8S_BASE);

    const res = await request(createTestApp()).get('/api/v1/cluster-info');

    expect(res.status).toBe(200);
    // Semver-shaped; "0.0.0" until the floor is deliberately raised.
    expect(res.body.minClientVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('reports uploadBuilds=false on a kubernetes base without a builder', async () => {
    process.env.APPLIANCE_BASE_CONFIG = JSON.stringify(K8S_BASE);

    const res = await request(createTestApp()).get('/api/v1/cluster-info');

    expect(res.status).toBe(200);
    expect(res.body.capabilities).toEqual({ uploadBuilds: false });
  });
});
