import express, { type Express } from 'express';
import { indexRoutes } from './routes';

import { projectRoutes } from './routes/projects';
import { environmentRoutes } from './routes/environments';
import { deploymentRoutes } from './routes/deployments';
import { buildRoutes } from './routes/builds';
import { bootstrapRoutes } from './routes/bootstrap';
import { internalRoutes } from './routes/internal';
import { signatureAuth } from './middleware/auth';
import { requestLogger, logger } from './logger';

export type ApplianceMode = 'server' | 'worker';

function getMode(): ApplianceMode {
  const raw = process.env.APPLIANCE_MODE ?? 'server';
  if (raw !== 'server' && raw !== 'worker') {
    throw new Error(`Invalid APPLIANCE_MODE: ${raw} (must be 'server' or 'worker')`);
  }
  return raw;
}

export function createApp(mode: ApplianceMode = getMode()): Express {
  const app = express();

  if (process.env.APPLIANCE_TRUST_PROXY) {
    app.set('trust proxy', true);
  }

  app.use(requestLogger);

  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    })
  );

  // Health check is available in both modes
  app.use('/', indexRoutes);

  if (mode === 'server') {
    app.use('/bootstrap', bootstrapRoutes);
    app.use('/api/v1/projects', signatureAuth, projectRoutes);
    app.use('/api/v1/projects/:projectId/environments', signatureAuth, environmentRoutes);
    app.use('/api/v1/deployments', signatureAuth, deploymentRoutes);
    app.use('/api/v1/builds', signatureAuth, buildRoutes);
  } else {
    // Worker internal routes reuse the data-plane signatureAuth: the
    // server re-signs each dispatch with the ORIGINAL caller's API key,
    // so the worker verifies against the same shared api-key store.
    app.use('/api/internal', signatureAuth, internalRoutes);
  }

  return app;
}

async function bootstrap() {
  const mode = getMode();
  const app = createApp(mode);
  const port = process.env.PORT ?? 3000;

  app.listen(port, () => {
    logger.info('server started', { port: Number(port), mode });
  });
}

bootstrap();
