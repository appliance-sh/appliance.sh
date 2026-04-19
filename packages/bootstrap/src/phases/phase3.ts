import type { BootstrapEvent } from '../types';

export interface Phase3Options {
  cacheDir: string;
  stateBackendUrl: string;
  emit: (event: BootstrapEvent) => void;
}

/**
 * Phase 3: migrate the installer stack's state from the local file
 * backend to the S3 state bucket the base provisioned.
 *
 * Steps when implemented:
 *   1. `exportStack` against the local-backend workspace to get a
 *      Pulumi.Deployment payload.
 *   2. `createStack` on a fresh workspace pointed at
 *      `PULUMI_BACKEND_URL=<stateBackendUrl>` (same projectName +
 *      stackName so the S3 backend has a matching slot).
 *   3. `importStack` the deployment payload into the S3 backend.
 *   4. Run `preview` against the S3-backed stack to verify parity
 *      (all resources `same`, zero `create`/`replace`).
 *   5. Rename the local state dir to `pulumi-state.bak-<timestamp>`
 *      — archive, not delete, so phase 3 stays reversible while
 *      still taking the local backend out of service.
 *   6. Update `~/.appliance/config.json` so future runs target the
 *      S3 backend by default.
 */
export async function runPhase3(_opts: Phase3Options): Promise<void> {
  throw new Error(
    'phase 3 is not implemented yet. depends on: Automation API ' +
      'exportStack/importStack for a backend-to-backend migration, plus ' +
      'a preview-check against the new backend before archiving the local one.'
  );
}
