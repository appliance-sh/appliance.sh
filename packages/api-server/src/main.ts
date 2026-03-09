import express from 'express';
import { indexRoutes } from './routes';
import { infraRoutes } from './routes/infra';
import { projectRoutes } from './routes/projects';
import { environmentRoutes } from './routes/environments';
import { deploymentRoutes } from './routes/deployments';
import { bootstrapRoutes } from './routes/bootstrap';
import { signatureAuth } from './middleware/auth';

export function createApp() {
  const app = express();

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
  app.use('/api/v1/infra', signatureAuth, infraRoutes);

  return app;
}

async function bootstrap() {
  const app = createApp();
  const port = process.env.PORT ?? 3000;

  app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
  });
}

bootstrap();
