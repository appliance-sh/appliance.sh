import { Router } from 'express';
import { applianceBaseConfig, VERSION, type ApplianceBaseConfig } from '@appliance.sh/sdk';
import { logger } from '../../logger';

export interface ClusterInfo {
  /**
   * The api-server's running version (the SDK's pinned VERSION at
   * the time this image was built). Surfaced so the desktop Settings
   * page can compare against the bundled bootstrapper version and
   * offer a self-update. Older deployments that predate this field
   * will simply 404 / 500 the route — callers should treat that as
   * "version unknown" and allow updating regardless.
   */
  version: string;
  baseConfig: ApplianceBaseConfig;
}

export const clusterInfoRoutes: Router = Router();

clusterInfoRoutes.get('/', async (req, res) => {
  try {
    const raw = process.env.APPLIANCE_BASE_CONFIG;
    if (!raw) {
      res.status(500).json({ error: 'APPLIANCE_BASE_CONFIG is not set' });
      return;
    }
    const baseConfig = applianceBaseConfig.parse(JSON.parse(raw));
    const body: ClusterInfo = { version: VERSION, baseConfig };
    res.json(body);
  } catch (error) {
    logger.error('get cluster-info failed', error, { requestId: req.requestId });
    res.status(500).json({ error: 'Failed to read cluster info', message: String(error) });
  }
});
