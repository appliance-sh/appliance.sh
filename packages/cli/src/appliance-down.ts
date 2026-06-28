import { Command } from 'commander';
import chalk from 'chalk';
import { ensureHelperBinOnPath } from '@appliance.sh/helper';
import { readSandboxLink, writeSandboxLink } from './utils/link.js';
import { vmShell } from './utils/sandbox.js';

// `appliance down` — stop + remove this project's sandbox container
// (docs/up.md §2). Reads the `sandbox` block from link.json, removes the
// container in the guest, and clears the sandbox link. The image and the
// VM survive (`down` is the inverse of `up`'s container, not the engine).

ensureHelperBinOnPath();

const program = new Command();

program
  .description("stop and remove this project's sandbox container")
  .option('--vm <name>', 'sandbox VM the project runs in (defaults to the linked VM)')
  .action((opts: { vm?: string }) => {
    const sandbox = readSandboxLink();
    if (!sandbox) {
      console.error(chalk.red('no sandbox link in this folder — run `appliance up` first (nothing to bring down).'));
      process.exit(1);
    }
    const vm = opts.vm ?? sandbox.vm;
    console.log(chalk.cyan(`» removing container ${sandbox.project} in '${vm}'`));
    const code = vmShell(vm, ['docker', 'rm', '-f', sandbox.project]);
    if (code !== 0) {
      // The container may already be gone (e.g. VM stopped) — clearing the
      // link is still the right outcome, so report and continue.
      console.log(chalk.yellow(`  container ${sandbox.project} was not running (or the VM is stopped)`));
    } else {
      console.log(`${chalk.green('✓')} removed ${sandbox.project}`);
    }
    writeSandboxLink(null);
    console.log(chalk.dim('  sandbox link cleared'));
  });

program.parse(process.argv);
