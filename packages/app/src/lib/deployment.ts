// Shared deployment helpers used by multiple pages.

import type { Deployment } from '@appliance.sh/sdk/models';

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
 * in a project.
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
