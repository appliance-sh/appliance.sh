import { describe, expect, it } from 'vitest';
import {
  ApplianceBaseType,
  applianceBaseConfig,
  applianceBaseConfigInput,
  getKubernetesParams,
  isKubernetesBase,
  type ApplianceBaseConfig,
} from './appliance-base';

describe('appliance-base-kubernetes schema', () => {
  it('round-trips a server+token config through the input discriminator', () => {
    const parsed = applianceBaseConfigInput.parse({
      type: ApplianceBaseType.ApplianceKubernetes,
      name: 'remote',
      kubernetes: {
        server: 'https://kube.example.com:6443',
        token: 'sha256~abc',
        ca: 'LS0tLS1CRUdJTi==',
        dataDir: '/data',
        namespace: 'apps',
        hostnameSuffix: 'apps.example.com',
        ingressClassName: 'nginx',
      },
    });
    expect(parsed.type).toBe(ApplianceBaseType.ApplianceKubernetes);
    if (parsed.type !== ApplianceBaseType.ApplianceKubernetes) throw new Error('narrow failed');
    expect(parsed.kubernetes.server).toBe('https://kube.example.com:6443');
    expect(parsed.kubernetes.dataDir).toBe('/data');
  });

  it('round-trips an inline-kubeconfig config', () => {
    const parsed = applianceBaseConfigInput.parse({
      type: ApplianceBaseType.ApplianceKubernetes,
      name: 'kubeconfig',
      kubernetes: {
        kubeconfig: 'apiVersion: v1\nkind: Config\n',
        dataDir: '/data',
      },
    });
    if (parsed.type !== ApplianceBaseType.ApplianceKubernetes) throw new Error('narrow failed');
    expect(parsed.kubernetes.kubeconfig).toContain('apiVersion: v1');
  });

  it('round-trips the optional buildkit address on both input and resolved schemas', () => {
    const input = applianceBaseConfigInput.parse({
      type: ApplianceBaseType.ApplianceKubernetes,
      name: 'local',
      kubernetes: {
        kubeconfig: 'apiVersion: v1\nkind: Config\n',
        dataDir: '/data',
        registry: { url: 'localhost:5052', insecure: true },
        buildkit: { addr: 'tcp://127.0.0.1:5054' },
      },
    });
    if (input.type !== ApplianceBaseType.ApplianceKubernetes) throw new Error('narrow failed');
    expect(input.kubernetes.buildkit?.addr).toBe('tcp://127.0.0.1:5054');

    const resolved = applianceBaseConfig.parse({
      type: ApplianceBaseType.ApplianceKubernetes,
      name: 'local',
      kubernetes: {
        kubeconfig: 'apiVersion: v1\nkind: Config\n',
        dataDir: '/data',
        buildkit: { addr: 'tcp://127.0.0.1:5054' },
      },
    });
    expect(resolved.kubernetes?.buildkit?.addr).toBe('tcp://127.0.0.1:5054');

    // buildkit stays optional: a config without it still parses.
    const bare = applianceBaseConfig.parse({
      type: ApplianceBaseType.ApplianceKubernetes,
      name: 'byo',
      kubernetes: { dataDir: '/data' },
    });
    expect(bare.kubernetes?.buildkit).toBeUndefined();
  });

  it('requires dataDir on the kubernetes variant', () => {
    expect(() =>
      applianceBaseConfigInput.parse({
        type: ApplianceBaseType.ApplianceKubernetes,
        name: 'broken',
        kubernetes: { server: 'https://x', token: 't' },
      })
    ).toThrow();
  });
});

describe('isKubernetesBase', () => {
  it('returns true for local and kubernetes; narrows the union accordingly', () => {
    const local: ApplianceBaseConfig = {
      type: ApplianceBaseType.ApplianceLocal,
      name: 'dev',
      local: { dataDir: '/tmp/dev' },
    };
    const remote: ApplianceBaseConfig = {
      type: ApplianceBaseType.ApplianceKubernetes,
      name: 'remote',
      kubernetes: { dataDir: '/data' },
    };
    const aws: ApplianceBaseConfig = {
      type: ApplianceBaseType.ApplianceAwsPublic,
      name: 'prod',
      aws: { region: 'us-east-1', zoneId: 'Z1' },
    };
    expect(isKubernetesBase(local)).toBe(true);
    expect(isKubernetesBase(remote)).toBe(true);
    expect(isKubernetesBase(aws)).toBe(false);
  });
});

describe('getKubernetesParams', () => {
  it('extracts common k8s deploy params from the local variant', () => {
    const params = getKubernetesParams(
      applianceBaseConfig.parse({
        type: ApplianceBaseType.ApplianceLocal,
        name: 'dev',
        local: {
          dataDir: '/tmp/dev',
          cluster: { namespace: 'demo', hostnameSuffix: 'dev.local', ingressClassName: 'traefik' },
        },
      })
    );
    expect(params).toEqual({
      dataDir: '/tmp/dev',
      namespace: 'demo',
      hostnameSuffix: 'dev.local',
      ingressClassName: 'traefik',
    });
  });

  it('extracts common k8s deploy params from the kubernetes variant', () => {
    const params = getKubernetesParams(
      applianceBaseConfig.parse({
        type: ApplianceBaseType.ApplianceKubernetes,
        name: 'remote',
        kubernetes: {
          dataDir: '/data',
          namespace: 'apps',
          hostnameSuffix: 'apps.example.com',
          ingressClassName: 'nginx',
        },
      })
    );
    expect(params).toEqual({
      dataDir: '/data',
      namespace: 'apps',
      hostnameSuffix: 'apps.example.com',
      ingressClassName: 'nginx',
    });
  });

  it('returns null for AWS bases', () => {
    const params = getKubernetesParams(
      applianceBaseConfig.parse({
        type: ApplianceBaseType.ApplianceAwsPublic,
        name: 'prod',
        aws: { region: 'us-east-1', zoneId: 'Z1' },
      })
    );
    expect(params).toBeNull();
  });
});
