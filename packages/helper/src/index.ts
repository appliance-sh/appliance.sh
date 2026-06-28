// Public surface for @appliance.sh/helper. The CLI and desktop import
// from this barrel so the provider tree, registry, and orchestrator
// move around freely without breaking consumers.

export * from './types.js';
export { createContext, detectArch, detectPlatform, ensureHelperBinOnPath, helperBinDir } from './context.js';
export { defaultProviders, findProvider } from './registry.js';
export { runInstall, runStatus } from './install.js';
export type { InstallOptions, InstallOutcome, StatusEntry } from './install.js';
export {
  colimaIsActiveRuntime,
  dockerDaemonReachable,
  dockerUnreachableHint,
  ensureDockerRunning,
  runtimeDaemonStatus,
} from './runtime.js';
export type { RuntimeDaemonStatus } from './runtime.js';
export {
  DEFAULT_LOCAL_CLUSTER_NAME,
  DEFAULT_LOCAL_HOST_PORT,
  DEFAULT_LOCAL_NAMESPACE,
  DEFAULT_LOCAL_REGISTRY_PORT,
} from './cluster.js';
export {
  IN_CLUSTER_API_SERVER_DEFAULT_IMAGE,
  IN_CLUSTER_API_SERVER_HOSTNAME,
  IN_CLUSTER_API_SERVER_NAME,
  IN_CLUSTER_API_SERVER_NAMESPACE,
  IN_CLUSTER_API_SERVER_PORT,
  apiServerUrlForHostPort,
  bootstrapInClusterApiServer,
  buildInClusterBaseConfig,
  defaultLocalRuntimeDir,
  mintApiKey,
  readExistingBootstrapToken,
  renderInClusterApiServerManifest,
  resolveRuntimeConfig,
  waitForApiServerUrl,
  yamlDoubleQuoted,
} from './api-server.js';
export type {
  BootstrapInClusterOptions,
  BootstrapInClusterResult,
  LocalRuntimeOptions,
  MintedApiKey,
  ResolvedRuntimeConfig,
} from './api-server.js';
