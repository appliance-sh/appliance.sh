import { runPhase1 } from '../phases/phase1';
import { runPhase2 } from '../phases/phase2';
import { runPhase3 } from '../phases/phase3';
import type { ApplianceBaseConfig } from '@appliance.sh/sdk';
import type { BootstrapInput, BootstrapOptions, BootstrapPhase, BootstrapResult } from '../types';

/**
 * Workspace engine — imports `@appliance.sh/infra` directly and
 * drives it in-process. Intended for dev + CI where the whole
 * workspace is on disk. Production CLI + Desktop use the download
 * engine, which spawns a pre-built artifact.
 */
export async function runWorkspaceEngine(
  input: BootstrapInput,
  opts: Required<Pick<BootstrapOptions, 'cacheDir'>> & Pick<BootstrapOptions, 'onEvent' | 'phases'>
): Promise<BootstrapResult> {
  const emit = opts.onEvent ?? (() => {});
  const requested: BootstrapPhase[] = opts.phases ?? ['phase1', 'phase2', 'phase3'];
  const runs = (p: BootstrapPhase) => requested.includes(p);

  const result: BootstrapResult = { stateBackendUrl: '' };
  let baseConfig: ApplianceBaseConfig | undefined;

  if (runs('phase1')) {
    emit({ type: 'phase-started', phase: 'phase1' });
    try {
      const out = await runPhase1(input, { cacheDir: opts.cacheDir, emit });
      result.stateBackendUrl = out.stateBackendUrl;
      baseConfig = out.baseConfig;
      emit({ type: 'phase-completed', phase: 'phase1' });
    } catch (err) {
      emit({ type: 'phase-failed', phase: 'phase1', error: formatError(err) });
      throw err;
    }
  } else {
    emit({ type: 'phase-skipped', phase: 'phase1', reason: 'not in opts.phases' });
  }

  if (runs('phase2')) {
    emit({ type: 'phase-started', phase: 'phase2' });
    if (!baseConfig) {
      const err = new Error('phase 2 requires phase 1 to run first (base config unavailable)');
      emit({ type: 'phase-failed', phase: 'phase2', error: err.message });
      throw err;
    }
    try {
      const out = await runPhase2(input, {
        cacheDir: opts.cacheDir,
        baseConfig,
        emit,
      });
      result.apiServerUrl = out.apiServerUrl;
      result.apiKey = out.apiKey;
      emit({ type: 'phase-completed', phase: 'phase2' });
    } catch (err) {
      emit({ type: 'phase-failed', phase: 'phase2', error: formatError(err) });
      throw err;
    }
  } else {
    emit({ type: 'phase-skipped', phase: 'phase2', reason: 'not in opts.phases' });
  }

  if (runs('phase3')) {
    emit({ type: 'phase-started', phase: 'phase3' });
    try {
      await runPhase3({
        cacheDir: opts.cacheDir,
        stateBackendUrl: result.stateBackendUrl,
        awsProfile: input.aws?.profile,
        emit,
      });
      result.statePromoted = true;
      emit({ type: 'phase-completed', phase: 'phase3' });
    } catch (err) {
      emit({ type: 'phase-failed', phase: 'phase3', error: formatError(err) });
      throw err;
    }
  } else {
    emit({ type: 'phase-skipped', phase: 'phase3', reason: 'not in opts.phases' });
  }

  return result;
}

function formatError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

// Stub so the engine selector type-checks. Implementation lands in
// a follow-up commit alongside the release pipeline RFC.
export function runDownloadEngine(_input: BootstrapInput, _opts: BootstrapOptions): Promise<BootstrapResult> {
  throw new Error(
    'download engine is not implemented yet. use engine: "workspace" ' +
      '(the default) until the bootstrapper bundle release pipeline ships.'
  );
}
