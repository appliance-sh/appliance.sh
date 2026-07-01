import type { ConsoleHost } from './host';

// Shared helpers for the single "Local Runtime" concept the shell
// presents. It's backed by the microVM engine (host.vm) — an isolated
// VM Appliance boots itself, the sole local runtime now that bare k3d
// is gone. The UI frames it as "sandboxed in a virtual machine".

const ONBOARDING_KEY = 'appliance.onboarding.localRuntime.dismissed';

export interface LocalRuntimeCapabilities {
  /** Can sandbox the runtime inside a microVM (host.vm present) —
   *  stronger isolation, no docker provider for the cluster. */
  canSandbox: boolean;
  /** The local runtime is available on this shell. */
  any: boolean;
}

/** Whether this shell can drive the local runtime. The web shell can't
 *  (no shell access); the desktop can. */
export function localRuntimeCapabilities(host: ConsoleHost): LocalRuntimeCapabilities {
  const canSandbox = Boolean(host.vm);
  return { canSandbox, any: canSandbox };
}

/** Whether the operator has dismissed the first-run setup prompt on
 *  this device. Stored in localStorage (a UI preference, not cluster
 *  state) so a missing/blocked store just re-shows the prompt — never
 *  an error. */
export function onboardingDismissed(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_KEY) === '1';
  } catch {
    return false;
  }
}

export function dismissOnboarding(): void {
  try {
    localStorage.setItem(ONBOARDING_KEY, '1');
  } catch {
    // best-effort — re-showing the prompt next launch is harmless.
  }
}

/** Clear the dismissed flag so the first-run setup prompt shows again —
 *  the "replay setup" preference (⑤ Settings → Preferences). Best-effort;
 *  a blocked store just means the prompt was never dismissed anyway. */
export function resetOnboarding(): void {
  try {
    localStorage.removeItem(ONBOARDING_KEY);
  } catch {
    // best-effort — nothing to recover if the store is unavailable.
  }
}
