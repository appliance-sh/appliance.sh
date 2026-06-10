import { describe, expect, it } from 'vitest';
import { isWedgedStartFailure, registryNameForCluster } from './cluster.js';

describe('isWedgedStartFailure', () => {
  it('detects the post-suspend restarting symptom from real k3d output', () => {
    const stderr =
      'WARN[0042] Node k3d-appliance-local-agent-0 is restarting for more than a minute now. ' +
      "Possibly it will recover soon (e.g. when it's waiting to join). Consider using a creation timeout to avoid waiting forever " +
      'FATA[0085] Failed to start container for node k3d-appliance-local-server-0: docker failed to start container: ' +
      'Error response from daemon: container is marked for removal and cannot be started: status=restarting';
    expect(isWedgedStartFailure(stderr)).toBe(true);
  });

  it('detects the stalled-log-line symptom', () => {
    expect(isWedgedStartFailure('FATA[0120] error: node stopped returning log lines')).toBe(true);
  });

  it('detects post-start cluster preparation failures', () => {
    expect(isWedgedStartFailure('FATA[0090] error during post-start cluster preparation: timed out')).toBe(true);
  });

  it('ignores unrelated start failures', () => {
    expect(isWedgedStartFailure('FATA[0001] No clusters found matching given name')).toBe(false);
    expect(isWedgedStartFailure('Cannot connect to the Docker daemon')).toBe(false);
    expect(isWedgedStartFailure('')).toBe(false);
  });
});

describe('registryNameForCluster', () => {
  it('derives the sibling registry name 1:1 from the cluster name', () => {
    expect(registryNameForCluster('appliance-local')).toBe('appliance-local-registry');
  });
});
