#!/usr/bin/env node

import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import * as prompts from '@inquirer/prompts';
import chalk from 'chalk';
import { runTeardown, type BootstrapEvent } from '@appliance.sh/bootstrap';

const program = new Command();

program
  .description('destroy a bootstrap installation (reverses `appliance bootstrap`)')
  .option('--cache-dir <dir>', 'override ~/.appliance cache directory')
  .option('--profile <name>', 'AWS profile to authenticate with')
  .option('-y, --yes', 'skip the confirmation prompt')
  .action(async (options: { cacheDir?: string; profile?: string; yes?: boolean }) => {
    if (!options.yes) {
      console.log(
        chalk.yellow(
          '\n⚠  This will destroy the installer stack and every base AWS resource it created (Route53 zone, ' +
            'CloudFront distribution, ACM certificate, edge router Lambda, S3 state + data buckets, ECR ' +
            'repository, IAM roles).'
        )
      );
      console.log(
        chalk.yellow(
          '   User-deployed appliances on this cluster live in a separate Pulumi project and are NOT ' +
            'destroyed by this command. Run `appliance destroy <project> <env>` for each before tearing ' +
            'down the cluster, otherwise their AWS resources will be orphaned.\n'
        )
      );
      const ok = await prompts.confirm({ message: 'Proceed with teardown?', default: false });
      if (!ok) {
        console.log(chalk.dim('aborted'));
        process.exit(0);
      }
    }

    try {
      await runTeardown({
        cacheDir: options.cacheDir ?? path.join(os.homedir(), '.appliance'),
        awsProfile: options.profile,
        emit: renderEvent,
      });

      console.log();
      console.log(chalk.green('Teardown complete'));
    } catch (e) {
      console.error();
      const msg = e instanceof Error ? e.message : String(e);
      console.error(chalk.red('Teardown failed:'), msg);
      process.exit(1);
    }
  });

function renderEvent(e: BootstrapEvent): void {
  switch (e.type) {
    case 'resource': {
      if (e.op === 'same') return;
      const glyph = e.op === 'delete' ? '-' : e.op === 'create' ? '+' : '·';
      const color = e.op === 'delete' ? chalk.red : e.op === 'create' ? chalk.green : chalk.dim;
      console.log(`  ${color(glyph)} ${e.resourceType.padEnd(44)} ${e.name}`);
      break;
    }
    case 'log':
      if (e.level === 'warn') console.log(chalk.yellow(e.message));
      else if (e.level === 'error') console.log(chalk.red(e.message));
      else console.log(chalk.dim(e.message));
      break;
  }
}

program.parse(process.argv);
