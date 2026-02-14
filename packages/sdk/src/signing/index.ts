import { createHash } from 'crypto';
import { createSigner, createVerifier } from 'http-message-signatures';
import httpbis from 'http-message-signatures';

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

export function computeContentDigest(body: string): string {
  const hash = createHash('sha256').update(body).digest('base64');
  return `sha-256=:${hash}:`;
}

export async function signRequest(
  credentials: SigningCredentials,
  request: SignRequestInput
): Promise<Record<string, string>> {
  const key = createSigner(credentials.secret, 'hmac-sha256', credentials.keyId);
  const hasBody = !!request.body;
  const fields = hasBody ? FIELDS_WITH_BODY : FIELDS_WITHOUT_BODY;

  const headers: Record<string, string> = { ...request.headers };
  if (hasBody) {
    headers['content-digest'] = computeContentDigest(request.body!);
  }

  const message = {
    method: request.method,
    url: request.url,
    headers,
  };

  const signed = await httpbis.signMessage(
    {
      key,
      fields,
      params: ['keyid', 'alg', 'created', 'expires'],
    },
    message
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
    const result = await httpbis.verifyMessage(
      {
        keyLookup: async (params) => {
          const keyId = params.keyid as string | undefined;
          if (!keyId) {
            return null;
          }
          const keyData = await keyLookup(keyId);
          if (!keyData) {
            return null;
          }
          const verifier = createVerifier(keyData.secret, 'hmac-sha256');
          return {
            id: keyId,
            algs: ['hmac-sha256'],
            verify: verifier,
          };
        },
        requiredFields: ['@method', '@path', '@authority'],
        requiredParams: ['keyid', 'alg', 'created'],
        maxAge: 300,
        tolerance: 1,
      },
      {
        method: request.method,
        url: request.url,
        headers: request.headers,
      }
    );

    if (result === true) {
      // Extract keyid from signature-input header
      const sigInput = request.headers['signature-input'] || request.headers['Signature-Input'];
      const keyIdMatch = sigInput?.toString().match(/keyid="([^"]+)"/);
      return { verified: true, keyId: keyIdMatch?.[1] };
    }

    return { verified: false, error: 'Signature verification failed' };
  } catch (err) {
    return { verified: false, error: err instanceof Error ? err.message : String(err) };
  }
}
