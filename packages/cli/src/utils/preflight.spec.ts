import { describe, it, expect } from 'vitest';
import { REQUIRED_PORTS, checkMacSigning, checkPorts, runFixes } from './preflight.js';
import type { PreflightReport } from './preflight.js';

// These tests cover the deterministic decision logic in the preflight
// suite — the bits that don't depend on what's installed on the test
// machine. Docker is deliberately absent from the suite: nothing in the
// appliance flow needs it (the control plane is a guest binary and
// images build server-side), so no check may reintroduce it.

describe('runPreflight surface', () => {
  it('carries no docker checks — the flow is docker-free by contract', async () => {
    const preflight = await import('./preflight.js');
    expect('checkDockerRuntime' in preflight).toBe(false);
    expect('checkApiServerImage' in preflight).toBe(false);
  });
});

describe('checkMacSigning', () => {
  it('passes as not-applicable off macOS', () => {
    if (process.platform === 'darwin') {
      // On macOS it is an informational warn pointing at the signing step.
      const result = checkMacSigning();
      expect(result.status).toBe('warn');
      expect(result.remediation).toMatch(/sign-dev\.sh|xcode-select/);
    } else {
      const result = checkMacSigning();
      expect(result.status).toBe('pass');
      expect(result.detail).toMatch(/not applicable/i);
    }
  });
});

describe('checkPorts', () => {
  it('returns a result per required port with a stable id', async () => {
    const results = await checkPorts();
    expect(results).toHaveLength(REQUIRED_PORTS.length);
    for (const r of results) {
      expect(r.id).toMatch(/^port:\d+$/);
      expect(['pass', 'fail']).toContain(r.status);
    }
  });
});

describe('runFixes', () => {
  function reportWith(results: PreflightReport['results']): PreflightReport {
    return { ok: true, results };
  }

  it('does nothing when every check passes', async () => {
    expect(await runFixes(reportWith([{ id: 'bin:kubectl', label: 'kubectl', status: 'pass' }]))).toEqual([]);
  });

  it('ignores non-binary failures (ports, toolchain) — those stay with the operator', async () => {
    expect(
      await runFixes(
        reportWith([
          { id: 'port:8081', label: 'Port 8081 free', status: 'fail', detail: 'occupied' },
          { id: 'rust', label: 'Rust toolchain', status: 'warn', detail: 'missing' },
        ])
      )
    ).toEqual([]);
  });
});
