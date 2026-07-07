import { describe, it, expect } from 'vitest';
import { remediationHint } from './errors.js';

// remediationHint maps a failure message to a one-line, self-healing
// fix. These guard the routing: each "worst failure" shape must land on
// the command that actually repairs it, and the broad network catch-all
// must not shadow the more specific shapes above it.
describe('remediationHint', () => {
  it('points unauthenticated failures at `appliance login`', () => {
    expect(remediationHint('Not logged in')).toMatch(/appliance login/);
    expect(remediationHint('request failed with 401 Unauthorized')).toMatch(/appliance login/);
  });

  it('points forbidden failures at the active profile', () => {
    expect(remediationHint('403 Forbidden')).toMatch(/appliance whoami/);
  });

  it('points missing-kubeconfig failures at bringing the runtime up', () => {
    const hint = remediationHint('no kubeconfig at /x/kubeconfig.yaml — is the VM up?');
    expect(hint).toMatch(/appliance vm up/);
  });

  it('points a not-running runtime at `appliance vm up`', () => {
    expect(remediationHint('cluster appliance-local does not exist')).toMatch(/appliance vm up/);
    expect(remediationHint('no such cluster')).toMatch(/appliance vm up/);
  });

  it('points container-runtime failures at starting the runtime', () => {
    expect(remediationHint('Cannot connect to the Docker daemon')).toMatch(/colima start|Docker Desktop/);
  });

  it('points buildkit failures at the microVM, not at Docker', () => {
    // Must win over the docker/daemon catch-all below it — a VM-runtime
    // user should never be told to open Docker Desktop.
    const hint = remediationHint('buildctl: failed to dial tcp://127.0.0.1:5054');
    expect(hint).toMatch(/appliance server start/);
    expect(hint).not.toMatch(/Docker Desktop/);
  });

  it('treats 5xx as a transient server error worth a retry', () => {
    const hint = remediationHint('api returned 503 Service Unavailable', 'http://localhost:8081');
    expect(hint).toMatch(/server error/i);
    expect(hint).toMatch(/localhost:8081/);
  });

  it('falls back to the network catch-all for connection failures', () => {
    const hint = remediationHint('fetch failed (ECONNREFUSED)', 'http://localhost:8081');
    expect(hint).toMatch(/appliance test/);
    expect(hint).toMatch(/localhost:8081/);
  });

  it('returns null when no shape matches', () => {
    expect(remediationHint('some entirely novel failure')).toBeNull();
  });

  it('prefers the specific auth shape over the network catch-all', () => {
    // A message carrying both 401 and a network word must land on login.
    expect(remediationHint('401 Unauthorized: fetch failed')).toMatch(/appliance login/);
  });
});
