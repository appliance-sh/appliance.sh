import { describe, expect, it } from 'vitest';
import type { WorkloadPod } from '@appliance.sh/sdk';
import { colorFor, diffPods, formatLogLine } from './log-mux.js';

function pod(name: string, phase = 'Running'): WorkloadPod {
  return { name, phase, ready: phase === 'Running', restartCount: 0 };
}

/** Strip ANSI color codes (chalk colorizes only on a TTY). */
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

describe('formatLogLine', () => {
  it('pads the member label into an aligned prefix', () => {
    expect(plain(formatLogLine('web', 8, 0, 'listening on :3000'))).toBe('web      | listening on :3000');
  });

  it('cycles the palette per member index without throwing on overflow', () => {
    for (let i = 0; i < 20; i++) expect(typeof colorFor(i)('x')).toBe('string');
  });
});

describe('diffPods', () => {
  it('returns Running pods that are not already streamed', () => {
    const current = [pod('web-abc'), pod('web-def'), pod('web-old', 'Terminating'), pod('web-new', 'Pending')];
    const streaming = new Set(['web-abc']);
    expect(diffPods(current, streaming).map((p) => p.name)).toEqual(['web-def']);
  });

  it('streams nothing while a rollout is still Pending', () => {
    expect(diffPods([pod('web-x', 'Pending')], new Set())).toEqual([]);
  });
});
