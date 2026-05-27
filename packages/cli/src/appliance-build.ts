import { Command } from 'commander';
import * as path from 'node:path';
import { extractApplianceFile, registerManifestOptions } from './utils/common.js';
import { buildApplianceZip } from './utils/build-package.js';
import chalk from 'chalk';

const DEFAULT_OUTPUT = 'appliance.zip';

const program = new Command();

registerManifestOptions(program)
  .description('build an appliance and package it as appliance.zip')
  .option('-o, --output <output>', 'output file', DEFAULT_OUTPUT)
  .action(async () => {
    const opts = program.opts<{ output: string }>();

    const applianceFile = await extractApplianceFile(program);
    if (!applianceFile.success) {
      console.error(chalk.red(applianceFile.error.message));
      process.exit(1);
    }

    try {
      const result = await buildApplianceZip({
        appliance: applianceFile.data,
        outputPath: path.resolve(opts.output),
      });
      const sizeMb = (result.sizeBytes / 1024 / 1024).toFixed(1);
      console.log(chalk.green(`Built: ${result.outputPath} (${sizeMb} MB)`));
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

program.parse(process.argv);
