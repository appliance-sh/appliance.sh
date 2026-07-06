import { describe, it, expect, vi } from 'vitest';
import { ApplianceBaseType } from '@appliance.sh/sdk';
import type { ApplianceBaseConfig } from '@appliance.sh/sdk';
import {
  DockerDeploymentService,
  DEFAULT_DOCKER_PORT_MIN,
  DEFAULT_DOCKER_PORT_MAX,
  containerNameFor,
  type DockerExec,
} from './DockerDeploymentService';

const baseConfig: ApplianceBaseConfig = {
  name: 'local-docker',
  type: ApplianceBaseType.ApplianceDocker,
  docker: { dataDir: '/tmp/appliance-data' },
};

const metadata = {
  projectId: 'p1',
  projectName: 'demo',
  environmentId: 'e1',
  environmentName: 'dev',
  deploymentId: 'd1',
  stackName: 'demo-dev',
};

/** Inspect payload for a healthy running container. */
function runningInspect(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([
    {
      Name: '/appliance-demo-dev',
      Created: '2026-07-06T00:00:00Z',
      Config: {
        Image: 'sha256:abc',
        Labels: {
          'sh.appliance.managed': 'true',
          'sh.appliance.stack': 'demo-dev',
          'sh.appliance.env': '{"PORT":"3000"}',
          'sh.appliance.port': '3000',
        },
      },
      State: { Status: 'running', Running: true, ExitCode: 0 },
      RestartCount: 2,
      NetworkSettings: { Ports: { '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '8342' }] } },
      ...overrides,
    },
  ]);
}

function execScript(handler: (args: string[]) => string | Error): { exec: DockerExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: DockerExec = async (args) => {
    calls.push(args);
    const result = handler(args);
    if (result instanceof Error) throw result;
    return { stdout: result, stderr: '' };
  };
  return { exec, calls };
}

describe('DockerDeploymentService', () => {
  it('rejects non-docker base configs', () => {
    const k8s: ApplianceBaseConfig = {
      name: 'x',
      type: ApplianceBaseType.ApplianceKubernetes,
      kubernetes: { dataDir: '/data' },
    };
    expect(() => new DockerDeploymentService(k8s)).toThrow(/appliance-base-docker/);
  });

  it('derives a stable host port inside the default window', () => {
    const svc = new DockerDeploymentService(baseConfig, async () => ({ stdout: '', stderr: '' }));
    const port = svc.deterministicHostPort('demo-dev');
    expect(port).toBe(svc.deterministicHostPort('demo-dev'));
    expect(port).toBeGreaterThanOrEqual(DEFAULT_DOCKER_PORT_MIN);
    expect(port).toBeLessThanOrEqual(DEFAULT_DOCKER_PORT_MAX);
    expect(svc.deterministicHostPort('other-env')).not.toBe(port);
  });

  it('reports a no-op when image, env, and port are unchanged on a running container', async () => {
    const { exec, calls } = execScript((args) => {
      if (args[0] === 'inspect') return runningInspect();
      return new Error(`unexpected: ${args.join(' ')}`);
    });
    const svc = new DockerDeploymentService(baseConfig, exec);
    const result = await svc.deploy('demo-dev', metadata, {
      imageUri: 'sha256:abc',
      port: 3000,
      environment: { PORT: '3000' },
    });
    expect(result.idempotentNoop).toBe(true);
    expect(result.url).toBe('http://localhost:8342');
    // Only the inspect probe ran — no rm, no run.
    expect(calls.every((c) => c[0] === 'inspect')).toBe(true);
  });

  it('recreates the container on image change, reusing the live host port', async () => {
    let phase: 'before' | 'after' = 'before';
    const { exec, calls } = execScript((args) => {
      if (args[0] === 'inspect') {
        return phase === 'before'
          ? runningInspect()
          : runningInspect({ Config: { Image: 'sha256:def', Labels: { 'sh.appliance.stack': 'demo-dev' } } });
      }
      if (args[0] === 'rm') return '';
      if (args[0] === 'run') {
        phase = 'after';
        return 'containerid\n';
      }
      return new Error(`unexpected: ${args.join(' ')}`);
    });
    const svc = new DockerDeploymentService(baseConfig, exec);
    const result = await svc.deploy('demo-dev', metadata, {
      imageUri: 'sha256:def',
      port: 3000,
      environment: { PORT: '3000' },
    });
    expect(result.idempotentNoop).toBe(false);
    expect(result.url).toBe('http://localhost:8342');
    const run = calls.find((c) => c[0] === 'run')!;
    // Reused the existing 8342 binding rather than re-hashing.
    expect(run).toContain('--publish');
    expect(run[run.indexOf('--publish') + 1]).toBe('8342:3000');
    expect(run[run.length - 1]).toBe('sha256:def');
    expect(calls.some((c) => c[0] === 'rm' && c.includes('appliance-demo-dev'))).toBe(true);
  });

  it('notes ignored replicas in the deploy message', async () => {
    let started = false;
    const { exec } = execScript((args) => {
      if (args[0] === 'inspect') {
        return started ? runningInspect() : new Error('Error: No such container: appliance-demo-dev');
      }
      if (args[0] === 'run') {
        started = true;
        return 'id\n';
      }
      return new Error(`unexpected: ${args.join(' ')}`);
    });
    const svc = new DockerDeploymentService(baseConfig, exec);
    const result = await svc.deploy('demo-dev', metadata, { imageUri: 'sha256:abc', port: 3000, replicas: 3 });
    expect(result.message).toMatch(/replicas.*ignored/i);
  });

  it('surfaces the container log tail when startup crashes', async () => {
    let started = false;
    const { exec } = execScript((args) => {
      if (args[0] === 'inspect') {
        if (!started) return new Error('Error: No such container: appliance-demo-dev');
        return JSON.stringify([
          {
            Name: '/appliance-demo-dev',
            Config: { Image: 'sha256:abc', Labels: {} },
            State: { Status: 'exited', Running: false, ExitCode: 1 },
          },
        ]);
      }
      if (args[0] === 'run') {
        started = true;
        return 'id\n';
      }
      if (args[0] === 'logs') return 'boom: missing config\n';
      return new Error(`unexpected: ${args.join(' ')}`);
    });
    const svc = new DockerDeploymentService(baseConfig, exec);
    await expect(svc.deploy('demo-dev', metadata, { imageUri: 'sha256:abc', port: 3000 })).rejects.toThrow(
      /exited with code 1[\s\S]*boom: missing config/
    );
  });

  it('destroy is idempotent when no container exists', async () => {
    const { exec } = execScript(() => new Error('Error: No such container: appliance-demo-dev'));
    const svc = new DockerDeploymentService(baseConfig, exec);
    const result = await svc.destroy('demo-dev');
    expect(result.ok).toBe(true);
    expect(result.idempotentNoop).toBe(true);
  });

  it('maps a running container onto DeploymentHealth', async () => {
    const { exec } = execScript((args) => {
      if (args[0] === 'inspect') return runningInspect();
      return new Error('unexpected');
    });
    const svc = new DockerDeploymentService(baseConfig, exec);
    const health = await svc.getDeploymentHealth('demo-dev');
    expect(health).toMatchObject({
      deployed: true,
      desiredReplicas: 1,
      readyReplicas: 1,
      restarts: 2,
    });
    expect(health.pods[0]).toMatchObject({ name: 'appliance-demo-dev', phase: 'Running', ready: true });
  });

  it('lists workloads filtered by the k8s-shaped name selector', async () => {
    const { exec, calls } = execScript((args) => {
      if (args[0] === 'ps') return 'abc123\n';
      if (args[0] === 'inspect') return runningInspect();
      return new Error('unexpected');
    });
    const svc = new DockerDeploymentService(baseConfig, exec);
    const workloads = await svc.listWorkloads({ labelSelector: 'app.kubernetes.io/name=demo-dev' });
    const ps = calls.find((c) => c[0] === 'ps')!;
    expect(ps).toContain('label=sh.appliance.stack=demo-dev');
    expect(workloads.deployments).toHaveLength(1);
    expect(workloads.deployments[0]).toMatchObject({ name: 'demo-dev', desired: 1, ready: 1 });
    expect(workloads.pods[0]).toMatchObject({ name: 'appliance-demo-dev', phase: 'Running' });
    expect(workloads.services[0]).toMatchObject({ serviceType: 'HostPort', nodePort: 8342, targetPort: 3000 });
  });

  it('reads the deployed env back from the label', async () => {
    const { exec } = execScript((args) => {
      if (args[0] === 'inspect') return runningInspect();
      return new Error('unexpected');
    });
    const svc = new DockerDeploymentService(baseConfig, exec);
    await expect(svc.getDeploymentEnv('demo-dev')).resolves.toEqual({ PORT: '3000' });
  });

  it('falls back to an ephemeral publish when the deterministic port is taken', async () => {
    let runs = 0;
    let started = false;
    const { exec, calls } = execScript((args) => {
      if (args[0] === 'inspect') {
        return started ? runningInspect() : new Error('Error: No such container: appliance-demo-dev');
      }
      if (args[0] === 'rm') return '';
      if (args[0] === 'run') {
        runs += 1;
        if (runs === 1) return new Error('driver failed: Bind for 0.0.0.0:8342 failed: port is already allocated');
        started = true;
        return 'id\n';
      }
      return new Error('unexpected');
    });
    const svc = new DockerDeploymentService(baseConfig, exec);
    const result = await svc.deploy('demo-dev', metadata, { imageUri: 'sha256:abc', port: 3000 });
    expect(result.ok).toBe(true);
    const secondRun = calls.filter((c) => c[0] === 'run')[1]!;
    expect(secondRun[secondRun.indexOf('--publish') + 1]).toBe('3000');
  });

  it('honors a configured port range', () => {
    const custom: ApplianceBaseConfig = {
      ...baseConfig,
      docker: { dataDir: '/tmp/x', portRange: { min: 9000, max: 9004 } },
    };
    const svc = new DockerDeploymentService(custom, vi.fn() as unknown as DockerExec);
    for (const name of ['a', 'bb', 'ccc', 'demo-dev']) {
      const port = svc.deterministicHostPort(name);
      expect(port).toBeGreaterThanOrEqual(9000);
      expect(port).toBeLessThanOrEqual(9004);
    }
  });

  it('containerNameFor prefixes the stack', () => {
    expect(containerNameFor('demo-dev')).toBe('appliance-demo-dev');
  });
});
