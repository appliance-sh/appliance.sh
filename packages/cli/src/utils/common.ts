import { Command } from 'commander';
import path from 'path';
import * as fs from 'node:fs';
import { Appliance, applianceInput, ApplianceInput, Result } from '@appliance.sh/sdk';

export function extractApplianceFile(cmd: Command): Result<ApplianceInput> {
  let filePath;
  if (cmd.getOptionValue('file')) {
    filePath = path.resolve(process.cwd(), cmd.getOptionValue('file'));
  } else if (cmd.getOptionValue('directory')) {
    filePath = path.resolve(process.cwd(), cmd.getOptionValue('directory'), 'appliance.json');
  }

  // check if file exists
  if (!filePath) {
    return {
      success: false,
      error: { name: 'File Not Found', message: 'No appliance file found.' },
    };
  }

  if (!filePath.endsWith('.json')) {
    throw new Error('Appliance file must be a JSON file');
  }

  try {
    const fileBuf = fs.readFileSync(filePath);
    const result = applianceInput.safeParse(JSON.parse(fileBuf.toString()));

    return result;
  } catch (err) {
    return {
      success: false,
      error: err as Error,
    };
  }
}

export function saveApplianceFile(filePath: string, appliance: Appliance) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(appliance, null, 2));
    return {
      success: true,
    };
  } catch (err) {
    return {
      success: false,
      error: err as Error,
    };
  }
}
