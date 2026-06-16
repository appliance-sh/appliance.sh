import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeploymentAction } from '@appliance.sh/sdk';

// Capture the event the service dispatches to the worker so we can
// assert the environment it injected.
const mockExecuteDeployment = vi.hoisted(() => vi.fn());

vi.mock('./deployment-executor.service', () => ({
  executeDeployment: mockExecuteDeployment,
}));

const mockStore = vi.hoisted(() => ({
  set: vi.fn(),
  get: vi.fn(),
}));

vi.mock('./storage.service', () => ({
  getStorageService: () => mockStore,
}));

const mockEnvironmentService = vi.hoisted(() => ({
  get: vi.fn(),
  updateStatus: vi.fn(),
}));

vi.mock('./environment.service', () => ({
  environmentService: mockEnvironmentService,
}));

const mockProjectService = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock('./project.service', () => ({
  projectService: mockProjectService,
}));

const mockEnvVarService = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock('./env-var.service', () => ({
  envVarService: mockEnvVarService,
}));

import { DeploymentService } from './deployment.service';

const caller = { keyId: 'apikey_x', secret: 'sk_x' };

describe('DeploymentService env injection', () => {
  let service: DeploymentService;

  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.WORKER_URL; // force inline executeDeployment path
    // Inline dispatch does `executeDeployment(event).catch(...)`, so the
    // mock must return a promise.
    mockExecuteDeployment.mockResolvedValue(undefined);
    service = new DeploymentService();
    mockEnvironmentService.get.mockResolvedValue({
      id: 'env-1',
      projectId: 'proj-1',
      stackName: 'proj-1-env-1',
      name: 'production',
      status: 'pending',
    });
    mockEnvironmentService.updateStatus.mockResolvedValue(undefined);
    mockProjectService.get.mockResolvedValue({ id: 'proj-1', name: 'proj-1' });
    mockStore.set.mockResolvedValue(undefined);
  });

  function dispatchedEnv(): Record<string, string> | undefined {
    expect(mockExecuteDeployment).toHaveBeenCalledTimes(1);
    return mockExecuteDeployment.mock.calls[0][0].input.environment;
  }

  it('injects stored variables on deploy', async () => {
    mockEnvVarService.get.mockResolvedValue({ DB_URL: 'postgres://stored' });

    await service.execute({ environmentId: 'env-1', action: DeploymentAction.Deploy }, caller);

    expect(dispatchedEnv()).toEqual({ DB_URL: 'postgres://stored' });
  });

  it('lets per-deploy values override stored ones', async () => {
    mockEnvVarService.get.mockResolvedValue({ DB_URL: 'stored', SHARED: 'stored' });

    await service.execute(
      { environmentId: 'env-1', action: DeploymentAction.Deploy, environment: { SHARED: 'override', LOCAL: 'x' } },
      caller
    );

    expect(dispatchedEnv()).toEqual({ DB_URL: 'stored', SHARED: 'override', LOCAL: 'x' });
  });

  it('does not inject stored variables on destroy', async () => {
    mockEnvVarService.get.mockResolvedValue({ DB_URL: 'stored' });

    await service.execute({ environmentId: 'env-1', action: DeploymentAction.Destroy }, caller);

    // No env lookup at all for destroy, and nothing injected.
    expect(mockEnvVarService.get).not.toHaveBeenCalled();
    expect(dispatchedEnv()).toBeUndefined();
  });
});
