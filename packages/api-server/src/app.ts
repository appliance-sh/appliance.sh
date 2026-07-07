import express, { type Express } from 'express';
import type { Server } from 'node:http';
import { indexRoutes } from './routes';

import { projectRoutes } from './routes/projects';
import { environmentRoutes } from './routes/environments';
import { deploymentRoutes } from './routes/deployments';
import { buildRoutes } from './routes/builds';
import { buildContentRoutes } from './routes/builds/content';
import { bootstrapRoutes } from './routes/bootstrap';
import { keyRoutes } from './routes/keys';
import { inviteRoutes } from './routes/invites';
import { clusterInfoRoutes } from './routes/cluster-info';
import { workloadsRoutes, environmentWorkloadsRoutes, podLogsRoutes } from './routes/workloads';
import { internalRoutes } from './routes/internal';
import { signatureAuth } from './middleware/auth';
import { corsMiddleware } from './middleware/cors';
import { mountConsole } from './console-static';
import { requestLogger, logger } from './logger';

// The api-server as a library. `main.ts` remains the container/CLI
// entrypoint (`node dist/src/main.js`); this module carries the app
// factory + a `startServer()` the appliance CLI embeds to run the
// SAME control plane as a host-local daemon (`appliance server start`)
// — one binary, orchestrating the cloud and the laptop alike. All
// configuration stays env-driven (APPLIANCE_BASE_CONFIG, PORT, HOST,
// BOOTSTRAP_TOKEN, ...) so the embedded and containerized servers
// can't drift.

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
  app.use(corsMiddleware);

  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    })
  );

  // Web console (SPA) — served same-origin when a bundle is staged, so
  // the api-server's URL is the link teammates open. Registered before
  // the API routers; its fallback next()s anything under /api, /bootstrap
  // or the health probes, so the JSON surface is unaffected.
  if (mode === 'server') {
    mountConsole(app);
  }

  // Health check is available in both modes
  app.use('/', indexRoutes);

  if (mode === 'server') {
    app.use('/bootstrap', bootstrapRoutes);
    app.use('/api/v1/projects', signatureAuth, projectRoutes);
    app.use('/api/v1/projects/:projectId/environments', signatureAuth, environmentRoutes);
    app.use('/api/v1/deployments', signatureAuth, deploymentRoutes);
    app.use('/api/v1/keys', signatureAuth, keyRoutes);
    app.use('/api/v1/invites', signatureAuth, inviteRoutes);
    // Content PUTs authenticate with the one-time token minted at
    // build creation (the self-hosted analogue of a presigned S3 URL),
    // so they mount ahead of the signed router; anything the content
    // router doesn't match falls through to the signed routes below.
    app.use('/api/v1/builds', buildContentRoutes);
    app.use('/api/v1/builds', signatureAuth, buildRoutes);
    app.use('/api/v1/cluster-info', signatureAuth, clusterInfoRoutes);
    // Runtime workloads + container logs (container-runtime bases only;
    // 409 elsewhere).
    app.use('/api/v1/workloads', signatureAuth, workloadsRoutes);
    app.use('/api/v1/environments', signatureAuth, environmentWorkloadsRoutes);
    app.use('/api/v1/pods', signatureAuth, podLogsRoutes);
  } else {
    // Worker internal routes reuse the data-plane signatureAuth: the
    // server re-signs each dispatch with the ORIGINAL caller's API key,
    // so the worker verifies against the same shared api-key store.
    app.use('/api/internal', signatureAuth, internalRoutes);
  }

  return app;
}

/**
 * Start the api-server on PORT/HOST from the environment. Returns the
 * listening `http.Server` so an embedding process (the appliance CLI's
 * `appliance server start`) can close it or wire shutdown signals.
 */
export function startServer(): Server {
  const mode = getMode();
  const app = createApp(mode);
  const port = process.env.PORT ?? 3000;
  // Bind explicitly to 0.0.0.0 so Docker's IPv4 port forward
  // (host 127.0.0.1:NNNN -> container :3000) reaches us. Without
  // a host, Node listens on `::` only, which the forward can't
  // connect to in containers without dual-stack mapping.
  const host = process.env.HOST ?? '0.0.0.0';

  return app.listen(Number(port), host, () => {
    logger.info('server started', { host, port: Number(port), mode });
  });
}
