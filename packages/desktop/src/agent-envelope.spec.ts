import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ============================================================
// Agent-credential envelope + per-provider store parity (Sasha's L3 nit,
// extended for multi-agent G3).
//
// Each agent's host credential is written by TWO producers that MUST agree
// byte-for-byte, because a third process (the egress broker's
// `print-key --type <agent>`) reads it back and a drift fails the broker CLOSED:
//
//   • Rust  — `microvm_agent_login` in packages/desktop/src-tauri/src/lib.rs
//             (the desktop per-agent login path).
//   • TS    — `writeAgentKey(provider, value, kind)` / `parseStoredCred` in
//             packages/cli/src/utils/agent.ts (the `appliance agent login`
//             path + the print-key reader).
//
// Both write the SAME Keychain item (`sh.appliance.agent`, account = the
// agent's PROVIDER) — or the SAME `<provider>-cred` 0600 file off-macOS —
// holding the SAME `{"kind","value"}` JSON envelope, with the SAME kind strings
// (`api-key` / `oauth` / `pat`). The per-provider store keys (claude-code →
// anthropic, copilot → github-copilot, codex → openai) MUST also agree.
//
// This is a TS-only test: it (1) round-trips the envelope shape both producers
// emit and (2) cross-checks the two SOURCE files so either side drifting fails
// the build. A true end-to-end cross-language test would need a VM/Keychain
// fixture (packages/vm) — out of scope here — so the Rust-parity expectation is
// asserted against the Rust source text and documented above.
// ============================================================

/** The canonical envelope + per-provider store contract. Both producers + the
 *  parser MUST match. */
const CONTRACT = {
  keychainService: 'sh.appliance.agent',
  /** agent `--type` → host cred-store provider key. */
  providers: {
    'claude-code': 'anthropic',
    copilot: 'github-copilot',
    codex: 'openai',
  } as Record<string, string>,
  /** off-macOS 0600 file is `<provider>-cred`. */
  offMacSuffix: '-cred',
  kinds: ['api-key', 'oauth', 'pat'] as const,
  envelopeKeys: ['kind', 'value'] as const,
};

type AgentAuthKind = (typeof CONTRACT.kinds)[number];
interface StoredCred {
  kind: AgentAuthKind;
  value: string;
}

/** Build the envelope exactly as BOTH producers do — the Rust side uses
 *  `serde_json::json!({ "kind": kind, "value": value })` and the TS side uses
 *  `JSON.stringify({ kind, value })`; both serialize the same two-key object. */
function buildEnvelope(kind: AgentAuthKind, value: string): string {
  return JSON.stringify({ kind, value });
}

/** A faithful mirror of `parseStoredCred` (packages/cli/src/utils/agent.ts) and
 *  the Rust `parse_cred_kind` — kept here so the round-trip is self-contained.
 *  The source-drift assertions below guard the real implementations against
 *  diverging from this mirror. Fail-closed: a `{`-prefixed but broken envelope
 *  returns null (never treated as a bare key). */
function parseStoredCredMirror(raw: string): StoredCred | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s) as { kind?: unknown; value?: unknown };
      const kind = o.kind;
      const value = typeof o.value === 'string' ? o.value.trim() : '';
      if ((kind === 'api-key' || kind === 'oauth' || kind === 'pat') && value) return { kind, value };
      return null;
    } catch {
      return null;
    }
  }
  return { kind: 'api-key', value: s };
}

const here = dirname(fileURLToPath(import.meta.url));
const RUST_SRC = readFileSync(resolve(here, '../src-tauri/src/lib.rs'), 'utf-8');
const CLI_SRC = readFileSync(resolve(here, '../../cli/src/utils/agent.ts'), 'utf-8');

describe('agent-credential envelope round-trip', () => {
  it('round-trips every kind through the producer envelope', () => {
    for (const kind of CONTRACT.kinds) {
      const value =
        kind === 'oauth'
          ? 'sk-ant-oat01-roundtrip'
          : kind === 'pat'
            ? 'github_pat_roundtrip'
            : 'sk-ant-api03-roundtrip';
      const envelope = buildEnvelope(kind, value);
      // Exactly the two contract keys, in the documented order.
      expect(Object.keys(JSON.parse(envelope))).toEqual([...CONTRACT.envelopeKeys]);
      expect(parseStoredCredMirror(envelope)).toEqual({ kind, value });
    }
  });

  it('reads a legacy bare string as an api-key (back-compat)', () => {
    expect(parseStoredCredMirror('sk-ant-api03-legacy')).toEqual({
      kind: 'api-key',
      value: 'sk-ant-api03-legacy',
    });
  });

  it('fails CLOSED on a truncated / unknown-kind / empty-value envelope', () => {
    expect(parseStoredCredMirror('{"kind":"oauth","value":"sk-ant-oat01-abc')).toBeNull();
    expect(parseStoredCredMirror('{"kind":"totp","value":"x"}')).toBeNull();
    expect(parseStoredCredMirror('{"kind":"api-key","value":""}')).toBeNull();
    expect(parseStoredCredMirror('   ')).toBeNull();
  });
});

describe('Rust producer parity (packages/desktop/src-tauri/src/lib.rs)', () => {
  it('declares the canonical Keychain service', () => {
    expect(RUST_SRC).toContain(`const AGENT_KEYCHAIN_SERVICE: &str = "${CONTRACT.keychainService}";`);
  });

  it('emits the `{kind,value}` envelope', () => {
    expect(RUST_SRC).toContain('serde_json::json!({ "kind": kind, "value": value })');
  });

  it('maps every agent type to its provider store key', () => {
    expect(RUST_SRC).toContain('"claude-code" => Some("anthropic")');
    expect(RUST_SRC).toContain('"copilot" => Some("github-copilot")');
    expect(RUST_SRC).toContain('"codex" => Some("openai")');
  });

  it('uses the per-provider off-macOS store file', () => {
    expect(RUST_SRC).toContain('.join(format!("{provider}-cred"))');
  });

  it('accepts all contract kinds when parsing', () => {
    expect(RUST_SRC).toContain('kind == "api-key" || kind == "oauth" || kind == "pat"');
  });
});

describe('TS producer/parser parity (packages/cli/src/utils/agent.ts)', () => {
  it('declares the canonical Keychain service', () => {
    expect(CLI_SRC).toContain(`const AGENT_KEYCHAIN_SERVICE = '${CONTRACT.keychainService}';`);
  });

  it('writes the `{kind,value}` envelope', () => {
    expect(CLI_SRC).toContain('JSON.stringify({ kind, value: secret }');
  });

  it('declares exactly the contract kinds', () => {
    expect(CLI_SRC).toContain(`export type AgentAuthKind = 'api-key' | 'oauth' | 'pat';`);
  });

  it('accepts all contract kinds when parsing', () => {
    expect(CLI_SRC).toContain(`(kind === 'api-key' || kind === 'oauth' || kind === 'pat') && value`);
  });

  it('uses the per-provider off-macOS store file', () => {
    expect(CLI_SRC).toContain('`${provider}-cred`');
  });

  it('maps every agent type to its provider store key', () => {
    for (const provider of Object.values(CONTRACT.providers)) {
      expect(CLI_SRC).toContain(`provider: '${provider}'`);
    }
  });
});
