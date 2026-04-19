// Explicit `/index.js` so Node's native ESM resolver accepts the deep
// import at runtime (it rejects directory imports); bundlers are happy
// either way. Types come from the umbrella entry.
import { signMessage, verifyMessage } from 'http-message-signatures/lib/httpbis/index.js';
import type { SigningKey, VerifyingKey } from 'http-message-signatures';

// Universal (Node 18+/browser) HMAC-SHA256 signer/verifier using the
// Web Crypto API. We deep-import only the httpbis submodule so the
// package's `algorithm` module (which requires Node `crypto` +
// `constants`) never enters the module graph in a browser bundle.

export interface SigningCredentials {
  keyId: string;
  secret: string;
}

export interface SignRequestInput {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface VerifyRequestInput {
  method: string;
  url: string;
  headers: Record<string, string | string[]>;
}

export type KeyLookup = (keyId: string) => Promise<{ secret: string } | null>;

export interface VerifyResult {
  verified: boolean;
  keyId?: string;
  error?: string;
}

const FIELDS_WITH_BODY = ['@method', '@path', '@authority', 'content-type', 'content-digest'];
const FIELDS_WITHOUT_BODY = ['@method', '@path', '@authority'];

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    throw new Error('Web Crypto API not available. Requires Node 18+ or a modern browser.');
  }
  return c.subtle;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  if (typeof btoa !== 'undefined') return btoa(binary);
  // Node fallback — Buffer is available in Node but not typed here.
  return (
    globalThis as unknown as { Buffer: { from(x: string, enc: string): { toString(e: string): string } } }
  ).Buffer.from(binary, 'binary').toString('base64');
}

function asBytes(data: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

// http-message-signatures types the signer return as `Buffer` and
// formats the Signature header via `.toString('base64')`. In Node
// that's a real Buffer; in the browser we return a Uint8Array with
// a shadow `toString` so `.toString('base64')` still yields valid
// base64 instead of Uint8Array.prototype.toString's comma-joined
// decimal bytes.
function bufferLike(bytes: Uint8Array): Uint8Array {
  const maybeBuffer = (globalThis as unknown as { Buffer?: { from(b: Uint8Array): Uint8Array } }).Buffer;
  if (maybeBuffer) return maybeBuffer.from(bytes);
  const wrapped = new Uint8Array(bytes);
  Object.defineProperty(wrapped, 'toString', {
    value: function (encoding?: string) {
      if (encoding === 'base64') return toBase64(bytes);
      return Array.prototype.join.call(bytes, ',');
    },
    writable: true,
    configurable: true,
  });
  return wrapped;
}

export async function computeContentDigest(body: string): Promise<string> {
  const hash = await subtle().digest('SHA-256', new TextEncoder().encode(body));
  return `sha-256=:${toBase64(new Uint8Array(hash))}:`;
}

async function importHmacKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return subtle().importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

async function hmacSign(secret: string, data: Uint8Array): Promise<Uint8Array> {
  const key = await importHmacKey(secret, ['sign']);
  // `as BufferSource` covers TS 5.7's new Uint8Array<ArrayBufferLike>
  // vs ArrayBufferView<ArrayBuffer> friction — runtime types match.
  const sig = await subtle().sign('HMAC', key, data as BufferSource);
  return new Uint8Array(sig);
}

async function hmacVerify(secret: string, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const key = await importHmacKey(secret, ['verify']);
  return subtle().verify('HMAC', key, signature as BufferSource, data as BufferSource);
}

export async function signRequest(
  credentials: SigningCredentials,
  request: SignRequestInput
): Promise<Record<string, string>> {
  const hasBody = !!request.body;
  const fields = hasBody ? FIELDS_WITH_BODY : FIELDS_WITHOUT_BODY;

  const headers: Record<string, string> = { ...request.headers };
  if (hasBody) {
    headers['content-digest'] = await computeContentDigest(request.body!);
  }

  // Upstream types the signer's data/return as Buffer, but the runtime
  // only uses the Uint8Array surface. Cast so this module stays usable
  // in the browser where Buffer isn't available.
  const signer = {
    id: credentials.keyId,
    alg: 'hmac-sha256',
    sign: async (data: Uint8Array) => {
      const bytes = await hmacSign(credentials.secret, asBytes(data));
      return bufferLike(bytes);
    },
  } as unknown as SigningKey;

  const signed = await signMessage(
    {
      key: signer,
      fields,
      params: ['keyid', 'alg', 'created', 'expires'],
    },
    { method: request.method, url: request.url, headers }
  );

  const result: Record<string, string> = {};
  if (hasBody && headers['content-digest']) {
    result['content-digest'] = headers['content-digest'];
  }
  if (signed.headers['Signature']) {
    result['signature'] = signed.headers['Signature'] as string;
  }
  if (signed.headers['Signature-Input']) {
    result['signature-input'] = signed.headers['Signature-Input'] as string;
  }
  return result;
}

export async function verifySignedRequest(request: VerifyRequestInput, keyLookup: KeyLookup): Promise<VerifyResult> {
  try {
    const result = await verifyMessage(
      {
        keyLookup: async (params): Promise<VerifyingKey | null> => {
          const keyId = params.keyid as string | undefined;
          if (!keyId) return null;
          const keyData = await keyLookup(keyId);
          if (!keyData) return null;
          const verifier = async (data: Uint8Array, signature: Uint8Array) =>
            hmacVerify(keyData.secret, asBytes(data), asBytes(signature));
          return {
            id: keyId,
            algs: ['hmac-sha256'],
            verify: verifier,
          } as unknown as VerifyingKey;
        },
        requiredFields: ['@method', '@path', '@authority'],
        requiredParams: ['keyid', 'alg', 'created'],
        maxAge: 300,
        tolerance: 1,
      },
      { method: request.method, url: request.url, headers: request.headers }
    );

    if (result === true) {
      const sigInput = request.headers['signature-input'] || request.headers['Signature-Input'];
      const keyIdMatch = sigInput?.toString().match(/keyid="([^"]+)"/);
      return { verified: true, keyId: keyIdMatch?.[1] };
    }
    return { verified: false, error: 'Signature verification failed' };
  } catch (err) {
    return { verified: false, error: err instanceof Error ? err.message : String(err) };
  }
}
