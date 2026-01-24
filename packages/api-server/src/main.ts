import express from 'express';
import { indexRoutes } from './routes';
import { infraRoutes } from './routes/infra';
import { projectRoutes } from './routes/projects';
import { environmentRoutes } from './routes/environments';
import { deploymentRoutes } from './routes/deployments';

export function createApp() {
  const app = express();

  app.use(express.json());

  // Set up routes
  app.use('/', indexRoutes);
  app.use('/infra', infraRoutes);
  app.use('/projects', projectRoutes);
  app.use('/projects/:projectId/environments', environmentRoutes);
  app.use('/deployments', deploymentRoutes);

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
