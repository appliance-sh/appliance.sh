import { createContext } from './context.js';
import { defaultProviders, findProvider } from './registry.js';
import type { CheckResult, Context, Provider, ProgressEvent } from './types.js';

export interface StatusEntry {
  provider: Provider;
  check: CheckResult;
}

/**
 * Probe every registered provider in parallel. Used by both
 * `appliance local status` and the desktop preflight panel.
 */
export async function runStatus(ctx?: Context): Promise<StatusEntry[]> {
  const effective = ctx ?? createContext();
  return Promise.all(
    defaultProviders.map(async (provider) => ({
      provider,
      check: await provider.check(effective),
    }))
  );
}

export interface InstallOutcome {
  provider: Provider;
  /**
   * - `installed`  : auto-install succeeded
   * - `already`    : tool was already on PATH; nothing to do
   * - `guidance`   : auto-install isn't supported; manual instructions returned
   * - `failed`     : auto-install ran but threw — message has the reason
   */
  status: 'installed' | 'already' | 'guidance' | 'failed';
  message: string;
}

export interface InstallOptions {
  /** Provider names to target. Defaults to every required provider. */
  tools?: string[];
  /** Re-install even when already present (used by `update`). */
  force?: boolean;
  onProgress?: (event: ProgressEvent) => void;
}

/**
 * Drive installs for the requested tools (or all required tools when
 * `tools` is omitted). Returns a per-provider outcome instead of
 * throwing so callers can render a complete summary even when one
 * tool errors out mid-batch.
 */
export async function runInstall(opts: InstallOptions = {}): Promise<InstallOutcome[]> {
  const ctx = createContext({ onProgress: opts.onProgress });
  const targets = resolveTargets(opts.tools);
  const outcomes: InstallOutcome[] = [];

  for (const provider of targets) {
    const check = await provider.check(ctx);
    if (check.installed && !opts.force) {
      outcomes.push({
        provider,
        status: 'already',
        message: `Already installed (${check.version ?? 'version unknown'})`,
      });
      continue;
    }
    if (!provider.autoInstallable || !provider.install) {
      const manual = provider.manualInstall(ctx);
      outcomes.push({
        provider,
        status: 'guidance',
        message: manual.instructions,
      });
      continue;
    }
    try {
      await provider.install(ctx);
      const post = await provider.check(ctx);
      outcomes.push({
        provider,
        status: 'installed',
        message: post.installed ? `Installed (${post.version ?? 'version unknown'})` : 'Installed',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.onProgress?.({ type: 'error', tool: provider.name, message });
      outcomes.push({ provider, status: 'failed', message });
    }
  }

  return outcomes;
}

function resolveTargets(tools?: string[]): Provider[] {
  if (!tools || tools.length === 0) return defaultProviders.filter((p) => p.required);
  const matched: Provider[] = [];
  for (const name of tools) {
    const p = findProvider(name);
    if (!p) throw new Error(`Unknown tool "${name}". Known: ${defaultProviders.map((q) => q.name).join(', ')}`);
    matched.push(p);
  }
  return matched;
}
