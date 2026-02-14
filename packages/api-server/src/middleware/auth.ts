import { Request, Response, NextFunction } from 'express';
import { verifySignedRequest, computeContentDigest } from '@appliance.sh/sdk';
import { apiKeyService } from '../services/api-key.service';

declare module 'express-serve-static-core' {
  interface Request {
    apiKeyId?: string;
    rawBody?: Buffer;
  }
}

export async function signatureAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const signature = req.headers['signature'];
  const signatureInput = req.headers['signature-input'];

  if (!signature || !signatureInput) {
    res.status(401).json({ error: 'Missing signature headers' });
    return;
  }

  // Verify Content-Digest for requests with body
  if (req.rawBody && req.rawBody.length > 0) {
    const contentDigest = req.headers['content-digest'] as string | undefined;
    if (!contentDigest) {
      res.status(401).json({ error: 'Missing Content-Digest header' });
      return;
    }

    const expected = computeContentDigest(req.rawBody.toString());
    if (contentDigest !== expected) {
      res.status(401).json({ error: 'Content-Digest mismatch' });
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
      return { secret: key.rawSecret };
    }
  );

  if (!result.verified) {
    res.status(401).json({ error: 'Invalid signature', message: result.error });
    return;
  }

  req.apiKeyId = result.keyId;

  // Fire-and-forget lastUsed update
  if (result.keyId) {
    apiKeyService.updateLastUsed(result.keyId).catch(() => {});
  }

  next();
}
