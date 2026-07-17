/**
 * Runtime config injected by an api-server-served console build
 * (`window.__APPLIANCE_CONFIG__`, see api-server/src/console-static.ts).
 * Absent on the desktop shell and on dev builds — every accessor
 * degrades to "no config".
 */
export interface ApplianceRuntimeConfig {
  /** API base the console should talk to. Same-origin serving injects
   *  window.location.origin. */
  apiServerUrl?: string;
  /** How the serving api-server scopes this console. `bootstrap` means
   *  this origin only handles onboarding (invites / connect) and the
   *  real console lives at `consoleUrl`. */
  consoleMode?: 'full' | 'bootstrap' | 'off';
  /** Canonical console URL when hosted separately from the api-server. */
  consoleUrl?: string;
}

export function runtimeConfig(): ApplianceRuntimeConfig {
  if (typeof window === 'undefined') return {};
  return (window as Window & { __APPLIANCE_CONFIG__?: ApplianceRuntimeConfig }).__APPLIANCE_CONFIG__ ?? {};
}

/** True when the serving api-server scoped this console to onboarding
 *  only (high-security deployments host the day-to-day console
 *  elsewhere, typically behind a VPN or SSO proxy). */
export function isBootstrapOnlyConsole(): boolean {
  return runtimeConfig().consoleMode === 'bootstrap';
}
