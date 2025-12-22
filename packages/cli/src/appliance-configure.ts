import { Command } from 'commander';
import { extractApplianceFile } from './utils/common.js';
import { promptForApplianceName } from './wizards/appliance.js';
import * as diff from 'json-diff';

import * as prompt from '@inquirer/prompts';

const program = new Command();

program
  .option('-f, --file <file>', 'appliance manifest file', 'appliance.json')
  .option('-d, --directory <directory>', 'appliance directory');

const cmd = program.parse(process.argv);

const applianceFile = extractApplianceFile(cmd);

// If a file or directory was specified, but the file was not found, exit with an error.
if (
  ((cmd.getOptionValue('file') && cmd.getOptionValue('file') !== 'appliance.json') ||
    cmd.getOptionValue('directory')) &&
  !applianceFile.success
) {
  console.log('The specified file was not found.');
  process.exit(1);
}

let updatedApplianceFile = {
  ...applianceFile.data,
};

try {
  const name = await promptForApplianceName(applianceFile.data);

  updatedApplianceFile = {
    name,
    ...updatedApplianceFile,
  };

  console.log(diff.colorize(diff.diff(applianceFile, updatedApplianceFile)));

  const saveChanges = await prompt.confirm({ message: 'Save changes?', default: true });
  if (!saveChanges) {
    console.log('Changes cancelled.');
    process.exit(0);
  }
} catch (error) {
  console.error(error);
}
