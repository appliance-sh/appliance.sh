import { describe, it, expect } from 'vitest';
import type { Profile } from './profile-store.js';
import { classifyCluster, planRemoval, type ClusterEntry } from './cluster-registry.js';

const profile = (over: Partial<Profile> = {}): Profile => ({
  apiUrl: 'http://api.appliance.localhost:8081',
  keyId: 'key-1',
  secret: 's3cret',
  ...over,
});

describe('classifyCluster', () => {
  it('maps the bare microvm profile to a local cluster on the default VM', () => {
    const c = classifyCluster('microvm', profile(), true);
    expect(c.kind).toBe('local');
    expect(c.vmName).toBe('appliance');
    expect(c.active).toBe(true);
  });

  it('maps a named microvm profile to a local cluster on that VM', () => {
    const c = classifyCluster('microvm-staging', profile(), false);
    expect(c.kind).toBe('local');
    expect(c.vmName).toBe('staging');
    expect(c.active).toBe(false);
  });

  it('treats any non-microVM profile as a remote cluster', () => {
    const c = classifyCluster('prod', profile({ apiUrl: 'https://prod.example.com' }), false);
    expect(c.kind).toBe('remote');
    expect(c.vmName).toBeNull();
    expect(c.apiUrl).toBe('https://prod.example.com');
  });

  it('marks a cluster bootstrapped when it carries state-backend or bootstrap input', () => {
    expect(classifyCluster('prod', profile({ stateBackendUrl: 's3://state' }), false).bootstrapped).toBe(true);
    expect(classifyCluster('prod', profile({ lastBootstrapInput: {} }), false).bootstrapped).toBe(true);
    expect(classifyCluster('prod', profile(), false).bootstrapped).toBe(false);
  });

  it('carries the managed surface through when recorded', () => {
    expect(classifyCluster('prod', profile({ managed: 'desktop' }), false).managed).toBe('desktop');
    expect(classifyCluster('prod', profile(), false).managed).toBeNull();
  });
});

describe('planRemoval', () => {
  const local: ClusterEntry = {
    name: 'microvm',
    apiUrl: 'http://api.appliance.localhost:8081',
    active: true,
    kind: 'local',
    vmName: 'appliance',
    bootstrapped: false,
    managed: 'cli',
  };
  const remote: ClusterEntry = {
    name: 'prod',
    apiUrl: 'https://prod.example.com',
    active: false,
    kind: 'remote',
    vmName: null,
    bootstrapped: true,
    managed: 'cli',
  };

  it('forgets a local cluster by default (leaves the VM alone)', () => {
    expect(planRemoval(local, { deleteVm: false })).toEqual({ kind: 'forget' });
  });

  it('deletes the backing VM for a local cluster with --delete-vm', () => {
    expect(planRemoval(local, { deleteVm: true })).toEqual({ kind: 'delete-vm', vmName: 'appliance' });
  });

  it('forgets a remote cluster by default', () => {
    expect(planRemoval(remote, { deleteVm: false })).toEqual({ kind: 'forget' });
  });

  it('rejects --delete-vm on a remote cluster (no VM here; teardown is the infra path)', () => {
    const plan = planRemoval(remote, { deleteVm: true });
    expect(plan.kind).toBe('error');
    if (plan.kind === 'error') {
      expect(plan.message).toContain('--delete-vm only applies to a local microVM cluster');
      expect(plan.message).toContain('appliance teardown');
    }
  });
});
