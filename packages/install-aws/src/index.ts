#!/usr/bin/env ts-node

export * from './version';

import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ApplianceApiStackV1 } from './lib/ApplianceApiStackV1';
import { ApplianceGlobalStackV1 } from './lib/ApplianceGlobalStackV1';

const app = new cdk.App();

const name = 'stack';
const stackId = `appliance-api-${name}`;

const globalStack = new ApplianceGlobalStackV1(app, `${stackId}-global`, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
});

if (!globalStack.hostedZone) throw new Error('Global stack not deployed');

new ApplianceApiStackV1(app, stackId, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  crossRegionReferences: true,
  hostedZone: globalStack.hostedZone,
});
