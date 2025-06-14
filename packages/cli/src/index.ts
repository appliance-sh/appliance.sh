#!/usr/bin/env node

import {Command} from 'commander';

const program = new Command();

program.name('appliance')
  .version('0.0.0')
  .command('build', 'builds the appliance in the current working directory')
  .command('install [appliance-names...]', 'install one or more appliances')
  .command('remove [appliance-names...]', 'remove one or more appliances');

program.parse(process.argv);
