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
    case ApplianceBaseType.ApplianceKubernetes:
      // Kubernetes-driven bases don't have a Pulumi-managed baseline —
      // the api-server's KubernetesDeploymentService handles the
      // whole deploy/destroy cycle directly via the k8s API. The
      // declarative `applianceInfra()` entrypoint is AWS-only.
      // (ApplianceLocal is a deprecated alias of ApplianceKubernetes.)
      throw new Error(
        `${baseConfig.type} bases do not have a Pulumi-managed baseline; bring up the microVM runtime (\`appliance vm up\`) or apply the api-server manifest directly to manage cluster lifecycle.`
      );
  }
}
