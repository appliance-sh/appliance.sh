import { Command } from 'commander';

const program = new Command();

program
  .option('-f, --file <file>', 'appliance manifest file', 'appliance.json')
  .option('-d, --directory <directory>', 'appliance directory');

program.parse(process.argv);
