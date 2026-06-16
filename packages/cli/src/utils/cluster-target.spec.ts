import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ClusterTargetError,
  kubectlBaseArgs,
  resolveClusterTarget,
  stackSelector,
  vmKubeconfigPath,
  vmNameForProfile,
} from './cluster-target.js';

describe('vmNameForProfile', () => {
  it('maps the bare microvm profile to the default VM', () => {
    expect(vmNameForProfile('microvm')).toBe('appliance');
  });

  it('maps a named microvm profile to its VM name', () => {
    expect(vmNameForProfile('microvm-staging')).toBe('staging');
  });

  it('returns null for non-microVM profiles', () => {
    expect(vmNameForProfile('local-runtime')).toBeNull();
    expect(vmNameForProfile('prod')).toBeNull();
    expect(vmNameForProfile(undefined)).toBeNull();
  });
});

describe('resolveClusterTarget', () => {
  it('defaults to the k3d local context for the local-runtime profile', () => {
    const t = resolveClusterTarget({ profile: 'local-runtime' });
    expect(t.context).toBe('k3d-appliance-local');
    expect(t.kubeconfig).toBeUndefined();
    expect(t.namespace).toBe('appliance');
    expect(t.source).toBe('local-runtime');
  });

  it('honors a namespace override', () => {
    const t = resolveClusterTarget({ profile: 'local-runtime', namespace: 'custom-ns' });
    expect(t.namespace).toBe('custom-ns');
  });

  it('uses an explicit context override without touching the profile mapping', () => {
    const t = resolveClusterTarget({ profile: 'microvm', context: 'my-ctx' });
    expect(t.context).toBe('my-ctx');
    expect(t.source).toBe('override');
  });

  it('throws ClusterTargetError when an override kubeconfig is missing', () => {
    expect(() => resolveClusterTarget({ kubeconfig: '/no/such/kubeconfig.yaml' })).toThrow(ClusterTargetError);
  });

  it('throws ClusterTargetError when a microVM kubeconfig is absent', () => {
    // The default microVM is almost certainly not up in CI, so its
    // kubeconfig is absent — exercising the actionable error path.
    expect(() => resolveClusterTarget({ profile: 'microvm-definitely-not-running-xyz' })).toThrow(ClusterTargetError);
  });
});

describe('vmKubeconfigPath', () => {
  it('points under ~/.appliance/vm/<name>', () => {
    expect(vmKubeconfigPath('staging')).toBe(path.join(os.homedir(), '.appliance', 'vm', 'staging', 'kubeconfig.yaml'));
  });
});

describe('kubectlBaseArgs', () => {
  it('emits --kubeconfig + namespace for a file target', () => {
    expect(kubectlBaseArgs({ kubeconfig: '/k.yaml', namespace: 'appliance', source: 'x' })).toEqual([
      '--kubeconfig',
      '/k.yaml',
      '-n',
      'appliance',
    ]);
  });

  it('emits --context + namespace for a context target', () => {
    expect(kubectlBaseArgs({ context: 'k3d-appliance-local', namespace: 'appliance', source: 'x' })).toEqual([
      '--context',
      'k3d-appliance-local',
      '-n',
      'appliance',
    ]);
  });
});

describe('stackSelector', () => {
  it('builds an app.kubernetes.io/name selector', () => {
    expect(stackSelector('demo-production')).toBe('app.kubernetes.io/name=demo-production');
  });
});
