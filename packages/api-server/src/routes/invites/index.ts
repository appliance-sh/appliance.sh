import { Router } from 'express';
import { inviteInput } from '@appliance.sh/sdk';
import { inviteService } from '../../services/invite.service';
import { requireAdmin } from '../../middleware/auth';
import { logger } from '../../logger';

/**
 * Invite management — admin only. Redemption is deliberately NOT here:
 * it lives unauthenticated under /bootstrap/redeem-invite, because the
 * redeeming teammate has no key yet (the token is the credential).
 */
export const inviteRoutes: Router = Router();

inviteRoutes.post('/', requireAdmin, async (req, res) => {
  try {
    const input = inviteInput.parse(req.body);
    const created = await inviteService.create(input);
    // The token is intentionally absent from logs — it is a
    // credential-in-waiting until redeemed or expired.
    logger.info('invite created', {
      requestId: req.requestId,
      byKeyId: req.apiKeyId,
      inviteId: created.id,
      inviteName: created.name,
      role: created.role,
      expiresAt: created.expiresAt,
    });
    res.status(201).json(created);
  } catch (error) {
    logger.error('create invite failed', error, { requestId: req.requestId });
    res.status(400).json({ error: 'Failed to create invite', message: String(error) });
  }
});

inviteRoutes.get('/', requireAdmin, async (req, res) => {
  try {
    res.json(await inviteService.list());
  } catch (error) {
    logger.error('list invites failed', error, { requestId: req.requestId });
    res.status(500).json({ error: 'Failed to list invites' });
  }
});

inviteRoutes.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    await inviteService.delete(id);
    logger.info('invite revoked', { requestId: req.requestId, byKeyId: req.apiKeyId, inviteId: id });
    res.status(204).end();
  } catch (error) {
    logger.error('revoke invite failed', error, { requestId: req.requestId });
    res.status(500).json({ error: 'Failed to revoke invite' });
  }
});
