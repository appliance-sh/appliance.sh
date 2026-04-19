import * as pulumi from '@pulumi/pulumi';
import { automation } from '@pulumi/pulumi';
import { ApplianceBaseConfigInput } from '@appliance.sh/sdk';
import { applianceInfra } from './lib/appliance-infra';

// Standalone Automation API driver for scripted `pulumi up` runs against
// this package's workspace. Reads stack config via a program closure that
// constructs ApplianceInfraInput from Pulumi.<stack>.yaml, then hands it
// to applianceInfra(). The desktop bootstrap uses its own driver that
// supplies input from the wizard instead of reading workspace files.
const program = async () => {
  const cfg = new pulumi.Config('appliance-infra');
  const bases = cfg.requireObject<Record<string, ApplianceBaseConfigInput>>('bases');
  const enableApiServer = cfg.getBoolean('enableApiServer') ?? false;
  const apiServerImageUri = cfg.get('apiServerImageUri');
  const bootstrapToken = cfg.getSecret('bootstrapToken');
  const protectState = cfg.getBoolean('protectState') ?? true;
  const forceDestroyState = cfg.getBoolean('forceDestroyState') ?? false;

  return applianceInfra({
    bases,
    enableApiServer,
    apiServerImageUri,
    bootstrapToken,
    protectState,
    forceDestroyState,
  });
};

export async function main() {
  const stack = await automation.LocalWorkspace.createOrSelectStack({
    projectName: 'appliance-infra',
    stackName: 'bootstrap',
    program,
  });

  await stack.up();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
