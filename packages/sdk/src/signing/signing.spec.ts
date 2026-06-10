import { describe, it, expect } from 'vitest';
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
