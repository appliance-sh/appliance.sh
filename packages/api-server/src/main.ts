import express from 'express';
import { indexRoutes } from './routes';
import { infraRoutes } from './routes/infra';

export function createApp() {
  const app = express();

  app.use(express.json());

  // Set up routes
  app.use('/', indexRoutes);
  app.use('/infra', infraRoutes);

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
