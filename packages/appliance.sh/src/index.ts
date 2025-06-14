import {Command} from 'commander';

const program = new Command();

program.name('appliance.sh')
  .version('0.0.0')
  .command('install [appliance-names...]', 'install one or more appliances')
  .command('remove [appliance-names...]', 'remove one or more appliances');

program.parse(process.argv);
