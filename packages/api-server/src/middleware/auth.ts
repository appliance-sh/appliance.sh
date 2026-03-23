import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { verifySignedRequest, computeContentDigest } from '@appliance.sh/sdk';
import { apiKeyService } from '../services/api-key.service';
import { logger } from '../logger';

export async function signatureAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const signature = req.headers['signature'];
  const signatureInput = req.headers['signature-input'];

  if (!signature || !signatureInput) {
    logger.warn('auth failed: missing signature headers', { requestId: req.requestId, path: req.originalUrl });
    res.status(401).json({ error: 'Missing signature headers' });
    return;
  }

  // Verify Content-Digest for requests with body
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

  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

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
    logger.warn('auth failed: invalid signature', { requestId: req.requestId, path: req.originalUrl });
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  req.apiKeyId = result.keyId;

  // Fire-and-forget lastUsed update
  if (result.keyId) {
    apiKeyService.updateLastUsed(result.keyId).catch(() => {});
  }

  next();
}
