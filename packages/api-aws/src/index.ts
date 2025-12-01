export * from './version';

import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ApplianceApiStackV1 } from './lib/ApplianceApiStackV1';

const app = new cdk.App();
new ApplianceApiStackV1(app, 'ApplianceApiStackV1', {});
