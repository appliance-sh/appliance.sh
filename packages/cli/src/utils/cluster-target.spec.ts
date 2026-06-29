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
  it('honors a namespace override on an explicit context target', () => {
    const t = resolveClusterTarget({ context: 'my-ctx', namespace: 'custom-ns' });
    expect(t.namespace).toBe('custom-ns');
    expect(t.source).toBe('override');
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

  it('routes an unset / non-microVM profile to the default microVM, never a k3d context', () => {
    // No k3d fallback context anymore: an unset / non-microVM profile
    // resolves exactly like the default microVM. The outcome depends on
    // whether that VM is up on this host (its kubeconfig present), so we
    // assert the invariant that holds either way: it never returns a k3d
    // context, and an unset profile behaves the same as a non-microVM one.
    const resolveOrError = (opts: Parameters<typeof resolveClusterTarget>[0]) => {
      try {
        return resolveClusterTarget(opts);
      } catch (err) {
        return err;
      }
    };
    const fromLegacy = resolveOrError({ profile: 'local-runtime' });
    const fromUnset = resolveOrError({});
    if (fromLegacy instanceof Error) {
      expect(fromLegacy).toBeInstanceOf(ClusterTargetError);
      expect(fromUnset).toBeInstanceOf(ClusterTargetError);
    } else {
      expect(fromLegacy.context).toBeUndefined();
      expect(fromLegacy.kubeconfig).toBe(vmKubeconfigPath('appliance'));
      expect(fromLegacy.source).toBe('microvm:appliance');
      expect((fromUnset as typeof fromLegacy).source).toBe('microvm:appliance');
    }
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
    expect(kubectlBaseArgs({ context: 'my-context', namespace: 'appliance', source: 'x' })).toEqual([
      '--context',
      'my-context',
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
