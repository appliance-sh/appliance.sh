// Look up the latest semver-shaped tag for an image hosted on
// ghcr.io. Used by the desktop Settings page to default the
// "target version" field of the api-server self-update flow.
//
// We talk Docker Registry v2 directly (anonymous bearer token) rather
// than going through the GitHub Packages REST API because the
// registry endpoints don't require a personal access token for public
// packages — they hand out short-lived pull tokens to anyone.

const TOKEN_ENDPOINT = 'https://ghcr.io/token';
const REGISTRY_ENDPOINT = 'https://ghcr.io/v2';

const SEMVER_TAG = /^\d+\.\d+\.\d+$/;

export interface LatestGhcrTagInput {
  /**
   * Image path within ghcr.io (e.g. `appliance-sh/api-server`). No
   * leading slash, no host, no tag. Defaults to the api-server image
   * if omitted.
   */
  image?: string;
}

const DEFAULT_IMAGE = 'appliance-sh/api-server';

/**
 * Resolve the highest-semver tag (matching `\d+.\d+.\d+`) for the
 * given ghcr.io image. Returns the bare version string (no `v`
 * prefix). Throws if the registry can't be reached, the package is
 * private, or no semver-shaped tags exist (only `latest`, branch
 * names, etc.).
 */
export async function latestGhcrTag(input: LatestGhcrTagInput = {}): Promise<string> {
  const image = input.image ?? DEFAULT_IMAGE;

  const tokenRes = await fetch(`${TOKEN_ENDPOINT}?scope=repository:${image}:pull`);
  if (!tokenRes.ok) {
    throw new Error(`ghcr token endpoint returned ${tokenRes.status}: ${await safeText(tokenRes)}`);
  }
  const tokenBody = (await tokenRes.json()) as { token?: string };
  if (!tokenBody.token) {
    throw new Error('ghcr token endpoint returned no token field');
  }

  const tagsRes = await fetch(`${REGISTRY_ENDPOINT}/${image}/tags/list`, {
    headers: { Authorization: `Bearer ${tokenBody.token}` },
  });
  if (!tagsRes.ok) {
    throw new Error(`ghcr tags/list returned ${tagsRes.status}: ${await safeText(tagsRes)}`);
  }
  const body = (await tagsRes.json()) as { tags?: string[] };
  const tags = Array.isArray(body.tags) ? body.tags : [];
  const semver = tags.filter((t) => SEMVER_TAG.test(t));
  if (semver.length === 0) {
    throw new Error(`no semver-shaped tags on ghcr.io/${image} (got: ${tags.slice(0, 5).join(', ') || 'none'})`);
  }
  semver.sort(compareSemverDesc);
  return semver[0]!;
}

function compareSemverDesc(a: string, b: string): number {
  const ax = a.split('.').map(Number);
  const bx = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const da = ax[i] ?? 0;
    const db = bx[i] ?? 0;
    if (da !== db) return db - da;
  }
  return 0;
}

async function safeText(r: Response): Promise<string> {
  try {
    return (await r.text()).slice(0, 200);
  } catch {
    return '<no body>';
  }
}
