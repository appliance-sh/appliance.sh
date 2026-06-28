import { describe, it, expect } from 'vitest';
import { parseDevcontainerUp, parseDockerPort } from './sandbox.js';

describe('parseDevcontainerUp', () => {
  it('parses a success result with a container id', () => {
    const out =
      '{"outcome":"success","containerId":"abc123","remoteUser":"node","remoteWorkspaceFolder":"/workspaces/app"}';
    expect(parseDevcontainerUp(out)).toEqual({
      outcome: 'success',
      containerId: 'abc123',
      remoteUser: 'node',
      remoteWorkspaceFolder: '/workspaces/app',
    });
  });

  it('takes the LAST result object when stdout carries leading noise', () => {
    const out = ['{"some":"unrelated"}', 'plain log line', '{"outcome":"success","containerId":"deadbeef"}'].join('\n');
    expect(parseDevcontainerUp(out)?.containerId).toBe('deadbeef');
  });

  it('surfaces a non-success outcome + message', () => {
    const out = '{"outcome":"error","message":"build failed","description":"…"}';
    const r = parseDevcontainerUp(out);
    expect(r?.outcome).toBe('error');
    expect(r?.message).toBe('build failed');
  });

  it('returns null when no result object is present', () => {
    expect(parseDevcontainerUp('')).toBeNull();
    expect(parseDevcontainerUp('just some progress text\nno json here')).toBeNull();
  });
});

describe('parseDockerPort', () => {
  it('parses tcp mappings and dedupes the IPv4/IPv6 pair', () => {
    const out = ['3000/tcp -> 0.0.0.0:8201', '3000/tcp -> [::]:8201', '5432/tcp -> 0.0.0.0:8202'].join('\n');
    expect(parseDockerPort(out)).toEqual([
      { containerPort: 3000, hostPort: 8201 },
      { containerPort: 5432, hostPort: 8202 },
    ]);
  });

  it('ignores udp mappings and blank lines', () => {
    const out = ['', '53/udp -> 0.0.0.0:8203', '8080/tcp -> 0.0.0.0:8204', ''].join('\n');
    expect(parseDockerPort(out)).toEqual([{ containerPort: 8080, hostPort: 8204 }]);
  });

  it('returns empty for output with no published ports', () => {
    expect(parseDockerPort('')).toEqual([]);
  });
});
