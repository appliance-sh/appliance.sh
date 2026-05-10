import * as path from 'node:path';
import * as os from 'node:os';
import { runPhase3 } from './phases/phase3';
import { verifyStateBackendUrl, type ClusterRef } from './cluster-verify';
import type { BootstrapEvent } from './types';

export interface StatePromotionInput {
  /**
   * S3 state backend URL the local installer state should move into
   * (e.g. `s3://us-east-1-state-38038a5`). Comes from phase 1's
   * output; the wizard handoff persists this onto the Cluster
   * record so the Settings page can run promotion later.
   */
  stateBackendUrl: string;
  /**
   * AWS profile to use for the S3 access. Mirrors the same field on
   * `BootstrapInput.aws.profile`; omitted means "use whatever creds
   * are already in the shell env."
   */
  awsProfile?: string;
  /**
   * When provided, fetch the cluster's `/api/v1/cluster-info` and
   * assert that `stateBackendUrl` matches what the cluster reports
   * as its canonical state bucket. Recommended for any caller that
   * sourced the URL from less-trusted input (operator paste,
   * persisted config). Skipped silently if cluster-info is
   * unreachable (older api-server) — promotion proceeds with a
   * warning log.
   */
  cluster?: ClusterRef;
}

export interface StatePromotionOptions {
  /**
   * Root cache directory containing the local Pulumi state to
   * promote. Must match the cacheDir used by the bootstrap that
   * produced the local state. Defaults to `~/.appliance`.
   */
  cacheDir?: string;
  onEvent?: (event: BootstrapEvent) => void;
}

/**
 * Run phase 3 (state promotion) standalone. Exposed separately from
 * `runBootstrap` so the desktop Settings page can detach a cluster's
 * state from the operator's machine after the fact, without having
 * to fabricate a full BootstrapInput. The bootstrap wizard still
 * drives phase 3 through `runBootstrap` with `phases: [...]` —
 * this is the post-hoc retry path.
 */
export async function runStatePromotion(
  input: StatePromotionInput,
  options: StatePromotionOptions = {}
): Promise<void> {
  const cacheDir = options.cacheDir ?? path.join(os.homedir(), '.appliance');
  const emit = options.onEvent ?? (() => {});

  // Mirror the engine's per-phase event framing so the UI can reuse
  // the same event handler it uses for bootstrap runs.
  emit({ type: 'phase-started', phase: 'phase3' });
  try {
    await verifyStateBackendUrl(input.stateBackendUrl, input.cluster, (level, message) =>
      emit({ type: 'log', level, message })
    );
    await runPhase3({
      cacheDir,
      stateBackendUrl: input.stateBackendUrl,
      awsProfile: input.awsProfile,
      emit,
    });
    emit({ type: 'phase-completed', phase: 'phase3' });
  } catch (err) {
    emit({ type: 'phase-failed', phase: 'phase3', error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
