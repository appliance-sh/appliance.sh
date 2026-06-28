import { Router } from 'express';

export const indexRoutes: Router = Router();

indexRoutes.get('/', (_req, res) => {
  res.send('Hello World!');
});

// Unauthenticated liveness probe. The desktop's "cluster ready" badge
// resolves this as a base-URL HTTP check instead of a kubectl
// reachability shell-out (control-plane.md §2). Liveness only — no
// cluster/state access, available in every mode — so it must never
// require a signature. (The signed GET /api/v1/cluster-info carries the
// richer status when more than reachability is needed.)
indexRoutes.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});
