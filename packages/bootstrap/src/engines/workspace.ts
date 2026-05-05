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
  opts: Required<Pick<BootstrapOptions, 'cacheDir'>> & Pick<BootstrapOptions, 'onEvent' | 'phases' | 'prior'>
): Promise<BootstrapResult> {
  const emit = opts.onEvent ?? (() => {});
  const requested: BootstrapPhase[] = opts.phases ?? ['phase1', 'phase2', 'phase3'];
  const runs = (p: BootstrapPhase) => requested.includes(p);

  const result: BootstrapResult = {
    stateBackendUrl: opts.prior?.phase1?.stateBackendUrl ?? '',
    apiServerUrl: opts.prior?.phase2?.apiServerUrl,
    apiKey: opts.prior?.phase2?.apiKey,
  };
  let baseConfig: ApplianceBaseConfig | undefined = opts.prior?.phase1?.baseConfig;

  if (runs('phase1')) {
    emit({ type: 'phase-started', phase: 'phase1' });
    try {
      const out = await runPhase1(input, { cacheDir: opts.cacheDir, emit });
      result.stateBackendUrl = out.stateBackendUrl;
      baseConfig = out.baseConfig;
      emit({ type: 'phase-output', phase: 'phase1', output: out });
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
      const err = new Error(
        'phase 2 requires phase 1 to run first, or its outputs supplied via opts.prior.phase1 (base config unavailable)'
      );
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
      emit({ type: 'phase-output', phase: 'phase2', output: out });
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
    if (!result.stateBackendUrl) {
      const err = new Error(
        'phase 3 requires phase 1 to run first, or its outputs supplied via opts.prior.phase1 (state backend url unavailable)'
      );
      emit({ type: 'phase-failed', phase: 'phase3', error: err.message });
      throw err;
    }
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
