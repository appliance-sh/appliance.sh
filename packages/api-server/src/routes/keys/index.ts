import { Router } from 'express';
import { apiKeyInput } from '@appliance.sh/sdk';
import { apiKeyService, roleOf } from '../../services/api-key.service';
import { requireAdmin } from '../../middleware/auth';
import { logger } from '../../logger';

export const keyRoutes: Router = Router();

/**
 * Identify the calling key. Available to every authenticated key — the
 * console uses the role to choose between the member and admin surfaces.
 */
keyRoutes.get('/self', async (req, res) => {
  try {
    if (!req.apiKeyId) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const key = await apiKeyService.getByKeyId(req.apiKeyId);
    if (!key) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }
    res.json({
      id: key.id,
      name: key.name,
      role: roleOf(key),
      createdAt: key.createdAt,
      ...(key.lastUsedAt ? { lastUsedAt: key.lastUsedAt } : {}),
    });
  } catch (error) {
    logger.error('whoami failed', error, { requestId: req.requestId });
    res.status(500).json({ error: 'Failed to read API key' });
  }
});

/** List all keys, secrets stripped. Admin only. */
keyRoutes.get('/', requireAdmin, async (req, res) => {
  try {
    res.json(await apiKeyService.list());
  } catch (error) {
    logger.error('list keys failed', error, { requestId: req.requestId });
    res.status(500).json({ error: 'Failed to list API keys' });
  }
});

/** Mint a named key. Admin only; the secret is returned exactly once. */
keyRoutes.post('/', requireAdmin, async (req, res) => {
  try {
    const input = apiKeyInput.parse(req.body);
    const created = await apiKeyService.create(input.name, input.role ?? 'member');
    // Never log the secret; id + name are safe and useful for audit.
    logger.info('api key created', {
      requestId: req.requestId,
      byKeyId: req.apiKeyId,
      newKeyId: created.id,
      keyName: input.name,
      role: created.role,
    });
    res.status(201).json(created);
  } catch (error) {
    logger.error('create key failed', error, { requestId: req.requestId });
    res.status(400).json({ error: 'Failed to create API key', message: String(error) });
  }
});

/**
 * Revoke a key. Admin only. Refuses to revoke the calling key (rotate
 * exists for that) so an admin can't lock themselves out by revoking
 * the credential they're currently signed with.
 */
keyRoutes.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    if (id === req.apiKeyId) {
      res.status(409).json({ error: 'Cannot revoke the key making this request — rotate it instead' });
      return;
    }
    const existing = await apiKeyService.getByKeyId(id);
    if (!existing) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }
    await apiKeyService.delete(id);
    logger.info('api key revoked', { requestId: req.requestId, byKeyId: req.apiKeyId, revokedKeyId: id });
    res.status(204).end();
  } catch (error) {
    logger.error('revoke key failed', error, { requestId: req.requestId });
    res.status(500).json({ error: 'Failed to revoke API key' });
  }
});

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
