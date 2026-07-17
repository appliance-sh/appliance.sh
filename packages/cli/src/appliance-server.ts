import { Command } from 'commander';
import chalk from 'chalk';
import { DEFAULT_VM_NAME, ensureLocalRuntime, runVm } from './utils/microvm-up.js';

// `appliance server` — compatibility shim. The host-daemon control
// plane was removed: the api-server now runs as a plain binary INSIDE
// the microVM (provisioned at boot by the engine), so there is no
// separate server process to start, stop, or tail on the host.
//
//   server start  → brings the VM (and its guest api-server) up, like
//                   `appliance vm up`, then points at the new commands.
//   server stop   → parks the VM (`appliance vm stop`).
//   server status → proxies `appliance vm status`.
//   server logs   → points at `appliance vm console` (the guest's
//                   console log is where the api-server logs live).
//
// Removed entirely: `--runtime docker` (the host Docker runtime is
// gone) and the hidden `run` entry (nothing self-invokes anymore).

const MOVED = (cmd: string) => chalk.dim(`(\`appliance server\` is deprecated — use \`${cmd}\`)`);

const program = new Command();

program
  .name('appliance server')
  .description('deprecated: the control plane runs inside the microVM — use `appliance dev` / `appliance vm`');

program
  .command('start')
  .description('deprecated: boots the microVM runtime (use `appliance dev` or `appliance vm up`)')
  .option('--port <port>', 'removed — the VM owns its ports')
  .option('--data-dir <path>', 'removed — state lives inside the VM')
  .option('--foreground', 'removed')
  .option('--runtime <runtime>', 'removed — the host Docker runtime is gone')
  .action(async (opts: { port?: string; dataDir?: string; foreground?: boolean; runtime?: string }) => {
    if (opts.runtime === 'docker') {
      console.log(
        chalk.yellow(
          'The host Docker runtime was removed — deploys land in the microVM runtime (no Docker needed anywhere).'
        )
      );
    }
    console.log(MOVED('appliance dev'));
    await ensureLocalRuntime();
  });

program
  .command('stop')
  .description('deprecated: parks the microVM (use `appliance vm stop`)')
  .option('--vm', 'ignored — this always parks the VM now')
  .action(() => {
    console.log(MOVED('appliance vm stop'));
    process.exit(runVm(['stop', DEFAULT_VM_NAME]));
  });

program
  .command('status')
  .description('deprecated: shows the microVM state (use `appliance vm status`)')
  .action(() => {
    console.log(MOVED('appliance vm status'));
    process.exit(runVm(['status', DEFAULT_VM_NAME]));
  });

program
  .command('logs')
  .description("deprecated: the api-server's log lives in the VM (use `appliance vm console`)")
  .option('--tail <lines>', 'ignored')
  .option('-f, --follow', 'ignored')
  .action(() => {
    console.log(MOVED('appliance vm console'));
    process.exit(runVm(['console', DEFAULT_VM_NAME]));
  });

program.parse(process.argv);
