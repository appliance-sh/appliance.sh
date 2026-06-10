import { describe, expect, it } from 'vitest';
import {
  apiServerUrlForHostPort,
  buildInClusterBaseConfig,
  renderInClusterApiServerManifest,
  yamlDoubleQuoted,
  type ResolvedRuntimeConfig,
} from './api-server.js';

function cfg(overrides: Partial<ResolvedRuntimeConfig> = {}): ResolvedRuntimeConfig {
  return {
    clusterName: 'appliance-local',
    namespace: 'appliance',
    hostPort: 8081,
    dataDir: '/Users/dev/.appliance/local-runtime',
    apiServerUrl: 'http://api.appliance.localhost:8081',
    registryPort: 5050,
    registryUrl: 'localhost:5050',
    ...overrides,
  };
}

describe('yamlDoubleQuoted', () => {
  it('escapes backslashes before quotes so Windows paths survive', () => {
    expect(yamlDoubleQuoted('C:\\Users\\dev\\AppData')).toBe('C:\\\\Users\\\\dev\\\\AppData');
  });

  it('escapes newlines and double quotes', () => {
    expect(yamlDoubleQuoted('a"b\nc')).toBe('a\\"b\\nc');
  });
});

describe('buildInClusterBaseConfig', () => {
  it('emits an appliance-base-kubernetes config with the registry when present', () => {
    const parsed = JSON.parse(buildInClusterBaseConfig(cfg()));
    expect(parsed.type).toBe('appliance-base-kubernetes');
    expect(parsed.kubernetes.dataDir).toBe('/data');
    expect(parsed.kubernetes.namespace).toBe('appliance');
    expect(parsed.kubernetes.registry).toEqual({ url: 'localhost:5050', insecure: true });
  });

  it('omits the registry block entirely when no registry exists', () => {
    const parsed = JSON.parse(buildInClusterBaseConfig(cfg({ registryUrl: null })));
    expect('registry' in parsed.kubernetes).toBe(false);
  });

  it('tracks a namespace override instead of hardcoding the default', () => {
    const parsed = JSON.parse(buildInClusterBaseConfig(cfg({ namespace: 'custom-ns' })));
    expect(parsed.kubernetes.namespace).toBe('custom-ns');
  });
});

describe('renderInClusterApiServerManifest', () => {
  it('round-trips the base config through YAML escaping intact', () => {
    const manifest = renderInClusterApiServerManifest(cfg(), 'ghcr.io/appliance-sh/api-server:latest', 'tok123');
    const line = manifest.split('\n').find((l) => l.includes('APPLIANCE_BASE_CONFIG'));
    expect(line).toBeDefined();
    // Undo the YAML double-quoted escaping and confirm the JSON parses
    // back to the original config — the exact property kubectl relies on.
    const quoted = line!.slice(line!.indexOf('"'));
    const unescaped = quoted.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
    expect(JSON.parse(unescaped)).toEqual(JSON.parse(buildInClusterBaseConfig(cfg())));
  });

  it('escapes Windows data dirs so kubectl accepts the hostPath', () => {
    const manifest = renderInClusterApiServerManifest(
      cfg({ dataDir: 'C:\\Users\\dev\\AppData\\appliance' }),
      'img',
      'tok'
    );
    expect(manifest).toContain('path: "C:\\\\Users\\\\dev\\\\AppData\\\\appliance"');
  });

  it('pins the deployment to the requested image and bootstrap token', () => {
    const manifest = renderInClusterApiServerManifest(cfg(), 'localhost:5050/appliance-api-server:dev', 'tok456');
    expect(manifest).toContain('image: "localhost:5050/appliance-api-server:dev"');
    expect(manifest).toContain('BOOTSTRAP_TOKEN: "tok456"');
    expect(manifest).toContain('host: api.appliance.localhost');
  });
});

describe('apiServerUrlForHostPort', () => {
  it('omits the port when it is 80', () => {
    expect(apiServerUrlForHostPort(80)).toBe('http://api.appliance.localhost');
  });

  it('includes any other port', () => {
    expect(apiServerUrlForHostPort(8081)).toBe('http://api.appliance.localhost:8081');
  });
});
