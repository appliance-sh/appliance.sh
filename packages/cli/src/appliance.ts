#!/usr/bin/env node

import { Command } from 'commander';

import * as sdk from '@appliance.sh/sdk';

const program = new Command();

program
  .name('appliance')
  .version(sdk.VERSION)
  .command('build', 'builds the appliance in the current working directory')
  .command('configure', 'configures the appliance in the current working directory')
  .command('deploy <project> <environment>', 'deploy a named project/environment')
  .command('destroy <project> <environment>', 'destroy a named project/environment')
  .command('init', 'initialise the CLI with the appliance server')
  .command('install <project> <environment>', 'alias for deploy')
  .command('login', 'authenticate with the appliance API')
  .command('remove <project> <environment>', 'alias for destroy')
  .command('test', 'run connection and signing diagnostics');

program.parse(process.argv);
