import { Router } from 'express';
import { apiKeyService } from '../../services/api-key.service';
import { logger } from '../../logger';

export const keyRoutes: Router = Router();

/**
 * Rotate the *calling* key. Authenticated via the same RFC 9421
 * signature middleware as every other data-plane route, so the caller
 * proves possession of the key it's asking to rotate — there is no way
 * to rotate someone else's key. Mints a replacement (inheriting the old
 * key's name) and revokes the old one; the old secret stops verifying
 * immediately after this returns.
 *
 * Self-rotation only (no `keyId` in the path) keeps the blast radius
 * minimal: a stolen key can rotate *itself* (which an operator
 * detects), but cannot enumerate or revoke other keys.
 */
keyRoutes.post('/rotate', async (req, res) => {
  try {
    // signatureAuth populates req.apiKeyId for every verified request.
    if (!req.apiKeyId) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const rotated = await apiKeyService.rotate(req.apiKeyId);
    if (!rotated) {
      // The signature verified but the key vanished between auth and
      // here (concurrent rotate/delete). Treat as gone.
      res.status(404).json({ error: 'API key not found' });
      return;
    }
    // Never log the new secret; the id is safe and useful for audit.
    logger.info('api key rotated', {
      requestId: req.requestId,
      previousKeyId: req.apiKeyId,
      newKeyId: rotated.id,
    });
    res.status(201).json(rotated);
  } catch (error) {
    logger.error('rotate key failed', error, { requestId: req.requestId });
    res.status(500).json({ error: 'Failed to rotate API key' });
  }
});
