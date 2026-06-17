import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EnvironmentHealthStatus } from '@appliance.sh/sdk';

const mockEnvironmentService = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock('./environment.service', () => ({
  environmentService: mockEnvironmentService,
}));

// Stand-in for the infra cluster client. The constructor records the
// base config it was handed; getDeploymentHealth resolves whatever the
// test queued.
const mockGetDeploymentHealth = vi.hoisted(() => vi.fn());

vi.mock('@appliance.sh/infra', () => ({
  LocalContainerDeploymentService: class {
    constructor(public readonly baseConfig: unknown) {}
    getDeploymentHealth = mockGetDeploymentHealth;
  },
}));

import { environmentHealthService } from './environment-health.service';

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

describe('EnvironmentHealthService', () => {
  const originalBaseConfig = process.env.APPLIANCE_BASE_CONFIG;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnvironmentService.get.mockResolvedValue({ id: 'env-1', stackName: 'demo-prod', projectId: 'proj-1' });
    process.env.APPLIANCE_BASE_CONFIG = K8S_BASE;
  });

  afterEach(() => {
    if (originalBaseConfig === undefined) delete process.env.APPLIANCE_BASE_CONFIG;
    else process.env.APPLIANCE_BASE_CONFIG = originalBaseConfig;
  });

  it('returns null when the environment does not exist', async () => {
    mockEnvironmentService.get.mockResolvedValue(null);
    const result = await environmentHealthService.getForEnvironment('missing');
    expect(result).toBeNull();
  });

  it('returns unknown for non-Kubernetes bases (no pod semantics)', async () => {
    process.env.APPLIANCE_BASE_CONFIG = AWS_BASE;
    const result = await environmentHealthService.getForEnvironment('env-1');
    expect(result?.status).toBe(EnvironmentHealthStatus.Unknown);
    expect(result?.message).toMatch(/Kubernetes-driven/);
    expect(mockGetDeploymentHealth).not.toHaveBeenCalled();
  });

  it('returns unknown when the base config is unavailable', async () => {
    delete process.env.APPLIANCE_BASE_CONFIG;
    const result = await environmentHealthService.getForEnvironment('env-1');
    expect(result?.status).toBe(EnvironmentHealthStatus.Unknown);
  });

  it('maps a fully-ready workload to healthy and passes through usage', async () => {
    mockGetDeploymentHealth.mockResolvedValue({
      deployed: true,
      desiredReplicas: 2,
      readyReplicas: 2,
      restarts: 1,
      pods: [
        { name: 'demo-prod-a', phase: 'Running', ready: true, restarts: 0 },
        { name: 'demo-prod-b', phase: 'Running', ready: true, restarts: 1 },
      ],
      usage: { cpuMillicores: 24, memoryBytes: 134217728 },
    });
    const result = await environmentHealthService.getForEnvironment('env-1');
    expect(mockGetDeploymentHealth).toHaveBeenCalledWith('demo-prod');
    expect(result?.status).toBe(EnvironmentHealthStatus.Healthy);
    expect(result?.readyReplicas).toBe(2);
    expect(result?.restarts).toBe(1);
    expect(result?.usage).toEqual({ cpuMillicores: 24, memoryBytes: 134217728 });
  });

  it('maps a not-deployed workload to not_deployed', async () => {
    mockGetDeploymentHealth.mockResolvedValue({
      deployed: false,
      desiredReplicas: 0,
      readyReplicas: 0,
      restarts: 0,
      pods: [],
    });
    const result = await environmentHealthService.getForEnvironment('env-1');
    expect(result?.status).toBe(EnvironmentHealthStatus.NotDeployed);
  });

  it('maps a partial rollout to degraded', async () => {
    mockGetDeploymentHealth.mockResolvedValue({
      deployed: true,
      desiredReplicas: 2,
      readyReplicas: 1,
      restarts: 0,
      pods: [
        { name: 'demo-prod-a', phase: 'Running', ready: true, restarts: 0 },
        { name: 'demo-prod-b', phase: 'Pending', ready: false, restarts: 0 },
      ],
    });
    const result = await environmentHealthService.getForEnvironment('env-1');
    expect(result?.status).toBe(EnvironmentHealthStatus.Degraded);
  });

  it('maps a crash-looping workload to unhealthy', async () => {
    mockGetDeploymentHealth.mockResolvedValue({
      deployed: true,
      desiredReplicas: 1,
      readyReplicas: 0,
      restarts: 7,
      pods: [{ name: 'demo-prod-a', phase: 'Running', ready: false, restarts: 7, reason: 'CrashLoopBackOff' }],
    });
    const result = await environmentHealthService.getForEnvironment('env-1');
    expect(result?.status).toBe(EnvironmentHealthStatus.Unhealthy);
  });

  it('treats a backoff reason as unhealthy even when a replica reports ready', async () => {
    mockGetDeploymentHealth.mockResolvedValue({
      deployed: true,
      desiredReplicas: 2,
      readyReplicas: 2,
      restarts: 3,
      pods: [
        { name: 'demo-prod-a', phase: 'Running', ready: true, restarts: 0 },
        { name: 'demo-prod-b', phase: 'Running', ready: false, restarts: 3, reason: 'ImagePullBackOff' },
      ],
    });
    const result = await environmentHealthService.getForEnvironment('env-1');
    expect(result?.status).toBe(EnvironmentHealthStatus.Unhealthy);
  });

  it('omits usage when metrics-server is absent', async () => {
    mockGetDeploymentHealth.mockResolvedValue({
      deployed: true,
      desiredReplicas: 1,
      readyReplicas: 1,
      restarts: 0,
      pods: [{ name: 'demo-prod-a', phase: 'Running', ready: true, restarts: 0 }],
    });
    const result = await environmentHealthService.getForEnvironment('env-1');
    expect(result?.status).toBe(EnvironmentHealthStatus.Healthy);
    expect(result?.usage).toBeUndefined();
  });

  it('degrades to unknown when the cluster is unreachable', async () => {
    mockGetDeploymentHealth.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await environmentHealthService.getForEnvironment('env-1');
    expect(result?.status).toBe(EnvironmentHealthStatus.Unknown);
    expect(result?.message).toMatch(/Unable to reach the cluster/);
  });
});
