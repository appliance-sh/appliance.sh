// Container/CLI entrypoint: `node dist/src/main.js`. All the app
// wiring lives in `app.ts`, which the appliance CLI also imports to
// embed the same server as a host-local daemon.
import { startServer } from './app';

export { createApp, startServer, type ApplianceMode } from './app';

startServer();
