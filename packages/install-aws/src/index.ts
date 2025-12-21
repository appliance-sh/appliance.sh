#!/usr/bin/env ts-node

import { ApplianceApiGlobalStackV1 } from './lib/ApplianceApiGlobalStackV1';

export * from './version';

import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ApplianceApiStackV1 } from './lib/ApplianceApiStackV1';
import { ApplianceGlobalStackV1 } from './lib/ApplianceGlobalStackV1';
import { ApplianceBase } from './lib/ApplianceBase';

const app = new cdk.App();

const stackId = `appliance-api-${`stack`}`;

const base = new ApplianceBase(app, 'appliance-base', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});

const domainName = base.domainName;

const globalStack = new ApplianceGlobalStackV1(app, `${stackId}-global`, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  domain: domainName.valueAsString,
  crossRegionReferences: true,
});

if (!globalStack.hostedZone) throw new Error('Global stack not deployed');
if (!globalStack.cfDistribution) throw new Error('Global stack not deployed');
if (!globalStack.globalCertificate) throw new Error('Global stack not deployed');

const localApiStack = new ApplianceApiStackV1(app, stackId, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  crossRegionReferences: true,
  hostedZone: globalStack.hostedZone,
  cfDistribution: globalStack.cfDistribution,
  domain: domainName.valueAsString,
});

if (!localApiStack.apiLambdaUrl) throw new Error('Local API stack not deployed');

new ApplianceApiGlobalStackV1(app, `${stackId}-api-global`, {
  functionUrl: localApiStack.apiLambdaUrl,
  globalCertificate: globalStack.globalCertificate,
  hostedZone: globalStack.hostedZone,
  cfDistribution: globalStack.cfDistribution,
  crossRegionReferences: true,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
})
