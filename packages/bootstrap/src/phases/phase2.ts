import type { BootstrapEvent, BootstrapInput } from '../types';

export interface Phase2Options {
  cacheDir: string;
  stateBackendUrl: string;
  emit: (event: BootstrapEvent) => void;
}

export interface Phase2Output {
  apiServerUrl: string;
  apiKey: { id: string; secret: string };
}

/**
 * Phase 2: hoist api-server into the installer stack.
 *
 * Steps when implemented:
 *   1. Resolve the pinned api-server OCI tarball from the bootstrapper
 *      bundle (or a bundled asset in workspace mode).
 *   2. `crane push` the image to the base's ECR repo using the user's
 *      AWS creds → get back the pushed digest.
 *   3. Generate a random bootstrap token (32 bytes, base64).
 *   4. Re-run `stack.up()` against the same stack with
 *      `enableApiServer: true`, `apiServerImageUri` and
 *      `bootstrapToken` set. Pulumi adds the Lambda + FURL + IAM
 *      alongside the already-deployed base.
 *   5. Read `apiServerUrl` from outputs; poll `/bootstrap/status`
 *      until healthy.
 *   6. POST `/bootstrap/create-key` with `X-Bootstrap-Token` → first
 *      API key. Return it to the driver for keychain storage.
 */
export async function runPhase2(_input: BootstrapInput, _opts: Phase2Options): Promise<Phase2Output> {
  throw new Error(
    'phase 2 is not implemented yet. depends on: (a) crane binary + bundled ' +
      'api-server OCI tarball from the bootstrapper bundle; (b) a pulumi up ' +
      'step with enableApiServer=true; (c) an http client for /bootstrap/create-key.'
  );
}
