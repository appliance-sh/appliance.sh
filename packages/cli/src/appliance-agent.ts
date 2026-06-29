import { Command } from 'commander';
import chalk from 'chalk';
import { password } from '@inquirer/prompts';
import { ensureHelperBinOnPath } from '@appliance.sh/helper';

import { forgetAgentKey, readAgentKey, runAgent, writeAgentKey } from './utils/agent.js';

// `appliance agent` — run a coding agent (Claude Code first) inside the
// Phase-4 microVM sandbox, with the Anthropic key brokered host-side and
// never entering the VM (docs/agent-sandbox.md).
//
// This file is the A1 runner surface + the A2 host key store / `print-key`
// helper. The fuller command group (ls/attach/stop, A3) is a follow-up;
// `run`, `login`, `logout`, and `print-key` are the broker's minimum.

ensureHelperBinOnPath();

const program = new Command();
program.name('appliance agent').description('run a coding agent inside the microVM sandbox (Claude Code)');

program
  .command('run')
  .description('launch the agent in a reattachable session, wired through the host credential broker')
  .option('--vm <name>', 'sandbox VM to run in (defaults to the linked/shared sandbox VM)')
  .option('--dir <path>', 'project directory to mount at /persist/workspace (defaults to cwd)')
  .option('--autonomous', 'run one prompt headless to completion (claude -p) instead of an interactive TTY', false)
  .option('--task <prompt>', 'the task prompt (required for --autonomous; optional label otherwise)')
  .action(async (opts: { vm?: string; dir?: string; autonomous: boolean; task?: string }) => {
    if (opts.autonomous && !opts.task) {
      console.error(chalk.red('--autonomous requires --task "<prompt>".'));
      process.exit(1);
    }
    const sessionId = await runAgent({
      vm: opts.vm,
      projectDir: opts.dir,
      mode: opts.autonomous ? 'autonomous' : 'interactive',
      task: opts.task,
    });
    // sessionId is also printed by runAgent with attach guidance.
    void sessionId;
  });

program
  .command('login')
  .description('store the Anthropic API key host-side (Keychain on macOS; 0600 file elsewhere). Never enters the VM.')
  .option('--key <value>', 'the API key (argv-visible; prefer the interactive prompt or stdin)')
  .action(async (opts: { key?: string }) => {
    let key = opts.key;
    if (!key) {
      // Read from a pipe when stdin isn't a TTY (`… | appliance agent
      // login`), else prompt with a hidden input — neither puts the key
      // on argv.
      if (!process.stdin.isTTY) {
        key = await readStdin();
      } else {
        key = await password({ message: 'Paste your Anthropic API key:', mask: '*' });
      }
    }
    key = (key ?? '').trim();
    if (!key) {
      console.error(chalk.red('no key provided.'));
      process.exit(1);
    }
    writeAgentKey(key);
    // NEVER echo the key.
    console.log(
      `${chalk.green('✓')} Anthropic key stored host-side. It is brokered into agents and never enters the VM.`
    );
  });

program
  .command('logout')
  .description('forget the stored host-side Anthropic key')
  .action(() => {
    forgetAgentKey();
    console.log(`${chalk.green('✓')} forgot the stored Anthropic key.`);
  });

program
  .command('print-key')
  .description('HOST helper: print the resolved Anthropic key to stdout for the egress proxy (do not call directly)')
  .action(() => {
    const key = readAgentKey();
    if (!key) {
      // Exit non-zero with NO stdout so the proxy helper resolves to
      // nothing and fails CLOSED (it never forwards the placeholder).
      process.exit(1);
    }
    // Raw key to stdout, nothing else; the proxy trims it.
    process.stdout.write(key);
  });

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (buf += chunk));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

program.parse(process.argv);
