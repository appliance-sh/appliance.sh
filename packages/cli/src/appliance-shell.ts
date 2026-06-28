import { Command } from 'commander';
import chalk from 'chalk';
import { ensureHelperBinOnPath } from '@appliance.sh/helper';
import { readSandboxLink } from './utils/link.js';
import { runVm, vmShell, vmShellCapture } from './utils/sandbox.js';

// `appliance shell [cmd...]` — enter this project's sandbox (docs/up.md
// §6 C). For a devcontainer link it runs `devcontainer exec` against the
// shared workspace so you land inside the repo's own toolchain container.
// For a Dockerfile/compose link (no in-container exec contract) it falls
// back to the VM host shell — the same `appliance-vm shell <vm>` channel.
//
// Interactivity is best-effort: commands stream through the one-shot
// vsock path (`appliance-vm shell <vm> -- …`), so output flows and exit
// codes propagate, but a full interactive TTY (job control, raw-mode
// editors) is a follow-up. Pass a command to run it one-shot.

ensureHelperBinOnPath();

const program = new Command();

program
  .description("enter this project's sandbox (devcontainer exec, or the VM host shell)")
  .option('--vm <name>', 'sandbox VM to enter (defaults to the linked VM)')
  .argument('[command...]', 'command to run instead of an interactive shell (best-effort TTY)')
  .addHelpText(
    'after',
    '\nNote: interactivity is best-effort — the one-shot vsock path streams output and\n' +
      'propagates exit codes, but a full interactive TTY is a follow-up. Pass a command to\n' +
      'run it directly, e.g. `appliance shell -- npm test`.'
  )
  .action((command: string[], opts: { vm?: string }) => {
    const sandbox = readSandboxLink();
    if (!sandbox) {
      console.error(chalk.red('no sandbox link in this folder — run `appliance up` first (nothing to enter).'));
      process.exit(1);
    }
    const vm = opts.vm ?? sandbox.vm;

    if (sandbox.type === 'devcontainer') {
      const workspace = sandbox.workspace ?? '/persist/workspace';
      // Default to bash when the container has it, else sh. `command -v`
      // runs inside the container via `devcontainer exec`.
      let cmd = command;
      if (cmd.length === 0) {
        const hasBash = vmShellCapture(vm, [
          'devcontainer',
          'exec',
          '--workspace-folder',
          workspace,
          'sh',
          '-lc',
          'command -v bash',
        ]);
        cmd = hasBash.status === 0 && hasBash.stdout ? ['bash'] : ['sh'];
      }
      console.error(chalk.dim(`Entering devcontainer ${chalk.bold(sandbox.project)} (${vm}) — best-effort TTY`));
      process.exit(vmShell(vm, ['devcontainer', 'exec', '--workspace-folder', workspace, ...cmd]));
    }

    // Non-devcontainer sandbox: there's no single in-container exec
    // contract (compose has N services, a Dockerfile run is detached), so
    // drop into the VM host shell — the same channel as `appliance vm
    // shell <vm>`.
    console.error(
      chalk.dim(
        `Entering the VM host shell for sandbox ${chalk.bold(sandbox.project)} (${vm}).\n` +
          `This is the VM host, not the ${sandbox.type} container — use \`docker exec\` from here to enter a container.`
      )
    );
    if (command.length) {
      process.exit(runVm(['shell', vm, '--', 'sh', '-c', command.join(' ')]));
    }
    process.exit(runVm(['shell', vm]));
  });

program.parse(process.argv);
