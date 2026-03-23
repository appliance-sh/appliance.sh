import express, { type Express } from 'express';
import { indexRoutes } from './routes';

import { projectRoutes } from './routes/projects';
import { environmentRoutes } from './routes/environments';
import { deploymentRoutes } from './routes/deployments';
import { buildRoutes } from './routes/builds';
import { bootstrapRoutes } from './routes/bootstrap';
import { signatureAuth } from './middleware/auth';
import { requestLogger, logger } from './logger';

export function createApp(): Express {
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

  // Unauthenticated routes
  app.use('/', indexRoutes);
  app.use('/bootstrap', bootstrapRoutes);

  // Authenticated routes
  app.use('/api/v1/projects', signatureAuth, projectRoutes);
  app.use('/api/v1/projects/:projectId/environments', signatureAuth, environmentRoutes);
  app.use('/api/v1/deployments', signatureAuth, deploymentRoutes);
  app.use('/api/v1/builds', signatureAuth, buildRoutes);

  return app;
}

async function bootstrap() {
  const app = createApp();
  const port = process.env.PORT ?? 3000;

  app.listen(port, () => {
    logger.info('server started', { port: Number(port) });
  });
}

bootstrap();
