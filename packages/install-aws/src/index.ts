#!/usr/bin/env ts-node

export * from './version';

import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ApplianceInstaller } from './lib/ApplianceInstaller';

const app = new cdk.App();

const stackId = `appliance-installer`;

const base = new ApplianceInstaller(app, stackId, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});

new cdk.CfnOutput(app, `${stackId}-state-bucket-arn`, {
  key: 'stateBucketArn',
  value: base.state.bucketArn,
});
