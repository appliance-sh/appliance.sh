import { Command } from 'commander';
import { clearLink, findLinkLocation } from './utils/link.js';
import chalk from 'chalk';

const program = new Command();

program.description('remove the local project/environment link').action(() => {
  const loc = findLinkLocation();
  if (!loc) {
    console.log(chalk.dim('No link found in this directory tree.'));
    return;
  }
  const removed = clearLink();
  if (removed) {
    console.log(chalk.green(`Unlinked. Removed ${loc.filePath}`));
  } else {
    console.error(chalk.red(`Failed to remove ${loc.filePath}`));
    process.exit(1);
  }
});

program.parse(process.argv);
