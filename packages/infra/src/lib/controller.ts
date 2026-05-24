import { ApplianceBaseConfigInput, ApplianceBaseType } from '@appliance.sh/sdk';
import { ApplianceBaseAwsPublic } from './aws/ApplianceBaseAwsPublic';
import { ApplianceBaseAwsVpc } from './aws/ApplianceBaseAwsVpc';

export function lookup(baseConfig: ApplianceBaseConfigInput) {
  switch (baseConfig.type) {
    case ApplianceBaseType.ApplianceAwsPublic:
      return ApplianceBaseAwsPublic;
    case ApplianceBaseType.ApplianceAwsVpc:
      return ApplianceBaseAwsVpc;
    case ApplianceBaseType.ApplianceLocal:
      // Local bases don't have a Pulumi-managed baseline — the
      // api-server's LocalContainerDeploymentService handles the
      // whole deploy/destroy cycle directly via kubectl. The
      // declarative `applianceInfra()` entrypoint is AWS-only.
      throw new Error(
        'Local bases do not have a Pulumi-managed baseline; use the desktop to manage cluster lifecycle.'
      );
  }
}
