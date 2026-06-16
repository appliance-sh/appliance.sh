import { describe, it, expect } from 'vitest';
import { parsePodHealth, summarizeDeploymentHealth, type RawPod } from './pod-health.js';

function pod(
  name: string,
  containers: Array<{ ready: boolean; restarts?: number; reason?: string }>,
  phase = 'Running'
): RawPod {
  return {
    metadata: { name },
    status: {
      phase,
      containerStatuses: containers.map((c, i) => ({
        name: `c${i}`,
        ready: c.ready,
        restartCount: c.restarts ?? 0,
        state: c.reason ? { waiting: { reason: c.reason } } : { running: {} },
      })),
    },
  };
}

describe('parsePodHealth', () => {
  it('marks a fully-ready pod healthy with a 1/1 ratio', () => {
    const h = parsePodHealth(pod('app-1', [{ ready: true }]));
    expect(h.ready).toBe(true);
    expect(h.readyRatio).toBe('1/1');
    expect(h.restarts).toBe(0);
  });

  it('sums restart counts and surfaces a crash reason', () => {
    const h = parsePodHealth(pod('app-1', [{ ready: false, restarts: 5, reason: 'CrashLoopBackOff' }]));
    expect(h.ready).toBe(false);
    expect(h.restarts).toBe(5);
    expect(h.containers[0].reason).toBe('CrashLoopBackOff');
  });

  it('is not ready when any container is not ready', () => {
    const h = parsePodHealth(pod('app-1', [{ ready: true }, { ready: false }]));
    expect(h.ready).toBe(false);
    expect(h.readyRatio).toBe('1/2');
  });

  it('handles a pod with no container statuses (Pending)', () => {
    const h = parsePodHealth({ metadata: { name: 'pending' }, status: { phase: 'Pending' } });
    expect(h.ready).toBe(false);
    expect(h.readyRatio).toBe('0/0');
    expect(h.phase).toBe('Pending');
  });

  it('falls back to a placeholder name when metadata is missing', () => {
    expect(parsePodHealth({}).name).toBe('<unknown>');
  });
});

describe('summarizeDeploymentHealth', () => {
  it('reports healthy when every pod is fully ready', () => {
    const h = summarizeDeploymentHealth([pod('a', [{ ready: true }]), pod('b', [{ ready: true }])]);
    expect(h.total).toBe(2);
    expect(h.ready).toBe(2);
    expect(h.healthy).toBe(true);
  });

  it('reports degraded and aggregates restarts when a pod is unhealthy', () => {
    const h = summarizeDeploymentHealth([
      pod('a', [{ ready: true, restarts: 1 }]),
      pod('b', [{ ready: false, restarts: 3, reason: 'CrashLoopBackOff' }]),
    ]);
    expect(h.healthy).toBe(false);
    expect(h.ready).toBe(1);
    expect(h.restarts).toBe(4);
  });

  it('is not healthy when there are no pods at all', () => {
    const h = summarizeDeploymentHealth([]);
    expect(h.total).toBe(0);
    expect(h.healthy).toBe(false);
  });
});
