import { Command } from 'commander';
import { extractApplianceFile, saveApplianceFile } from './utils/common.js';
import {
  promptForApplianceFramework,
  promptForApplianceName,
  promptForAppliancePlatform,
  promptForAppliancePort,
  promptForApplianceType,
} from './wizards/appliance.js';
import * as diff from 'json-diff';

import * as prompt from '@inquirer/prompts';
import { ApplianceInput, ApplianceType } from '@appliance.sh/sdk';

const program = new Command();

program
  .option('-f, --file <file>', 'appliance manifest file', 'appliance.json')
  .option('-d, --directory <directory>', 'appliance directory');

const cmd = program.parse(process.argv);

const applianceFileResult = extractApplianceFile(cmd);

// If a file or directory was specified, but the file was not found, exit with an error.
if (
  ((cmd.getOptionValue('file') && cmd.getOptionValue('file') !== 'appliance.json') ||
    cmd.getOptionValue('directory')) &&
  !applianceFileResult.success
) {
  console.log('The specified file was not found.');
  process.exit(1);
}

if (!applianceFileResult.success) {
  console.log(`An error occurred while reading the specified file.`);
  console.log(applianceFileResult.error);
}

let updatedApplianceFile = {
  manifest: 'v1',
  ...applianceFileResult.data,
} as ApplianceInput;

try {
  const name = await promptForApplianceName(updatedApplianceFile);

  updatedApplianceFile = {
    ...updatedApplianceFile,
    name,
  };

  const type = await promptForApplianceType(updatedApplianceFile);

  if (type === ApplianceType.framework) {
    const framework = await promptForApplianceFramework(updatedApplianceFile);
    const platform = await promptForAppliancePlatform(updatedApplianceFile);
    updatedApplianceFile = {
      ...updatedApplianceFile,
      type,
      framework,
      platform,
    };
  } else if (type === ApplianceType.container) {
    const port = await promptForAppliancePort(updatedApplianceFile);
    const platform = await promptForAppliancePlatform(updatedApplianceFile);

    updatedApplianceFile = {
      ...updatedApplianceFile,
      type,
      port,
      platform,
    };
  } else if (type === ApplianceType.other) {
    updatedApplianceFile = {
      ...updatedApplianceFile,
      type,
    };
  } else {
    // promptForApplianceType only offers framework/container/other
    // today. Desktop appliances are configured by hand (or via a
    // future wizard that knows about platforms + builder).
    throw new Error(`Interactive configuration for type '${type}' is not implemented`);
  }

  console.log(diff.colorize(diff.diff(applianceFileResult.data, updatedApplianceFile)));

  const saveChanges = await prompt.confirm({ message: 'Save changes?', default: true });
  if (!saveChanges) {
    console.log('Changes cancelled.');
    process.exit(0);
  }

  saveApplianceFile(cmd.getOptionValue('file') || 'appliance.json', updatedApplianceFile);
} catch (error) {
  console.error(error);
}
