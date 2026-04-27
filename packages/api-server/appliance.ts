import { AppliancePlatform, ApplianceType, type ApplianceContainer, type ManifestContext } from '@appliance.sh/sdk';

// Single programmatic manifest for the api-server image. Same Docker
// build serves two appliances differentiated by APPLIANCE_MODE:
//
//   appliance build                     → server (default)
//   appliance build --variant worker    → worker (/api/internal only)
//
// main.ts:getMode() reads APPLIANCE_MODE to pick the route set.
// Worker has a longer timeout because it executes Pulumi runs;
// server requests are short HTTP exchanges.
export default ({ environment }: ManifestContext): ApplianceContainer => {
  const isWorker = environment?.startsWith('worker');
  return {
    manifest: 'v1',
    type: ApplianceType.container,
    name: 'appliance-api-server',
    port: 3000,
    platform: AppliancePlatform.LinuxAmd64,
    memory: 2048,
    timeout: isWorker ? 900 : 30,
    storage: 4096,
    scripts: {
      build: 'bash scripts/docker-prep.sh',
    },
    env: {
      APPLIANCE_MODE: isWorker ? 'worker' : 'server',
      APPLIANCE_TRUST_PROXY: 'true',
    },
  };
};
