#!/usr/bin/env node

import { Command } from 'commander';

import * as sdk from '@appliance.sh/sdk';

const program = new Command();

program
  .name('appliance')
  .version(sdk.VERSION)
  .command('build', 'builds the appliance in the current working directory')
  .command('configure', 'configures the appliance in the current working directory')
  .command('install [appliance-names...]', 'install one or more appliances')
  .command('remove [appliance-names...]', 'remove one or more appliances');

program.parse(process.argv);
