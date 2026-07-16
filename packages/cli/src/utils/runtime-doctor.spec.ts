import { describe, it, expect } from 'vitest';
import {
  bootstrapTokenFinding,
  classifyIngressClaims,
  classifyKeychainCoherence,
  classifyProfileBinding,
  compareVersionStamp,
  decideRemintPlan,
  doctorVmForProfile,
  extractIngressClaims,
  portOfApiUrl,
  triangulateAuth,
  type AuthProbeInput,
  type EngineListing,
  type IngressClaim,
} from './runtime-doctor.js';

describe('doctorVmForProfile', () => {
  it('maps the canonical local profile AND the legacy microvm profile to the default VM', () => {
    // Unlike cluster-target's vmNameForProfile, `local` must map too —
    // it is the default VM's PRIMARY profile (profileForVm).
    expect(doctorVmForProfile('local')).toBe('appliance');
    expect(doctorVmForProfile('microvm')).toBe('appliance');
  });

  it('maps named microvm profiles to their VM and everything else to null', () => {
    expect(doctorVmForProfile('microvm-staging')).toBe('staging');
    expect(doctorVmForProfile('prod')).toBeNull();
    expect(doctorVmForProfile('default')).toBeNull();
  });
});

describe('portOfApiUrl', () => {
  it('reads explicit ports and protocol defaults', () => {
    expect(portOfApiUrl('http://api.appliance.localhost:8081')).toBe(8081);
    expect(portOfApiUrl('http://api.appliance.localhost')).toBe(80);
    expect(portOfApiUrl('https://prod.example.com')).toBe(443);
  });

  it('returns null for garbage', () => {
    expect(portOfApiUrl('not a url')).toBeNull();
  });
});

describe('classifyProfileBinding', () => {
  const engine: EngineListing = {
    available: true,
    vms: [
      { name: 'appliance', running: true, hostPort: 8081 },
      { name: 'staging', running: false, hostPort: 8100 },
    ],
  };
  const url = (port: number) => `http://api.appliance.localhost:${port}`;

  it('passes a profile whose apiUrl matches its VM hostPort', () => {
    expect(classifyProfileBinding('local', url(8081), engine)).toEqual({
      kind: 'ok',
      vmName: 'appliance',
      port: 8081,
    });
    expect(classifyProfileBinding('microvm-staging', url(8100), engine)).toEqual({
      kind: 'ok',
      vmName: 'staging',
      port: 8100,
    });
  });

  it('flags a profile whose VM is gone as an orphan — only on a successful listing', () => {
    expect(classifyProfileBinding('microvm-ghost', url(8105), engine)).toEqual({
      kind: 'orphan',
      vmName: 'ghost',
    });
  });

  it('NEVER classifies as orphan when the engine binary is unavailable', () => {
    // The critical safety rule: engine-binary-missing must not count as
    // VM-missing, or a broken install would strip working profiles.
    const noEngine: EngineListing = { available: false };
    expect(classifyProfileBinding('microvm-ghost', url(8105), noEngine)).toEqual({
      kind: 'engine-unavailable',
      vmName: 'ghost',
    });
  });

  it('flags a port that drifted from the VM spec as stale', () => {
    expect(classifyProfileBinding('local', url(9999), engine)).toEqual({
      kind: 'stale-port',
      vmName: 'appliance',
      profilePort: 9999,
      vmPort: 8081,
    });
    // An unparseable apiUrl degrades to stale (port -1), not a crash.
    expect(classifyProfileBinding('local', 'garbage', engine)).toMatchObject({
      kind: 'stale-port',
      profilePort: -1,
    });
  });

  it('flags a port owned by ANOTHER VM as cross-wired (worse than stale: requests reach the wrong cluster)', () => {
    expect(classifyProfileBinding('local', url(8100), engine)).toEqual({
      kind: 'cross-wired',
      vmName: 'appliance',
      profilePort: 8100,
      vmPort: 8081,
      portOwner: 'staging',
    });
  });

  it('leaves remote profiles out of scope', () => {
    expect(classifyProfileBinding('prod', 'https://prod.example.com', engine)).toEqual({ kind: 'remote' });
  });
});

describe('triangulateAuth', () => {
  const base: AuthProbeInput = {
    bootstrapReachable: true,
    signed: { kind: 'http', status: 401 },
    clockSkewSeconds: 2,
    bootstrapTokenPresent: true,
  };

  it('passes when the signed request is accepted', () => {
    const f = triangulateAuth({ ...base, signed: { kind: 'ok', serverVersion: 'v1.51.2' } });
    expect(f.severity).toBe('ok');
  });

  it('fails on an unreachable server before blaming the key', () => {
    const f = triangulateAuth({ ...base, bootstrapReachable: false });
    expect(f.severity).toBe('fail');
    expect(f.detail).toContain('unreachable');
    expect(f.fix).toBeUndefined();
  });

  it('blames the CLOCK for a 401 when skew is at/over the signature tolerance', () => {
    const f = triangulateAuth({ ...base, clockSkewSeconds: -40 });
    expect(f.severity).toBe('fail');
    expect(f.detail).toContain('CLOCK');
    expect(f.fix).toBeUndefined();
  });

  it('blames the KEY for a 401 when the server answers and the clock is in tolerance', () => {
    const f = triangulateAuth(base);
    expect(f.severity).toBe('fail');
    expect(f.detail).toContain('does not know this key');
    expect(f.fix).toEqual({ kind: 'remint-key' });
    expect(f.remediation).toContain('--fix');
  });

  it('offers no re-mint when the bootstrap token is missing (no heal path)', () => {
    const f = triangulateAuth({ ...base, bootstrapTokenPresent: false });
    expect(f.severity).toBe('fail');
    expect(f.fix).toBeUndefined();
    expect(f.remediation).toContain('No bootstrap token');
  });

  it('reports ambiguity honestly when engine skew data is unavailable', () => {
    const f = triangulateAuth({ ...base, clockSkewSeconds: null });
    expect(f.severity).toBe('fail');
    expect(f.detail).toContain('ambiguous');
  });

  it('downgrades non-401 statuses to a warning (not an auth diagnosis)', () => {
    const f = triangulateAuth({ ...base, signed: { kind: 'http', status: 500 } });
    expect(f.severity).toBe('warn');
    expect(f.detail).toContain('500');
  });
});

describe('ingress claims', () => {
  const kubectlPrefix = 'kubectl --kubeconfig /home/u/.appliance/vm/appliance/kubeconfig.yaml';
  const claim = (name: string, namespace: string, hosts: string[]): IngressClaim => ({ name, namespace, hosts });

  it('extracts name/namespace/hosts from kubectl JSON and tolerates junk', () => {
    const json = {
      items: [
        {
          metadata: { name: 'appliance-api-server', namespace: 'default' },
          spec: { rules: [{ host: 'api.appliance.localhost' }] },
        },
        { metadata: { name: 'no-rules', namespace: 'x' } },
        { spec: { rules: [{ host: 'orphan.example' }] } }, // no metadata.name → dropped
      ],
    };
    expect(extractIngressClaims(json)).toEqual([
      claim('appliance-api-server', 'default', ['api.appliance.localhost']),
      claim('no-rules', 'x', []),
    ]);
    expect(extractIngressClaims({})).toEqual([]);
    expect(extractIngressClaims(null)).toEqual([]);
  });

  it('passes exactly one canonical claimant', () => {
    const findings = classifyIngressClaims(
      [claim('appliance-api-server', 'default', ['api.appliance.localhost'])],
      kubectlPrefix
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('ok');
  });

  it('fails duplicates on the api hostname with the exact delete command for the NON-canonical claimant', () => {
    const findings = classifyIngressClaims(
      [
        claim('appliance-api-server', 'default', ['api.appliance.localhost']),
        claim('appliance-api-server', 'appliance-system', ['api.appliance.localhost']),
      ],
      kubectlPrefix
    );
    const apiFinding = findings.find((f) => f.id === 'runtime:ingress-api');
    expect(apiFinding?.severity).toBe('fail');
    expect(apiFinding?.remediation).toBe(`${kubectlPrefix} delete ingress appliance-api-server -n appliance-system`);
    // The canonical claimant must never be the one nominated for deletion.
    expect(apiFinding?.remediation).not.toContain('-n default');
  });

  it('warns when nothing claims the api hostname yet', () => {
    const findings = classifyIngressClaims([claim('web', 'default', ['app.appliance.localhost'])], kubectlPrefix);
    const apiFinding = findings.find((f) => f.id === 'runtime:ingress-api');
    expect(apiFinding?.severity).toBe('warn');
  });

  it('warns (not fails) on duplicate user hostnames', () => {
    const findings = classifyIngressClaims(
      [
        claim('appliance-api-server', 'default', ['api.appliance.localhost']),
        claim('a', 'default', ['web.appliance.localhost']),
        claim('b', 'default', ['web.appliance.localhost']),
      ],
      kubectlPrefix
    );
    const dup = findings.find((f) => f.id === 'runtime:ingress:web.appliance.localhost');
    expect(dup?.severity).toBe('warn');
  });
});

describe('compareVersionStamp', () => {
  it('passes when CLI, staged stamp, and running server agree (v-prefix insensitive)', () => {
    expect(compareVersionStamp('v1.51.2:arm64', 'v1.51.2', 'v1.51.2').severity).toBe('ok');
    expect(compareVersionStamp('1.51.2:arm64', 'v1.51.2', null).severity).toBe('ok');
  });

  it('suggests a RESTART when the running server predates the staged stamp', () => {
    const f = compareVersionStamp('v1.51.2:arm64', 'v1.51.2', 'v1.50.0');
    expect(f.severity).toBe('warn');
    expect(f.detail).toContain('booted before the restage');
    expect(f.remediation).toContain('appliance vm stop && appliance vm up');
  });

  it('suggests a RESTAGE when the stamp trails the CLI', () => {
    const f = compareVersionStamp('v1.50.0:arm64', 'v1.51.2', null);
    expect(f.severity).toBe('warn');
    expect(f.remediation).toContain('appliance vm up');
  });

  it('treats a missing stamp and an override stamp as informational', () => {
    expect(compareVersionStamp(null, 'v1.51.2', null).severity).toBe('info');
    expect(compareVersionStamp('override:arm64:123:456:no-console', 'v1.51.2', 'v1.51.2').severity).toBe('info');
  });
});

describe('classifyKeychainCoherence', () => {
  const profile = (keyId: string, secret: string) => ({ keyId, secret });

  it('returns null when the check does not apply', () => {
    expect(classifyKeychainCoherence('prod', profile('k1', 's'), { kind: 'not-applicable' })).toBeNull();
  });

  it('passes a matching Keychain entry with an empty file secret (the macOS policy)', () => {
    const f = classifyKeychainCoherence('c1', profile('k1', ''), { kind: 'found', keyId: 'k1' });
    expect(f?.severity).toBe('ok');
  });

  it('flags a desktop-managed profile with a cleartext secret on disk as a policy violation', () => {
    const f = classifyKeychainCoherence('c1', profile('k1', 's3cret'), { kind: 'found', keyId: 'k1' });
    expect(f?.severity).toBe('warn');
    expect(f?.detail).toContain('cleartext');
  });

  it('offers the Keychain write-back when the FILE is fresher (rotate that missed the Keychain)', () => {
    const f = classifyKeychainCoherence('c1', profile('k2', 's3cret'), { kind: 'found', keyId: 'k1' });
    expect(f?.severity).toBe('warn');
    expect(f?.fix).toEqual({ kind: 'keychain-writeback' });
  });

  it('treats stale file metadata (Keychain fresher, no file secret) as self-healing', () => {
    const f = classifyKeychainCoherence('c1', profile('k1', ''), { kind: 'found', keyId: 'k2' });
    expect(f?.severity).toBe('warn');
    expect(f?.fix).toBeUndefined();
  });

  it('fails hard when neither the Keychain nor the file holds a secret', () => {
    const f = classifyKeychainCoherence('c1', profile('k1', ''), { kind: 'missing' });
    expect(f?.severity).toBe('fail');
    expect(f?.detail).toContain('no usable secret');
  });

  it('offers write-back when the Keychain entry is missing but the file has the secret', () => {
    const f = classifyKeychainCoherence('c1', profile('k1', 's3cret'), { kind: 'missing' });
    expect(f?.severity).toBe('warn');
    expect(f?.fix).toEqual({ kind: 'keychain-writeback' });
  });

  it('degrades to informational when macOS denies the Keychain read', () => {
    const f = classifyKeychainCoherence('c1', profile('k1', ''), { kind: 'unreadable' });
    expect(f?.severity).toBe('info');
    expect(f?.detail).toContain('denied');
  });
});

describe('decideRemintPlan', () => {
  it('verifies first when the stored keyId moved since the failing probe (concurrent rekey)', () => {
    // decide_heal safeguard: another surface re-keyed while doctor ran
    // — verify + adopt that key instead of minting on top of it.
    expect(decideRemintPlan('k-old', 'k-new')).toBe('verify-first');
  });

  it('mints when the stored key is still the failing one (or gone)', () => {
    expect(decideRemintPlan('k-old', 'k-old')).toBe('mint');
    expect(decideRemintPlan('k-old', undefined)).toBe('mint');
    expect(decideRemintPlan('k-old', '')).toBe('mint');
  });
});

describe('bootstrapTokenFinding', () => {
  it('passes when the token file exists and warns about the missing heal path otherwise', () => {
    expect(bootstrapTokenFinding('appliance', true).severity).toBe('ok');
    const missing = bootstrapTokenFinding('appliance', false);
    expect(missing.severity).toBe('warn');
    expect(missing.detail).toContain('no heal path');
  });
});
