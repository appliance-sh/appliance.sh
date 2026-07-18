import { describe, it, expect, afterEach, vi } from 'vitest';
import { signRequest, verifySignedRequest, computeContentDigest } from './index';

const TEST_CREDENTIALS = {
  keyId: 'ak_test-key',
  secret: 'sk_test-secret-value-1234567890',
};

const TEST_HOST = 'api.test.local';

describe('computeContentDigest', () => {
  it('should produce consistent sha-256 digest', async () => {
    const body = '{"name":"test"}';
    const digest1 = await computeContentDigest(body);
    const digest2 = await computeContentDigest(body);
    expect(digest1).toBe(digest2);
    expect(digest1).toMatch(/^sha-256=:.+:$/);
  });

  it('should produce different digests for different bodies', async () => {
    const digest1 = await computeContentDigest('{"a":1}');
    const digest2 = await computeContentDigest('{"a":2}');
    expect(digest1).not.toBe(digest2);
  });
});

describe('signRequest', () => {
  it('should produce signature and signature-input headers for GET', async () => {
    const result = await signRequest(TEST_CREDENTIALS, {
      method: 'GET',
      url: `http://${TEST_HOST}/api/v1/test`,
      headers: { 'content-type': 'application/json' },
    });

    expect(result).toHaveProperty('signature');
    expect(result).toHaveProperty('signature-input');
    expect(result).not.toHaveProperty('content-digest');
  });

  it('should include content-digest for POST with body', async () => {
    const body = JSON.stringify({ name: 'test' });
    const result = await signRequest(TEST_CREDENTIALS, {
      method: 'POST',
      url: `http://${TEST_HOST}/api/v1/test`,
      headers: { 'content-type': 'application/json' },
      body,
    });

    expect(result).toHaveProperty('signature');
    expect(result).toHaveProperty('signature-input');
    expect(result).toHaveProperty('content-digest');
    expect(result['content-digest']).toMatch(/^sha-256=:.+:$/);
  });

  it('should include keyId in signature-input', async () => {
    const result = await signRequest(TEST_CREDENTIALS, {
      method: 'GET',
      url: `http://${TEST_HOST}/api/v1/test`,
      headers: {},
    });

    expect(result['signature-input']).toContain(`keyid="${TEST_CREDENTIALS.keyId}"`);
  });

  it('should include hmac-sha256 algorithm in signature-input', async () => {
    const result = await signRequest(TEST_CREDENTIALS, {
      method: 'GET',
      url: `http://${TEST_HOST}/api/v1/test`,
      headers: {},
    });

    expect(result['signature-input']).toContain('alg="hmac-sha256"');
  });
});

describe('verifySignedRequest', () => {
  it('should verify a valid signed GET request', async () => {
    const url = `http://${TEST_HOST}/api/v1/test`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };

    const sigHeaders = await signRequest(TEST_CREDENTIALS, {
      method: 'GET',
      url,
      headers,
    });

    const result = await verifySignedRequest(
      {
        method: 'GET',
        url,
        headers: { ...headers, ...sigHeaders, host: TEST_HOST },
      },
      async (keyId) => {
        if (keyId === TEST_CREDENTIALS.keyId) {
          return { secret: TEST_CREDENTIALS.secret };
        }
        return null;
      }
    );

    expect(result.verified).toBe(true);
    expect(result.keyId).toBe(TEST_CREDENTIALS.keyId);
  });

  it('should verify a valid signed POST request with body', async () => {
    const url = `http://${TEST_HOST}/api/v1/test`;
    const body = JSON.stringify({ name: 'test' });
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };

    const sigHeaders = await signRequest(TEST_CREDENTIALS, {
      method: 'POST',
      url,
      headers,
      body,
    });

    const result = await verifySignedRequest(
      {
        method: 'POST',
        url,
        headers: { ...headers, ...sigHeaders, host: TEST_HOST },
      },
      async (keyId) => {
        if (keyId === TEST_CREDENTIALS.keyId) {
          return { secret: TEST_CREDENTIALS.secret };
        }
        return null;
      }
    );

    expect(result.verified).toBe(true);
  });

  it('should reject request signed with wrong secret', async () => {
    const url = `http://${TEST_HOST}/api/v1/test`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };

    const sigHeaders = await signRequest(TEST_CREDENTIALS, {
      method: 'GET',
      url,
      headers,
    });

    const result = await verifySignedRequest(
      {
        method: 'GET',
        url,
        headers: { ...headers, ...sigHeaders, host: TEST_HOST },
      },
      async () => ({ secret: 'wrong-secret' })
    );

    expect(result.verified).toBe(false);
  });

  it('should reject when key lookup returns null', async () => {
    const url = `http://${TEST_HOST}/api/v1/test`;
    const headers: Record<string, string> = {};

    const sigHeaders = await signRequest(TEST_CREDENTIALS, {
      method: 'GET',
      url,
      headers,
    });

    const result = await verifySignedRequest(
      {
        method: 'GET',
        url,
        headers: { ...headers, ...sigHeaders, host: TEST_HOST },
      },
      async () => null
    );

    expect(result.verified).toBe(false);
  });
});

describe('verifySignedRequest failure causes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const url = `http://${TEST_HOST}/api/v1/test`;

  async function signedHeaders(): Promise<Record<string, string>> {
    const sigHeaders = await signRequest(TEST_CREDENTIALS, { method: 'GET', url, headers: {} });
    return { ...sigHeaders, host: TEST_HOST };
  }

  const lookupReal = async (keyId: string) =>
    keyId === TEST_CREDENTIALS.keyId ? { secret: TEST_CREDENTIALS.secret } : null;

  it('classifies a key-store miss as unknown_key', async () => {
    const headers = await signedHeaders();
    const result = await verifySignedRequest({ method: 'GET', url, headers }, async () => null);
    expect(result.verified).toBe(false);
    expect(result.cause).toBe('unknown_key');
  });

  it('classifies a wrong secret as signature_mismatch', async () => {
    const headers = await signedHeaders();
    const result = await verifySignedRequest({ method: 'GET', url, headers }, async () => ({
      secret: 'wrong-secret',
    }));
    expect(result.verified).toBe(false);
    expect(result.cause).toBe('signature_mismatch');
  });

  it('classifies a stale created timestamp as clock_skew', async () => {
    // Sign 10 minutes in the "past" (beyond maxAge 300s + tolerance):
    // the verifier throws ExpiredError('Signature is too old'). On a
    // local appliance this shape is guest-clock skew, not replay.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() - 10 * 60 * 1000);
    const headers = await signedHeaders();
    vi.useRealTimers();

    const result = await verifySignedRequest({ method: 'GET', url, headers }, lookupReal);
    expect(result.verified).toBe(false);
    expect(result.cause).toBe('clock_skew');
  });

  it('classifies a future-dated created timestamp as clock_skew', async () => {
    // Host clock ahead of the verifier — the historical microVM 401.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);
    const headers = await signedHeaders();
    vi.useRealTimers();

    const result = await verifySignedRequest({ method: 'GET', url, headers }, lookupReal);
    expect(result.verified).toBe(false);
    expect(result.cause).toBe('clock_skew');
  });

  it('classifies corrupted signature bytes as malformed_signature', async () => {
    const headers = await signedHeaders();
    // Not a structured-field byte sequence -> MalformedSignatureError.
    headers['signature'] = 'sig1=notbytes';
    const result = await verifySignedRequest({ method: 'GET', url, headers }, lookupReal);
    expect(result.verified).toBe(false);
    expect(result.cause).toBe('malformed_signature');
  });

  it('classifies a signature-input without its signature as malformed_signature', async () => {
    const headers = await signedHeaders();
    delete headers['signature'];
    const result = await verifySignedRequest({ method: 'GET', url, headers }, lookupReal);
    expect(result.verified).toBe(false);
    expect(result.cause).toBe('malformed_signature');
  });

  it('carries no cause on success', async () => {
    const headers = await signedHeaders();
    const result = await verifySignedRequest({ method: 'GET', url, headers }, lookupReal);
    expect(result.verified).toBe(true);
    expect(result.cause).toBeUndefined();
  });
});
