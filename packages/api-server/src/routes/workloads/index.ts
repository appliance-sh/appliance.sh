import { Router } from 'express';
import { workloadsService, NonKubernetesBaseError } from '../../services/workloads.service';
import { logger } from '../../logger';

// First query value as a non-empty string, or undefined. Express types
// query values as string | string[] | ParsedQs; we only honor scalars.
function strQuery(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// First query value parsed as a finite number, or undefined.
function numQuery(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** A non-Kubernetes base can't answer workloads/logs — 409, mirroring
 *  the `isKubernetesBase` gate (control-plane.md §2). Returns true when
 *  it handled the error so the caller can stop. */
function answered409(res: import('express').Response, error: unknown): boolean {
  if (error instanceof NonKubernetesBaseError) {
    res.status(409).json({ error: 'Not available on this base', message: error.message });
    return true;
  }
  return false;
}

/** The apiserver's HTTP status off a k8s `ApiException` (`@kubernetes/
 *  client-node` v1 surfaces it as a numeric `.code`), so a read against
 *  a missing pod forwards 404 instead of masking it as a 500. Only an
 *  in-range client/server status [400,599] is honored. */
function k8sStatusCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' && code >= 400 && code <= 599 ? code : undefined;
}

// GET /api/v1/workloads?namespace=<ns>
//
// Namespace-scoped Deployments/Pods/Services snapshot. Defaults to the
// server's configured namespace (`appliance`) when `namespace` is
// omitted. Kubernetes-only (409 elsewhere).
export const workloadsRoutes: Router = Router();

workloadsRoutes.get('/', async (req, res) => {
  try {
    const namespace = strQuery(req.query.namespace);
    const workloads = await workloadsService.listWorkloads(namespace);
    res.json(workloads);
  } catch (error) {
    if (answered409(res, error)) return;
    logger.error('list workloads failed', error, { requestId: req.requestId });
    res.status(500).json({ error: 'Failed to list workloads', message: String(error) });
  }
});

// GET /api/v1/environments/:id/workloads
//
// Workloads filtered to one environment's stack via the
// `app.kubernetes.io/name=<stackName>` label. 404 when the environment
// is unknown; 409 on non-Kubernetes bases.
export const environmentWorkloadsRoutes: Router = Router();

environmentWorkloadsRoutes.get('/:id/workloads', async (req, res) => {
  try {
    const workloads = await workloadsService.listEnvironmentWorkloads(req.params.id);
    if (!workloads) {
      res.status(404).json({ error: 'Environment not found' });
      return;
    }
    res.json(workloads);
  } catch (error) {
    if (answered409(res, error)) return;
    logger.error('list environment workloads failed', error, {
      requestId: req.requestId,
      environmentId: req.params.id,
    });
    res.status(500).json({ error: 'Failed to list environment workloads', message: String(error) });
  }
});

// GET /api/v1/pods/:name/logs?container=&tailLines=200&namespace=&follow=&sinceSeconds=
//
// Snapshot (follow unset): the tail as one `text/plain` body.
// Streaming (follow=1): chunked `text/plain`, the k8s watch piped
// straight to the response until the client aborts. Kubernetes-only.
export const podLogsRoutes: Router = Router();

podLogsRoutes.get('/:name/logs', async (req, res) => {
  const podName = req.params.name;
  try {
    // Gate before touching the response so the 409 body stays JSON
    // (a streaming response would have already set text/plain headers).
    workloadsService.ensureKubernetesBase();

    const container = strQuery(req.query.container);
    const namespace = strQuery(req.query.namespace);
    const tailLines = numQuery(req.query.tailLines) ?? 200;
    const sinceSeconds = numQuery(req.query.sinceSeconds);
    const follow = req.query.follow === '1' || req.query.follow === 'true';

    if (follow) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      // Defeat reverse-proxy buffering so lines arrive promptly.
      res.setHeader('X-Accel-Buffering', 'no');
      // streamPodLogs resolves once k8s returns 200 and piping has
      // started; a bad pod rejects here (before any write) → caught and
      // reported with a real status. Auth was already verified at
      // connection open; the signature's `expires` window gates opening
      // the stream, not its duration (control-plane.md §2).
      const controller = await workloadsService.streamPodLogs(podName, res, {
        container,
        tailLines,
        namespace,
        sinceSeconds,
      });
      // Attach the disconnect → abort handlers BEFORE anything else, then
      // immediately re-check liveness: if the client went away during the
      // kube round-trip above, its 'close' event already fired before
      // these handlers existed, so the guard tears the upstream watch down
      // now instead of leaking it on the open-window race.
      const abort = () => controller.abort();
      req.on('close', abort);
      res.on('close', abort);
      if (req.destroyed || res.destroyed || !res.writable) {
        controller.abort();
        return;
      }
      // Open the 200 stream now even if the pod is quiet, so the client
      // sees an established connection before the first line.
      if (!res.headersSent) res.flushHeaders();
      return;
    }

    const text = await workloadsService.getPodLogs(podName, { container, tailLines, namespace, sinceSeconds });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(text);
  } catch (error) {
    if (answered409(res, error)) return;
    logger.error('get pod logs failed', error, { requestId: req.requestId, podName });
    // A streaming response may have already flushed headers — nothing
    // left to do but end it. Otherwise drop the staged text/plain
    // Content-Type so the JSON error is labelled correctly.
    if (res.headersSent) {
      res.end();
      return;
    }
    res.removeHeader('Content-Type');
    // A missing pod rejects with a k8s ApiException carrying `code: 404`;
    // forward that status rather than masking every upstream error as 500.
    const status = k8sStatusCode(error) ?? 500;
    res.status(status).json({ error: 'Failed to read pod logs', message: String(error) });
  }
});
