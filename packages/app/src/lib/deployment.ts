// Shared deployment helpers used by multiple pages.
//
// URL bookkeeping in the platform:
//   * The canonical "where is this thing reachable" address lives on
//     the *Environment* — `env.url`. A deployment is a change applied
//     to an environment; the URL is a property of the environment.
//   * Older environments (pre-`url`-field) won't have one set yet.
//     Helpers in this file fall back to scraping the URL out of the
//     most recent successful deployment's `message` so UI continues
//     to work against legacy data without requiring a manual migration.

import type { Deployment, Environment } from '@appliance.sh/sdk/models';

/**
 * Pull a URL out of a deployment's `message` string. Today only the
 * local runtime executor embeds URLs as `URL: http://localhost:30039`;
 * cloud deploys don't surface their endpoint URL on the Deployment
 * record yet, so this returns null for them. UI callers should treat
 * the URL as best-effort and degrade to a "no URL recorded" message
 * when null.
 */
export function extractDeploymentUrl(message: string | null | undefined): string | null {
  if (!message) return null;
  const match = message.match(/URL:\s*(\S+)/i);
  if (!match) return null;
  const candidate = match[1].trim();
  if (!/^https?:\/\//i.test(candidate)) return null;
  return candidate;
}

/**
 * Find the most recent successful deploy in a list. Used to surface
 * the "current" URL on the environment page even after a failed
 * follow-up deploy. Returns the deployment record or null when none
 * have succeeded yet.
 */
export function findLatestSuccessfulDeploy(deployments: Deployment[] | undefined): Deployment | null {
  if (!deployments) return null;
  for (const d of deployments) {
    if (d.action === 'deploy' && d.status === 'succeeded') return d;
  }
  return null;
}

/**
 * Build a map of environmentId → URL by scanning a deployment list
 * for the most recent successful deploy per environment. The list is
 * expected to be sorted newest-first (the SDK returns it that way);
 * the first successful entry per env wins. Environments without a
 * URL on their latest success are omitted from the map.
 *
 * Cheap: one pass, no extra fetches — callers can use a single
 * `listDeployments({ projectId })` to drive URL chips for every env
 * in a project. This is the *fallback* path for environments that
 * predate `env.url`; new code should prefer reading `env.url` and
 * merge the two sources via {@link urlForEnvironment} below.
 */
export function urlsByEnvironment(deployments: Deployment[] | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!deployments) return result;
  for (const d of deployments) {
    if (d.action !== 'deploy' || d.status !== 'succeeded') continue;
    if (result.has(d.environmentId)) continue;
    const url = extractDeploymentUrl(d.message);
    if (url) result.set(d.environmentId, url);
  }
  return result;
}

/**
 * Resolve the URL to show for an environment, preferring the canonical
 * `env.url` and falling back to scanning the deployment list. Pass
 * `deployments` from a query keyed by environmentId or projectId.
 */
export function urlForEnvironment(env: Environment | undefined, deployments?: Deployment[]): string | null {
  if (env?.url) return env.url;
  const latest = findLatestSuccessfulDeploy(deployments);
  return extractDeploymentUrl(latest?.message);
}

/**
 * Merge env.url (canonical) with the deployment-scan fallback into a
 * single envId → url map. Pass the project's envs + a flat list of its
 * deployments; each env's own `url` field wins, with the deployment
 * scan filling gaps for environments that predate the field.
 */
export function urlMapForEnvironments(
  envs: Environment[] | undefined,
  deployments?: Deployment[]
): Map<string, string> {
  const fromDeployments = urlsByEnvironment(deployments);
  const result = new Map<string, string>();
  for (const env of envs ?? []) {
    const url = env.url ?? fromDeployments.get(env.id);
    if (url) result.set(env.id, url);
  }
  return result;
}
