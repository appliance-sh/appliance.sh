import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Stand-in for the infra cluster client. The constructor records the
// base config it was handed; the read methods resolve whatever each
// test queues.
const mockListWorkloads = vi.hoisted(() => vi.fn());
const mockGetPodLogs = vi.hoisted(() => vi.fn());
const mockStreamPodLogs = vi.hoisted(() => vi.fn());

vi.mock('@appliance.sh/infra', () => ({
  LocalContainerDeploymentService: class {
    constructor(public readonly baseConfig: unknown) {}
    listWorkloads = mockListWorkloads;
    getPodLogs = mockGetPodLogs;
    streamPodLogs = mockStreamPodLogs;
  },
}));

const mockEnvironmentService = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../services/environment.service', () => ({ environmentService: mockEnvironmentService }));

const mockApiKeyService = vi.hoisted(() => ({ getByKeyId: vi.fn(), updateLastUsed: vi.fn() }));
vi.mock('../../services/api-key.service', () => ({ apiKeyService: mockApiKeyService }));

import { signatureAuth } from '../../middleware/auth';
import { workloadsRoutes, environmentWorkloadsRoutes, podLogsRoutes } from './index';

const K8S_BASE = JSON.stringify({
  type: 'appliance-base-local',
  name: 'dev',
  local: { dataDir: '/tmp/dev' },
});

const AWS_BASE = JSON.stringify({
  type: 'appliance-base-aws-public',
  name: 'prod',
  stateBackendUrl: 's3://x',
  aws: { region: 'us-east-1', zoneId: 'Z1' },
});

const SAMPLE_WORKLOADS = {
  deployments: [
    { name: 'demo', image: 'img:1', desired: 1, ready: 1, available: 1, createdAt: '2026-01-01T00:00:00.000Z' },
  ],
  pods: [{ name: 'demo-abc', phase: 'Running', ready: true, restartCount: 2, containerImage: 'img:1' }],
  services: [{ name: 'demo', serviceType: 'NodePort', clusterIp: '10.43.0.1', nodePort: 30001, targetPort: 8080 }],
};

// Mounts the real routers behind a stand-in auth middleware so the
// success/409 paths exercise the actual route + service gate.
function appWithFakeAuth() {
  const app = express();
  app.use((req, _res, next) => {
    req.apiKeyId = 'ak_test';
    next();
  });
  app.use('/api/v1/workloads', workloadsRoutes);
  app.use('/api/v1/environments', environmentWorkloadsRoutes);
  app.use('/api/v1/pods', podLogsRoutes);
  return app;
}

// Mounts behind the REAL signatureAuth to prove the endpoints are
// signature-gated.
function appWithRealAuth() {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    })
  );
  app.use('/api/v1/workloads', signatureAuth, workloadsRoutes);
  app.use('/api/v1/pods', signatureAuth, podLogsRoutes);
  return app;
}

describe('Workloads + pod-logs routes', () => {
  const originalBaseConfig = process.env.APPLIANCE_BASE_CONFIG;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.APPLIANCE_BASE_CONFIG = K8S_BASE;
  });

  afterEach(() => {
    if (originalBaseConfig === undefined) delete process.env.APPLIANCE_BASE_CONFIG;
    else process.env.APPLIANCE_BASE_CONFIG = originalBaseConfig;
  });

  describe('GET /api/v1/workloads', () => {
    it('returns the deployments/pods/services shape', async () => {
      mockListWorkloads.mockResolvedValue(SAMPLE_WORKLOADS);
      const res = await request(appWithFakeAuth()).get('/api/v1/workloads');
      expect(res.status).toBe(200);
      expect(res.body.deployments[0]).toMatchObject({ name: 'demo', desired: 1, ready: 1, available: 1 });
      expect(res.body.pods[0]).toMatchObject({ name: 'demo-abc', phase: 'Running', ready: true, restartCount: 2 });
      expect(res.body.services[0]).toMatchObject({ name: 'demo', serviceType: 'NodePort', nodePort: 30001 });
      // No namespace query → infra client defaults to the server namespace.
      expect(mockListWorkloads).toHaveBeenCalledWith({ namespace: undefined });
    });

    it('passes the namespace query through to the infra client', async () => {
      mockListWorkloads.mockResolvedValue({ deployments: [], pods: [], services: [] });
      const res = await request(appWithFakeAuth()).get('/api/v1/workloads?namespace=team-a');
      expect(res.status).toBe(200);
      expect(mockListWorkloads).toHaveBeenCalledWith({ namespace: 'team-a' });
    });

    it('returns 409 on a non-Kubernetes (AWS) base', async () => {
      process.env.APPLIANCE_BASE_CONFIG = AWS_BASE;
      const res = await request(appWithFakeAuth()).get('/api/v1/workloads');
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/Kubernetes-driven/);
      expect(mockListWorkloads).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/environments/:id/workloads', () => {
    it('filters by the stack label and returns the workloads', async () => {
      mockEnvironmentService.get.mockResolvedValue({ id: 'env-1', stackName: 'demo-prod', projectId: 'p1' });
      mockListWorkloads.mockResolvedValue(SAMPLE_WORKLOADS);
      const res = await request(appWithFakeAuth()).get('/api/v1/environments/env-1/workloads');
      expect(res.status).toBe(200);
      expect(mockListWorkloads).toHaveBeenCalledWith({ labelSelector: 'app.kubernetes.io/name=demo-prod' });
    });

    it('returns 404 when the environment is unknown', async () => {
      mockEnvironmentService.get.mockResolvedValue(null);
      const res = await request(appWithFakeAuth()).get('/api/v1/environments/missing/workloads');
      expect(res.status).toBe(404);
      expect(mockListWorkloads).not.toHaveBeenCalled();
    });

    it('returns 409 on a non-Kubernetes (AWS) base before the env lookup', async () => {
      process.env.APPLIANCE_BASE_CONFIG = AWS_BASE;
      const res = await request(appWithFakeAuth()).get('/api/v1/environments/env-1/workloads');
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/Kubernetes-driven/);
      // The base gate runs first, so we never touch the environment store.
      expect(mockEnvironmentService.get).not.toHaveBeenCalled();
      expect(mockListWorkloads).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/pods/:name/logs (snapshot)', () => {
    it('returns the tail as a text/plain body and defaults tailLines to 200', async () => {
      mockGetPodLogs.mockResolvedValue('line-1\nline-2\n');
      const res = await request(appWithFakeAuth()).get('/api/v1/pods/demo-abc/logs');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.text).toBe('line-1\nline-2\n');
      expect(mockGetPodLogs).toHaveBeenCalledWith('demo-abc', {
        container: undefined,
        tailLines: 200,
        namespace: undefined,
        sinceSeconds: undefined,
      });
    });

    it('forwards container/tailLines/namespace/sinceSeconds query params', async () => {
      mockGetPodLogs.mockResolvedValue('');
      const res = await request(appWithFakeAuth()).get(
        '/api/v1/pods/demo-abc/logs?container=app&tailLines=50&namespace=team-a&sinceSeconds=30'
      );
      expect(res.status).toBe(200);
      expect(mockGetPodLogs).toHaveBeenCalledWith('demo-abc', {
        container: 'app',
        tailLines: 50,
        namespace: 'team-a',
        sinceSeconds: 30,
      });
    });

    it('returns 409 on a non-Kubernetes (AWS) base', async () => {
      process.env.APPLIANCE_BASE_CONFIG = AWS_BASE;
      const res = await request(appWithFakeAuth()).get('/api/v1/pods/demo-abc/logs');
      expect(res.status).toBe(409);
      expect(mockGetPodLogs).not.toHaveBeenCalled();
    });

    it('maps an unknown pod (k8s ApiException code 404) to 404, not 500', async () => {
      // @kubernetes/client-node v1 rejects a missing-pod read with an
      // ApiException carrying the apiserver's HTTP status as `.code`.
      mockGetPodLogs.mockRejectedValue(Object.assign(new Error('pods "nope" not found'), { code: 404 }));
      const res = await request(appWithFakeAuth()).get('/api/v1/pods/nope/logs');
      expect(res.status).toBe(404);
      // The staged text/plain header is dropped so the error body is JSON.
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body).toMatchObject({ error: 'Failed to read pod logs' });
    });
  });

  describe('GET /api/v1/pods/:name/logs?follow=1 (streaming)', () => {
    // Mounts the pod-logs router behind fake auth, wrapping res.flushHeaders
    // with a spy so a test can prove the 200 stream was opened eagerly.
    function streamingApp(flushSpy: () => void) {
      const app = express();
      app.use((req: express.Request & { apiKeyId?: string }, res, next) => {
        req.apiKeyId = 'ak_test';
        const original = res.flushHeaders.bind(res);
        res.flushHeaders = () => {
          flushSpy();
          return original();
        };
        next();
      });
      app.use('/api/v1/pods', podLogsRoutes);
      return app;
    }

    it('opens a text/plain stream, flushes headers, and aborts the watch on client disconnect', async () => {
      const controller = new AbortController();
      const abortSpy = vi.spyOn(controller, 'abort');
      const flushSpy = vi.fn();
      // Resolve with the controller but leave the stream open (no write,
      // no end) so res.flushHeaders() is the only thing that can send the
      // 200 — receiving headers therefore proves it was called.
      mockStreamPodLogs.mockResolvedValue(controller);

      const server = http.createServer(streamingApp(flushSpy));
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const { port } = server.address() as AddressInfo;

      try {
        await new Promise<void>((resolve, reject) => {
          const client = http.get({ host: '127.0.0.1', port, path: '/api/v1/pods/demo-abc/logs?follow=1' }, (res) => {
            try {
              expect(res.statusCode).toBe(200);
              expect(res.headers['content-type']).toMatch(/text\/plain/);
            } catch (assertion) {
              reject(assertion);
              return;
            }
            // Headers arrived with no body written → flushHeaders ran.
            // Disconnect to fire the route's req/res 'close' → abort.
            client.destroy();
          });
          client.on('error', () => {}); // destroy → expected socket reset
          client.on('close', () => resolve());
        });

        expect(flushSpy).toHaveBeenCalled();
        // (podName, destination, opts) — the destination is the response.
        expect(mockStreamPodLogs).toHaveBeenCalledWith('demo-abc', expect.anything(), {
          container: undefined,
          tailLines: 200,
          namespace: undefined,
          sinceSeconds: undefined,
        });
        await vi.waitFor(() => expect(abortSpy).toHaveBeenCalled());
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('aborts the watch when the client disconnects during the kube round-trip (open-window race)', async () => {
      const controller = new AbortController();
      const abortSpy = vi.spyOn(controller, 'abort');
      const flushSpy = vi.fn();
      // The client is already gone by the time streamPodLogs resolves, so
      // the post-await liveness guard — not a 'close' handler — must abort.
      mockStreamPodLogs.mockImplementation(
        (_pod: string, destination: express.Response) =>
          new Promise((resolve) => {
            destination.destroy();
            // Resolve on the next tick, after the socket has torn down, so
            // res.destroyed/!writable is observable when the route checks.
            setImmediate(() => resolve(controller));
          })
      );

      const server = http.createServer(streamingApp(flushSpy));
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const { port } = server.address() as AddressInfo;

      try {
        await new Promise<void>((resolve) => {
          const client = http.get({ host: '127.0.0.1', port, path: '/api/v1/pods/demo-abc/logs?follow=1' }, () => {});
          client.on('error', () => resolve()); // socket destroyed server-side
          client.on('close', () => resolve());
        });

        await vi.waitFor(() => expect(abortSpy).toHaveBeenCalled());
        // The stream was never opened to the (gone) client.
        expect(flushSpy).not.toHaveBeenCalled();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe('signature auth enforcement', () => {
    it('rejects unsigned workloads requests with 401', async () => {
      const res = await request(appWithRealAuth()).get('/api/v1/workloads');
      expect(res.status).toBe(401);
      expect(mockListWorkloads).not.toHaveBeenCalled();
    });

    it('rejects unsigned pod-log requests with 401', async () => {
      const res = await request(appWithRealAuth()).get('/api/v1/pods/demo-abc/logs');
      expect(res.status).toBe(401);
      expect(mockGetPodLogs).not.toHaveBeenCalled();
    });
  });
});
