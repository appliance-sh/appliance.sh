import { automation } from '@pulumi/pulumi';
import { applianceInfra } from './lib/appliance-infra';

export async function main() {
  const stack = await automation.LocalWorkspace.createOrSelectStack({
    projectName: 'appliance-infra',
    stackName: 'bootstrap',
    program: applianceInfra,
  });

  console.log(await stack.getAllConfig());

  await stack.up();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
