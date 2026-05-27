// Public surface for @appliance.sh/helper. The CLI and desktop import
// from this barrel so the provider tree, registry, and orchestrator
// move around freely without breaking consumers.

export * from './types.js';
export { createContext, detectArch, detectPlatform, ensureHelperBinOnPath, helperBinDir } from './context.js';
export { defaultProviders, findProvider } from './registry.js';
export { runInstall, runStatus } from './install.js';
export type { InstallOptions, InstallOutcome, StatusEntry } from './install.js';
