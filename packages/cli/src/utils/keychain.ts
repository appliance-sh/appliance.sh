import { execFileSync } from 'node:child_process';
import type { Profile } from './profile-store.js';

// Keychain-first credential resolution (E4.4).
//
// OWNER DECISION: on macOS the OS Keychain is the canonical store for a
// desktop-managed cluster's API-key SECRET; ~/.appliance/profiles.json
// keeps only the (non-secret) metadata — apiUrl, keyId, name. On every
// other platform profiles.json (mode 0600) stays canonical, since the
// CLI cannot read libsecret/DPAPI and the desktop dual-writes the secret
// to the file there.
//
// This module mirrors how the desktop names its Keychain entries
// (packages/desktop/src-tauri/src/lib.rs):
//   service  = "sh.appliance.desktop"   (KEYCHAIN_SERVICE there)
//   account  = "cluster:<id>"           (cluster_keychain_account())
//   password = JSON {"id","secret"}     (a serialized ApiKey)
// For a desktop-managed profile the profiles.json map key IS the desktop
// cluster id, so the account is `cluster:<name>`.
//
// SECURITY: never log the secret. The read path passes nothing sensitive
// on argv; the (rare) write path does — see writeKeychainApiKey.
export const KEYCHAIN_SERVICE = 'sh.appliance.desktop';

const SECURITY_BIN = '/usr/bin/security';

export interface KeychainApiKey {
  keyId: string;
  secret: string;
}

function isMacOS(): boolean {
  return process.platform === 'darwin';
}

/**
 * The Keychain account that backs a profile's secret, or null when the
 * secret is NOT Keychain-backed: non-macOS, or a CLI-managed profile
 * (login / bootstrap / microVM) whose secret lives in profiles.json.
 */
export function keychainAccountFor(name: string, profile: Pick<Profile, 'managed'>): string | null {
  if (!isMacOS()) return null;
  if (profile.managed !== 'desktop') return null;
  return `cluster:${name}`;
}

/**
 * Parse the raw password payload a desktop-written Keychain entry stores
 * (a serialized ApiKey, `{"id","secret"}`). Pure and unit-testable: trims,
 * JSON-parses, and guards that both fields are non-empty strings. Returns
 * null on any malformed / empty / non-string payload so callers fall back
 * to the profiles.json copy. Never logs the secret.
 */
export function parseKeychainPayload(out: string): KeychainApiKey | null {
  const trimmed = out.trim();
  if (!trimmed) return null;
  let parsed: { id?: unknown; secret?: unknown };
  try {
    parsed = JSON.parse(trimmed) as { id?: unknown; secret?: unknown };
  } catch {
    return null;
  }
  if (typeof parsed.id !== 'string' || typeof parsed.secret !== 'string') return null;
  if (parsed.id.length === 0 || parsed.secret.length === 0) return null;
  return { keyId: parsed.id, secret: parsed.secret };
}

/**
 * Read a desktop-written Keychain entry, avoiding a GUI prompt where
 * possible. Uses `security find-generic-password -w`, which prints the
 * stored password (the JSON ApiKey) to stdout. A cross-binary read of an
 * item the desktop created can trigger a one-time macOS access prompt the
 * first time; "Always Allow" suppresses it thereafter (this is the
 * macOS ACL behaviour, not something the CLI can opt out of). Returns
 * null on any miss / parse / permission failure so callers fall back to
 * the profiles.json copy. Never logs the secret.
 */
export function readKeychainApiKey(account: string): KeychainApiKey | null {
  if (!isMacOS()) return null;
  try {
    const out = execFileSync(SECURITY_BIN, ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseKeychainPayload(out);
  } catch {
    // Item missing or access denied — fall back to file.
    return null;
  }
}

/**
 * Create-or-update a desktop Keychain entry from the CLI (e.g. after
 * `appliance keys rotate` on a desktop-managed cluster) so the canonical
 * macOS store stays fresh. `-U` upserts. Best-effort: returns false on
 * any failure, and the caller then keeps the secret in profiles.json so
 * the user isn't stranded.
 *
 * SECURITY: `security` has no stdin password option for add-generic-
 * password, so the secret is passed via argv and is briefly visible to
 * `ps` for the duration of the exec. This is the only place the CLI puts
 * a secret on a command line; it is gated to the rare desktop-managed
 * rotate path. Flagged for security review in docs/control-plane.md §5.
 * Never logs the secret.
 */
export function writeKeychainApiKey(account: string, key: KeychainApiKey): boolean {
  if (!isMacOS()) return false;
  try {
    const payload = JSON.stringify({ id: key.keyId, secret: key.secret });
    execFileSync(SECURITY_BIN, ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', account, '-w', payload], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure credential-source choice (unit-testable; mirrors the desktop's
 * pure `decide_seed`). Given the profile's file copy and what the
 * Keychain returned (or null), pick the authoritative {keyId, secret}:
 *
 *   - no Keychain entry      -> file copy (non-macOS, CLI-managed, or a
 *                               Keychain miss/declined access).
 *   - file copy is FRESHER   -> file copy. Detected by a non-empty file
 *                               secret whose keyId differs from the
 *                               Keychain's: a CLI write (rotate) that
 *                               could not reach the Keychain. The keyId is
 *                               the version marker, so this self-heals a
 *                               degraded write without serving a stale key.
 *   - otherwise              -> Keychain (canonical on macOS).
 */
export function chooseCredential(
  profile: Pick<Profile, 'keyId' | 'secret'>,
  keychainKey: KeychainApiKey | null
): { keyId: string; secret: string } {
  if (!keychainKey) {
    return { keyId: profile.keyId, secret: profile.secret };
  }
  if (profile.secret.length > 0 && profile.keyId !== keychainKey.keyId) {
    return { keyId: profile.keyId, secret: profile.secret };
  }
  return { keyId: keychainKey.keyId, secret: keychainKey.secret };
}

/**
 * Resolve a profile's credential Keychain-first on macOS (desktop-managed
 * clusters), file-only elsewhere. The IO wrapper over chooseCredential.
 */
export function resolveProfileSecret(
  name: string,
  profile: Pick<Profile, 'managed' | 'keyId' | 'secret'>
): { keyId: string; secret: string } {
  const account = keychainAccountFor(name, profile);
  const keychainKey = account ? readKeychainApiKey(account) : null;
  return chooseCredential(profile, keychainKey);
}
