import { Router } from 'express';
import { applianceBaseConfig, VERSION, type ApplianceBaseConfig } from '@appliance.sh/sdk';
import { getConsoleMode, getExternalConsoleUrl, type ConsoleMode } from '../../console-static';
import { supportsUploadBuilds } from '../../services/build-upload.service';
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
  /**
   * How this server exposes its web console (`full` | `bootstrap` |
   * `off`), and where the canonical console lives when it is hosted
   * separately. Clients building invite links use `consoleUrl` (falling
   * back to the api-server URL) so teammates land on the console the
   * operator intends. Absent on older servers — treat as full/same-origin.
   */
  consoleMode?: ConsoleMode;
  consoleUrl?: string;
  /**
   * The server's own version, under the name the desktop's capability
   * probe reads (same value as `version`, which predates it). Absent
   * on older servers — clients must tolerate omission.
   */
  serverVersion: string;
  /**
   * What this base can do, so clients can warn up front instead of
   * discovering it via a failed request. `uploadBuilds`: whether
   * upload-flow (source zip) builds can run here — mirrors the gates
   * POST /api/v1/builds enforces (409 when they fail). Absent on
   * older servers.
   */
  capabilities: { uploadBuilds: boolean };
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
    const externalUrl = getExternalConsoleUrl();
    const body: ClusterInfo = {
      version: VERSION,
      baseConfig,
      consoleMode: getConsoleMode(),
      ...(externalUrl ? { consoleUrl: externalUrl } : {}),
      serverVersion: VERSION,
      capabilities: { uploadBuilds: supportsUploadBuilds(baseConfig) },
    };
    res.json(body);
  } catch (error) {
    logger.error('get cluster-info failed', error, { requestId: req.requestId });
    res.status(500).json({ error: 'Failed to read cluster info', message: String(error) });
  }
});
