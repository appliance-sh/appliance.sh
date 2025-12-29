import { ApplianceBaseConfigInput, ApplianceBaseType } from '@appliance.sh/sdk';
import { ApplianceBaseAwsPublic } from './aws/ApplianceBaseAwsPublic';
import { ApplianceBaseAwsVpc } from './aws/ApplianceBaseAwsVpc';

export function lookup(baseConfig: ApplianceBaseConfigInput) {
  switch (baseConfig.type) {
    case ApplianceBaseType.ApplianceAwsPublic:
      return ApplianceBaseAwsPublic;
    case ApplianceBaseType.ApplianceAwsVpc:
      return ApplianceBaseAwsVpc;
  }
}
