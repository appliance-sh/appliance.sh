import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { verifySignedRequest, computeContentDigest, type ApiKeyRole } from '@appliance.sh/sdk';
import { apiKeyService, roleOf } from '../services/api-key.service';
import { logger } from '../logger';

/**
 * Verify HTTP Message Signatures (RFC 9421) against the shared api-key
 * store. Used for both data-plane `/api/v1/*` routes and the internal
 * server→worker `/api/internal/*` routes — the server re-signs each worker
 * dispatch with the original caller's key, so both sides share the same
 * key lookup.
 */
export async function signatureAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const signature = req.headers['signature'];
  const signatureInput = req.headers['signature-input'];

  if (!signature || !signatureInput) {
    logger.warn('auth failed: missing signature headers', { requestId: req.requestId, path: req.originalUrl });
    res.status(401).json({ error: 'Missing signature headers' });
    return;
  }

  if (req.rawBody && req.rawBody.length > 0) {
    const contentDigest = req.headers['content-digest'] as string | undefined;
    if (!contentDigest) {
      logger.warn('auth failed: missing content-digest', { requestId: req.requestId, path: req.originalUrl });
      res.status(401).json({ error: 'Missing Content-Digest header' });
      return;
    }

    const expected = await computeContentDigest(req.rawBody.toString());
    if (
      contentDigest.length !== expected.length ||
      !timingSafeEqual(Buffer.from(contentDigest), Buffer.from(expected))
    ) {
      logger.warn('auth failed: content-digest mismatch', { requestId: req.requestId, path: req.originalUrl });
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }

  const rawHost = req.app.get('trust proxy') ? req.get('x-forwarded-host') || req.get('host') : req.get('host');
  const host = /^[a-zA-Z0-9._-]+(:\d+)?$/.test(rawHost ?? '') ? rawHost : undefined;
  if (!host) {
    logger.warn('auth failed: invalid host header', { requestId: req.requestId, path: req.originalUrl });
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const url = `${req.protocol}://${host}${req.originalUrl}`;

  // Captured by the key-lookup callback so the verified request can
  // carry its role without a second storage read.
  let resolvedRole: ApiKeyRole | undefined;

  const result = await verifySignedRequest(
    {
      method: req.method,
      url,
      headers: req.headers as Record<string, string | string[]>,
    },
    async (keyId: string) => {
      const key = await apiKeyService.getByKeyId(keyId);
      if (!key) return null;
      resolvedRole = roleOf(key);
      return { secret: key.secret };
    }
  );

  if (!result.verified) {
    logger.warn('auth failed: invalid signature', {
      requestId: req.requestId,
      path: req.originalUrl,
      error: result.error,
      diag: buildAuthDiag(req, url),
    });
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  req.apiKeyId = result.keyId;
  req.apiKeyRole = resolvedRole;

  if (result.keyId) {
    apiKeyService.updateLastUsed(result.keyId).catch(() => {});
  }

  next();
}

/**
 * Gate a route on the calling key's role. Runs after `signatureAuth`,
 * which attaches `req.apiKeyRole`. Member keys get the data plane only;
 * key/invite management stays admin-only so a teammate's leaked key
 * cannot enumerate or revoke other credentials.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.apiKeyRole !== 'admin') {
    logger.warn('authz failed: admin role required', {
      requestId: req.requestId,
      path: req.originalUrl,
      keyId: req.apiKeyId,
      role: req.apiKeyRole,
    });
    res.status(403).json({ error: 'This action needs an admin key' });
    return;
  }
  next();
}

// Redacted snapshot of the inbound request to help diagnose signature
// mismatches. No secrets, no signature bytes — just the derivation
// inputs (method, URL, headers that affect @authority / @path /
// trust-proxy behavior) plus a list of header names so we can spot
// missing/unexpected fields.
function buildAuthDiag(req: Request, reconstructedUrl: string): Record<string, unknown> {
  const sigInputHeader = req.headers['signature-input'];
  const sigInputRaw = Array.isArray(sigInputHeader) ? sigInputHeader[0] : sigInputHeader;

  return {
    method: req.method,
    originalUrl: req.originalUrl,
    reconstructedUrl,
    protocol: req.protocol,
    trustProxy: req.app.get('trust proxy'),
    host: req.get('host'),
    xForwardedHost: req.get('x-forwarded-host'),
    xForwardedProto: req.get('x-forwarded-proto'),
    xForwardedFor: req.get('x-forwarded-for'),
    // The signature-input header carries the fields + params the
    // client signed over. Logging it lets us see the client's view
    // of @authority / @path / created / expires. No secret material.
    signatureInput: typeof sigInputRaw === 'string' ? sigInputRaw : null,
    signaturePresent: typeof req.headers['signature'] === 'string',
    contentDigestPresent: typeof req.headers['content-digest'] === 'string',
    headerNames: Object.keys(req.headers).sort(),
  };
}
