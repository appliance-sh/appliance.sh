#!/usr/bin/env node

import { Command } from 'commander';

import * as sdk from '@appliance.sh/sdk';

const program = new Command();

program
  .name('appliance')
  .version(sdk.VERSION)
  .command('app', 'manage applications (setup, status, list)')
  .alias('application')
  .command('bootstrap', 'provision a new Appliance installation on AWS')
  .command('build', 'builds the appliance in the current working directory')
  .command('configure', 'configures the appliance in the current working directory')
  .command('deploy <project> <environment>', 'deploy a named project/environment')
  .command('deployment', 'manage deployments')
  .command('destroy <project> <environment>', 'destroy a named project/environment')
  .command('init', 'initialise the CLI with the appliance server')
  .command('install <project> <environment>', 'alias for deploy')
  .command('list', 'list applications and environments')
  .command('login', 'authenticate with the appliance API')
  .command('remove <project> <environment>', 'alias for destroy')
  .command('setup', 'connect local codebase to a cloud application')
  .command('status <project>', 'show application status')
  .command('teardown', 'destroy a bootstrap installation (reverses `appliance bootstrap`)')
  .command('test', 'run connection and signing diagnostics');

program.parse(process.argv);
