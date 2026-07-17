import { Command } from 'commander';
import * as sdk from '@appliance.sh/sdk';
import chalk from 'chalk';
import { detectUpgradeChannel, upgradeInstructions } from './utils/upgrade-channel.js';

// `appliance upgrade` — print channel-appropriate upgrade instructions.
// Deliberately dumb and honest: it detects HOW this CLI was installed
// (desktop-bundled sidecar vs source vs standalone binary) and prints
// the matching steps. It never executes an upgrade itself — every
// channel has its own updater (the desktop app, npm, the installer)
// and racing them from inside the binary being replaced is how
// half-updated installs happen.

const program = new Command();

program.description('show how to update this CLI (it never updates itself)').action(() => {
  const channel = detectUpgradeChannel(process.execPath);
  console.log(`appliance CLI ${chalk.bold(sdk.VERSION)}`);
  console.log(chalk.dim(`  running from: ${process.execPath}`));
  console.log();
  for (const line of upgradeInstructions(channel)) {
    console.log(line);
  }
});

program.parse(process.argv);
