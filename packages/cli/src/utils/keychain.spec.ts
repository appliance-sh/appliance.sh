import { describe, it, expect } from 'vitest';
import { chooseCredential, keychainAccountFor, parseKeychainPayload, type KeychainApiKey } from './keychain.js';

describe('chooseCredential', () => {
  const fileCopy = { keyId: 'file-key', secret: 'file-secret' };

  it('uses the file copy when there is no Keychain entry', () => {
    // non-macOS, CLI-managed, or a Keychain miss/declined access.
    expect(chooseCredential(fileCopy, null)).toEqual({ keyId: 'file-key', secret: 'file-secret' });
  });

  it('uses the Keychain when the file secret is empty (the normal macOS desktop case)', () => {
    // profiles.json carries metadata only; the secret lives in the Keychain.
    const kc: KeychainApiKey = { keyId: 'kc-key', secret: 'kc-secret' };
    expect(chooseCredential({ keyId: 'kc-key', secret: '' }, kc)).toEqual({ keyId: 'kc-key', secret: 'kc-secret' });
  });

  it('uses the Keychain when both sides agree on keyId', () => {
    const kc: KeychainApiKey = { keyId: 'same', secret: 'kc-secret' };
    expect(chooseCredential({ keyId: 'same', secret: 'stale-file' }, kc)).toEqual({
      keyId: 'same',
      secret: 'kc-secret',
    });
  });

  it('prefers the fresher file copy when keyIds differ (a rotate that could not reach the Keychain)', () => {
    const kc: KeychainApiKey = { keyId: 'old-key', secret: 'old-secret' };
    expect(chooseCredential({ keyId: 'new-key', secret: 'new-secret' }, kc)).toEqual({
      keyId: 'new-key',
      secret: 'new-secret',
    });
  });
});

describe('keychainAccountFor', () => {
  it('never targets the Keychain for CLI-managed profiles', () => {
    // True on every platform: login / bootstrap / microVM secrets live in profiles.json.
    expect(keychainAccountFor('prod', { managed: 'cli' })).toBeNull();
    expect(keychainAccountFor('prod', { managed: undefined })).toBeNull();
  });

  it('maps a desktop-managed profile to cluster:<id> on macOS, and null elsewhere', () => {
    const account = keychainAccountFor('abc-123', { managed: 'desktop' });
    if (process.platform === 'darwin') {
      expect(account).toBe('cluster:abc-123');
    } else {
      expect(account).toBeNull();
    }
  });
});

describe('parseKeychainPayload', () => {
  it('parses a well-formed payload into an ApiKey', () => {
    expect(parseKeychainPayload('{"id":"k1","secret":"s1"}')).toEqual({ keyId: 'k1', secret: 's1' });
  });

  it('trims surrounding whitespace before parsing (security -w appends a newline)', () => {
    expect(parseKeychainPayload('  {"id":"k1","secret":"s1"}\n')).toEqual({ keyId: 'k1', secret: 's1' });
  });

  it('returns null for an empty or whitespace-only payload', () => {
    expect(parseKeychainPayload('')).toBeNull();
    expect(parseKeychainPayload('   \n')).toBeNull();
  });

  it('returns null for a malformed (non-JSON) payload instead of throwing', () => {
    expect(parseKeychainPayload('not json')).toBeNull();
    expect(parseKeychainPayload('{ unterminated')).toBeNull();
  });

  it('returns null when id/secret are missing, non-string, or empty', () => {
    expect(parseKeychainPayload('{"secret":"s1"}')).toBeNull();
    expect(parseKeychainPayload('{"id":"k1"}')).toBeNull();
    expect(parseKeychainPayload('{"id":42,"secret":"s1"}')).toBeNull();
    expect(parseKeychainPayload('{"id":"k1","secret":null}')).toBeNull();
    expect(parseKeychainPayload('{"id":"","secret":"s1"}')).toBeNull();
    expect(parseKeychainPayload('{"id":"k1","secret":""}')).toBeNull();
  });
});
