import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { verifySignedRequest, computeContentDigest } from '@appliance.sh/sdk';
import { apiKeyService } from '../services/api-key.service';
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

    const expected = computeContentDigest(req.rawBody.toString());
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

  const result = await verifySignedRequest(
    {
      method: req.method,
      url,
      headers: req.headers as Record<string, string | string[]>,
    },
    async (keyId: string) => {
      const key = await apiKeyService.getByKeyId(keyId);
      if (!key) return null;
      return { secret: key.secret };
    }
  );

  if (!result.verified) {
    logger.warn('auth failed: invalid signature', {
      requestId: req.requestId,
      path: req.originalUrl,
      error: result.error,
    });
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  req.apiKeyId = result.keyId;

  if (result.keyId) {
    apiKeyService.updateLastUsed(result.keyId).catch(() => {});
  }

  next();
}
