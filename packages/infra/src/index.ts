import * as pulumi from '@pulumi/pulumi';
import { ApplianceBaseConfigInput } from '@appliance.sh/sdk';
import { applianceInfra } from './lib/appliance-infra';

// Pulumi program entry invoked by `pulumi up` from this package directory.
// Reads stack config (set via Pulumi.<stack>.yaml) and hands it to the
// parameterized applianceInfra() function. The Automation API path used
// by the desktop bootstrap constructs ApplianceInfraInput directly and
// bypasses this adapter.
const cfg = new pulumi.Config('appliance-infra');
const bases = cfg.requireObject<Record<string, ApplianceBaseConfigInput>>('bases');
const enableApiServer = cfg.getBoolean('enableApiServer') ?? false;
const apiServerImageUri = cfg.get('apiServerImageUri');
const bootstrapToken = cfg.getSecret('bootstrapToken');
const protectState = cfg.getBoolean('protectState') ?? true;
const forceDestroyState = cfg.getBoolean('forceDestroyState') ?? false;

export = async () =>
  applianceInfra({
    bases,
    enableApiServer,
    apiServerImageUri,
    bootstrapToken,
    protectState,
    forceDestroyState,
  });
