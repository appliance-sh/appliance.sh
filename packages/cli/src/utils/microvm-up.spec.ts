import { describe, it, expect } from 'vitest';
import { historyGuaranteesPlatformReady } from './microvm-up.js';

// The fast-pass decision that shrinks the CLI's load-bearing registry /
// api-server waits to quick confirmations. Two independent guards must
// BOTH hold: the engine's bring-up history shows the honest-readiness
// `ingress` phase, and the history is at least as fresh as the
// kubeconfig (an engine DOWNGRADE clears only bringup.json, so a new
// engine's history can survive, stale, next to a kubeconfig an old
// engine just wrote).
describe('historyGuaranteesPlatformReady', () => {
  const ingressHistory =
    '{"phase":"cluster-api","at":1000}\n{"phase":"ingress","detail":"in-VM registry","at":2000}\n{"phase":"ready","at":3000}\n';

  it('fast-passes when the history shows ingress and is fresher than the kubeconfig', () => {
    expect(historyGuaranteesPlatformReady(ingressHistory, 2_000, 1_000)).toBe(true);
  });

  it('fast-passes on equal mtimes (same-instant writes on coarse clocks)', () => {
    expect(historyGuaranteesPlatformReady(ingressHistory, 1_000, 1_000)).toBe(true);
  });

  it('slow-paths when the history is STALE (engine downgrade: old engine rewrote the kubeconfig, never the history)', () => {
    expect(historyGuaranteesPlatformReady(ingressHistory, 1_000, 2_000)).toBe(false);
  });

  it('slow-paths when the history never reached ingress (old engine, or a boot that died early)', () => {
    const early = '{"phase":"media","at":1000}\n{"phase":"cluster","at":2000}\n';
    expect(historyGuaranteesPlatformReady(early, 2_000, 1_000)).toBe(false);
  });

  it('slow-paths on an empty history', () => {
    expect(historyGuaranteesPlatformReady('', 2_000, 1_000)).toBe(false);
  });
});
