import {
  ApplianceDeploymentService,
  createApplianceDeploymentService,
  type PulumiAction,
  type PulumiResult,
} from '@appliance.sh/infra';

// Re-export types for consumers
export type { PulumiAction, PulumiResult };

// Export a singleton instance
export const pulumiService: ApplianceDeploymentService = createApplianceDeploymentService();
