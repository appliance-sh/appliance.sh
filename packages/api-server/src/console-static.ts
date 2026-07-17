import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { logger } from './logger';

/**
 * Serve the web console (the @appliance.sh/console SPA) from this
 * api-server, so a running server IS the URL a teammate opens — no
 * separately-hosted console, no CORS setup, no URL to paste (the
 * console derives the API base from window.location.origin via the
 * injected __APPLIANCE_CONFIG__).
 *
 * The bundle location is resolved at startup:
 *   1. APPLIANCE_CONSOLE_DIR (explicit override)
 *   2. <package root>/console-dist — where the Docker image and
 *      docker-prep.sh stage the built console.
 * When no bundle is found the server still runs API-only (the CLI,
 * desktop app, and dev consoles talk to it the same as before);
 * a hint is logged so operators know why / isn't a web page.
 *
 * Hardened deployments can scope or disable the built-in console via
 * APPLIANCE_CONSOLE_MODE:
 *   - `full` (default): the complete console.
 *   - `bootstrap`: the built-in console only handles onboarding —
 *     invite redemption and connect — and points users at the
 *     separately-hosted console named by APPLIANCE_CONSOLE_URL for
 *     everything else. Use this when the day-to-day console is
 *     deployed behind extra controls (VPN, SSO proxy, WAF).
 *   - `off`: serve no console at all (API-only), even when a bundle
 *     is staged.
 * The mode is enforced in the API's authorization (key roles), not
 * just hidden in the UI; the console mode governs what this origin
 * serves and where invite links send people.
 */

export type ConsoleMode = 'full' | 'bootstrap' | 'off';

export function getConsoleMode(): ConsoleMode {
  const raw = process.env.APPLIANCE_CONSOLE_MODE ?? 'full';
  if (raw !== 'full' && raw !== 'bootstrap' && raw !== 'off') {
    throw new Error(`Invalid APPLIANCE_CONSOLE_MODE: ${raw} (must be 'full', 'bootstrap' or 'off')`);
  }
  return raw;
}

/**
 * Canonical console URL for this cluster: where invite links point and
 * where a bootstrap-only console sends people after setup. Defaults to
 * same-origin (the built-in console). Set APPLIANCE_CONSOLE_URL when
 * the real console is hosted elsewhere; that origin is automatically
 * CORS-allowed (see middleware/cors.ts).
 */
export function getExternalConsoleUrl(): string | null {
  const raw = process.env.APPLIANCE_CONSOLE_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/$/, '');
}
export function resolveConsoleDir(): string | null {
  const candidates = [
    process.env.APPLIANCE_CONSOLE_DIR,
    // dist/main.js (Docker build: rootDir = src)
    path.resolve(__dirname, '..', 'console-dist'),
    // dist/src/main.js (local build: vitest configs widen rootDir)
    path.resolve(__dirname, '..', '..', 'console-dist'),
  ].filter((p): p is string => Boolean(p));

  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return null;
}

const API_PREFIXES = ['/api/', '/bootstrap', '/healthz', '/livez', '/readyz'];

export function mountConsole(
  app: Express,
  consoleDir: string | null = resolveConsoleDir(),
  mode: ConsoleMode = getConsoleMode()
): void {
  if (mode === 'off') {
    logger.info('web console disabled (APPLIANCE_CONSOLE_MODE=off) — serving API only');
    return;
  }
  if (!consoleDir) {
    logger.info('web console bundle not found — serving API only', {
      hint: 'set APPLIANCE_CONSOLE_DIR or stage console-dist next to the api-server package',
    });
    return;
  }

  // The SPA entry gets the runtime config injected so the console knows
  // to talk to the origin it was loaded from, which surface to render
  // (full vs. bootstrap-only), and where the canonical console lives.
  // Read once at startup — the bundle is immutable for the life of the
  // process.
  const config = {
    consoleMode: mode,
    ...(getExternalConsoleUrl() ? { consoleUrl: getExternalConsoleUrl() } : {}),
  };
  const indexHtml = readFileSync(path.join(consoleDir, 'index.html'), 'utf8').replace(
    '</head>',
    `<script>window.__APPLIANCE_CONFIG__=Object.assign({apiServerUrl:window.location.origin},${JSON.stringify(config)});</script></head>`
  );

  const sendIndex = (res: Response) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    // The entry must revalidate so deploys take effect; hashed assets
    // below stay cacheable.
    res.set('Cache-Control', 'no-cache');
    res.send(indexHtml);
  };

  // Hashed Vite assets are content-addressed — cache hard.
  app.use(
    express.static(consoleDir, {
      index: false,
      maxAge: '1y',
      immutable: true,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );

  // SPA fallback: any GET that isn't an API route or a real file gets
  // the app shell, so deep links like /projects/abc work on reload.
  app.get('/{*splat}', (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET') return next();
    if (API_PREFIXES.some((p) => req.path === p.replace(/\/$/, '') || req.path.startsWith(p))) return next();
    // Asset-like misses (has an extension) should 404, not render HTML.
    if (path.extname(req.path) !== '') return next();
    sendIndex(res);
  });

  logger.info('web console mounted', { consoleDir, mode });
}
