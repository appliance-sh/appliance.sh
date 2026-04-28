import { AppliancePlatform, ApplianceType, type ApplianceFull, type ManifestContext } from '@appliance.sh/sdk';

// Single programmatic manifest for the api-server image. The same
// Docker build serves two appliances differentiated only by deploy-
// time runtime config: the server env runs `APPLIANCE_MODE=server`
// (HTTP routes); the worker env runs `APPLIANCE_MODE=worker`
// (/api/internal only) with a longer Lambda timeout because it
// executes Pulumi runs.
//
// Build-time fields (manifest/type/name/port/platform/scripts) are
// the same in both cases — the artifact is environment-invariant.
// Per-environment runtime config (env, memory, timeout, storage) is
// rendered at deploy time using the `environment` context the CLI
// provides, and forwarded on the deploy payload.
export default ({ environment }: ManifestContext): ApplianceFull => {
  const isWorker = environment === 'worker';
  return {
    manifest: 'v1',
    type: ApplianceType.container,
    name: 'appliance-api-server',
    port: 3000,
    platform: AppliancePlatform.LinuxAmd64,
    scripts: {
      build: 'bash scripts/docker-prep.sh',
    },
    memory: 2048,
    timeout: isWorker ? 900 : 30,
    storage: 4096,
    env: {
      APPLIANCE_MODE: isWorker ? 'worker' : 'server',
      APPLIANCE_TRUST_PROXY: 'true',
    },
  };
};
