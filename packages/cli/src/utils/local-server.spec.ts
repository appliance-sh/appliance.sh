import { describe, expect, it } from 'vitest';
import { ApplianceBaseType, applianceBaseConfig } from '@appliance.sh/sdk';
import { shouldRestartDaemon, vmBaseConfigJson } from './local-server.js';
import type { VmRuntimeInfo } from './microvm-up.js';

const vm: VmRuntimeInfo = {
  name: 'appliance',
  kubeconfigPath: '/home/x/.appliance/vm/appliance/kubeconfig.yaml',
  ports: { hostPort: 8081, apiPort: 6443, registryPort: 5052, egressPort: 5053, buildkitPort: 5054 },
};

describe('vmBaseConfigJson', () => {
  it('emits a kubernetes base the SDK schema accepts, wired to the VM forwards', () => {
    const kubeconfig = 'apiVersion: v1\nkind: Config\nclusters: []\n';
    const parsed = applianceBaseConfig.parse(JSON.parse(vmBaseConfigJson('/data/server', vm, kubeconfig)));
    expect(parsed.type).toBe(ApplianceBaseType.ApplianceKubernetes);
    expect(parsed.name).toBe('local');
    expect(parsed.kubernetes?.kubeconfig).toBe(kubeconfig);
    expect(parsed.kubernetes?.namespace).toBe('appliance');
    expect(parsed.kubernetes?.hostnameSuffix).toBe('appliance.localhost');
    expect(parsed.kubernetes?.ingressClassName).toBe('traefik');
    expect(parsed.kubernetes?.hostPort).toBe(8081);
    expect(parsed.kubernetes?.dataDir).toBe('/data/server');
    // One ref serves the host push, the guest-side buildkit push, and
    // the pod pull (containerd mirror) — and it must be insecure HTTP.
    expect(parsed.kubernetes?.registry).toEqual({ url: 'localhost:5052', insecure: true });
    // The address that flips CLI builds to docker-free BuildKit.
    expect(parsed.kubernetes?.buildkit).toEqual({ addr: 'tcp://127.0.0.1:5054' });
  });
});

describe('shouldRestartDaemon', () => {
  const sha = 'abc123';
  it('keeps a matching daemon (runtime + kubeconfig unchanged)', () => {
    expect(shouldRestartDaemon({ runtime: 'vm', kubeconfigSha: sha }, { runtime: 'vm', kubeconfigSha: sha })).toBe(
      false
    );
    expect(shouldRestartDaemon({ runtime: 'docker' }, { runtime: 'docker' })).toBe(false);
  });

  it('restarts on a runtime switch in either direction', () => {
    expect(shouldRestartDaemon({ runtime: 'docker' }, { runtime: 'vm', kubeconfigSha: sha })).toBe(true);
    expect(shouldRestartDaemon({ runtime: 'vm', kubeconfigSha: sha }, { runtime: 'docker' })).toBe(true);
  });

  it('treats legacy state (no runtime field) as docker', () => {
    // Legacy docker daemon + default vm request → restart onto the VM.
    expect(shouldRestartDaemon({}, { runtime: 'vm', kubeconfigSha: sha })).toBe(true);
    expect(shouldRestartDaemon(null, { runtime: 'vm', kubeconfigSha: sha })).toBe(true);
    // Legacy daemon + explicit docker request → keep it.
    expect(shouldRestartDaemon({}, { runtime: 'docker' })).toBe(false);
  });

  it('restarts a vm daemon whose kubeconfig went stale (VM recreated)', () => {
    expect(shouldRestartDaemon({ runtime: 'vm', kubeconfigSha: 'old' }, { runtime: 'vm', kubeconfigSha: sha })).toBe(
      true
    );
    // And one that predates sha tracking entirely.
    expect(shouldRestartDaemon({ runtime: 'vm' }, { runtime: 'vm', kubeconfigSha: sha })).toBe(true);
  });

  it('ignores kubeconfig for the docker runtime', () => {
    expect(shouldRestartDaemon({ runtime: 'docker', kubeconfigSha: 'old' }, { runtime: 'docker' })).toBe(false);
  });
});
