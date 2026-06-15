// Small helpers for shelling out to `docker build` across the CLI's
// container/image paths.

import { execFileSync } from 'node:child_process';

let provenanceSupported: boolean | undefined;

/**
 * `--provenance` is a BuildKit/buildx flag. Docker Desktop makes buildx
 * the default builder, so `docker build --provenance=false` works there.
 * Colima (and any plain legacy-builder setup) rejects it outright with
 * `unknown flag: --provenance`, which kills the build. Probe support once
 * via `docker build --help` so a fresh Colima install can still deploy.
 */
export function dockerBuildSupportsProvenance(): boolean {
  if (provenanceSupported === undefined) {
    try {
      const help = execFileSync('docker', ['build', '--help'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      provenanceSupported = help.includes('--provenance');
    } catch {
      provenanceSupported = false;
    }
  }
  return provenanceSupported;
}

/**
 * `['--provenance=false']` when the active builder accepts it, else `[]`.
 * Spread into a `docker build` argv to pin reproducible output on buildx
 * without breaking the legacy builder.
 */
export function provenanceArgs(): string[] {
  return dockerBuildSupportsProvenance() ? ['--provenance=false'] : [];
}
