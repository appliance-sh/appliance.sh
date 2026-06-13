import type { ConsoleHost } from './host';

// Shared helpers for the single "Local Runtime" concept the shell now
// presents. Under the hood two engines back it — a microVM (host.vm,
// the sandboxed default) and host-side k3d (host.local) — but the UI
// treats them as one runtime with a "sandbox in a virtual machine"
// choice rather than two separate engines to pick between.

const ONBOARDING_KEY = 'appliance.onboarding.localRuntime.dismissed';

export interface LocalRuntimeCapabilities {
  /** Can sandbox the runtime inside a microVM (host.vm present). This
   *  is the recommended default — stronger isolation, no docker
   *  provider for the cluster. */
  canSandbox: boolean;
  /** Can run the runtime directly on the host via k3d (host.local). */
  canHost: boolean;
  /** Either local engine is available on this shell. */
  any: boolean;
}

/** What kinds of local runtime this shell can drive. The web shell can
 *  drive neither (no shell access); the desktop drives both. */
export function localRuntimeCapabilities(host: ConsoleHost): LocalRuntimeCapabilities {
  const canSandbox = Boolean(host.vm);
  const canHost = Boolean(host.local?.startRuntime);
  return { canSandbox, canHost, any: canSandbox || canHost };
}

/** Default to a sandboxed runtime whenever the microVM engine exists —
 *  it's the recommended setup. Falls back to host-side k3d only when a
 *  sandbox isn't available. */
export function defaultSandbox(caps: LocalRuntimeCapabilities): boolean {
  return caps.canSandbox;
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
