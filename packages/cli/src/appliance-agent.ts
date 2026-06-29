import * as path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { password } from '@inquirer/prompts';
import { ensureHelperBinOnPath } from '@appliance.sh/helper';

import {
  type AgentAdapter,
  claudeCodeAdapter,
  forgetAgentKey,
  readAgentKey,
  runAgent,
  targetVm,
  writeAgentKey,
} from './utils/agent.js';
import { runVm } from './utils/sandbox.js';
import {
  type AgentStatus,
  agentIdFromSession,
  findAgent,
  readRegistry,
  reconcileRegistry,
  updateAgentStatus,
  upsertAgent,
} from './utils/agents-registry.js';

// `appliance agent` — run a coding agent (Claude Code first) inside the
// Phase-4 microVM sandbox, with the Anthropic key brokered host-side and
// never entering the VM (docs/agent-sandbox.md).
//
// This file is the A1 runner surface + the A2 host key store / `print-key`
// helper + the A3 command group (start/list/stop/attach) backed by the A4
// registry (.appliance/agents.json, utils/agents-registry.ts).

/** Map an agent-type to its adapter. Claude Code is the only one today;
 *  codex/aider/etc. are future adapter objects (docs §8b). */
function adapterForType(type: string): AgentAdapter | null {
  return type === 'claude-code' ? claudeCodeAdapter : null;
}

ensureHelperBinOnPath();

const program = new Command();
program.name('appliance agent').description('run a coding agent inside the microVM sandbox (Claude Code)');

program
  .command('start [project]')
  .alias('run')
  .description('launch a coding agent in a reattachable session (broker-wired) and record it in the registry')
  .option('--vm <name>', 'sandbox VM to run in (defaults to the linked/shared sandbox VM)')
  .option('--dir <path>', 'project directory to mount at /persist/workspace (defaults to [project] or cwd)')
  .option('--type <type>', 'agent adapter type', 'claude-code')
  .option('--autonomous', 'run one prompt headless to completion (claude -p) instead of an interactive TTY', false)
  .option('--task <prompt>', 'the task prompt (required for --autonomous; optional label otherwise)')
  .option('--session <id>', 'use this session id instead of minting one (normalized to the agent- prefix)')
  .option('--no-attach', 'launch + record without attaching the interactive session afterwards')
  .action(
    async (
      project: string | undefined,
      opts: {
        vm?: string;
        dir?: string;
        type: string;
        autonomous: boolean;
        task?: string;
        session?: string;
        attach: boolean;
      }
    ) => {
      if (opts.autonomous && !opts.task) {
        console.error(chalk.red('--autonomous requires --task "<prompt>".'));
        process.exit(1);
      }
      const adapter = adapterForType(opts.type);
      if (!adapter) {
        console.error(chalk.red(`unsupported agent type '${opts.type}' (supported: claude-code).`));
        process.exit(1);
      }
      // Keyless guard: warn + point to `appliance agent login` rather than
      // silently launching a keyless agent — the proxy fails closed, so it
      // would only hit a 502 (docs/agent-sandbox.md §3 step 5).
      if (!readAgentKey()) {
        console.error(
          chalk.yellow('No Anthropic key configured. ') +
            `Run ${chalk.bold('appliance agent login')} to store it host-side ` +
            '(it is brokered into the agent and never enters the VM).'
        );
        process.exit(1);
      }

      const projectDir = path.resolve(project ?? opts.dir ?? process.cwd());
      const vm = opts.vm ?? targetVm();
      const mode: 'interactive' | 'autonomous' = opts.autonomous ? 'autonomous' : 'interactive';

      // runAgent (A1) ensures the VM is booted, configures the broker, and
      // launches the detached `agent-<id>` tmux session.
      const sessionId = await runAgent({ vm, projectDir, adapter, mode, task: opts.task, sessionId: opts.session });

      // Record it in the per-project registry (.appliance/agents.json
      // beside link.json). list/stop/attach + the desktop badge read this;
      // liveness reconciles against the live tmux sessions.
      upsertAgent(
        {
          id: agentIdFromSession(sessionId),
          type: adapter.type,
          task: opts.task,
          status: 'running',
          sessionId,
          launchedAt: new Date().toISOString(),
          vm,
          mode,
        },
        projectDir
      );

      // Interactive default → attach the just-launched session so the user
      // lands in the agent. Autonomous → leave it running headless (result
      // capture is A6); the session can still be attached later to watch.
      if (mode === 'interactive' && opts.attach) {
        process.exit(runVm(['shell', vm, '--session', sessionId]));
      }
    }
  );

program
  .command('list')
  .alias('ls')
  .description('list agents from the registry, cross-checked against live tmux sessions')
  .option('--json', 'print the reconciled registry as JSON', false)
  .action((opts: { json: boolean }) => {
    const { agents, live } = reconcileRegistry();
    if (opts.json) {
      console.log(
        JSON.stringify(
          agents.map((a) => ({ ...a, live: live[a.sessionId] ?? null })),
          null,
          2
        )
      );
      return;
    }
    if (agents.length === 0) {
      console.log(chalk.dim('No agents. Launch one with `appliance agent start`.'));
      return;
    }
    const idW = Math.max(2, ...agents.map((a) => a.id.length));
    const typeW = Math.max(4, ...agents.map((a) => a.type.length));
    const statusW = Math.max(6, ...agents.map((a) => a.status.length));
    console.log(chalk.dim(`${'ID'.padEnd(idW)}  ${'TYPE'.padEnd(typeW)}  ${'STATUS'.padEnd(statusW)}  TASK`));
    for (const a of agents) {
      const status = colorStatus(a.status.padEnd(statusW), a.status, live[a.sessionId]);
      const task = a.task ? truncate(a.task, 48) : chalk.dim('—');
      console.log(`${a.id.padEnd(idW)}  ${a.type.padEnd(typeW)}  ${status}  ${task}`);
    }
  });

program
  .command('stop <id>')
  .description("kill the agent's tmux session and mark it exited in the registry")
  .action((id: string) => {
    const agent = findAgent(id, readRegistry());
    if (!agent) {
      console.error(chalk.red(`no agent matching '${id}' (see \`appliance agent list\`).`));
      process.exit(1);
    }
    const vm = agent.vm ?? targetVm();
    const code = runVm(['sessions', 'kill', agent.sessionId, '--name', vm]);
    updateAgentStatus(agent.id, 'exited');
    if (code !== 0) {
      console.error(
        chalk.yellow(`session kill for '${agent.sessionId}' exited ${code}; marked exited in the registry anyway.`)
      );
      process.exit(code);
    }
    console.log(`${chalk.green('✓')} stopped agent ${chalk.bold(agent.id)} (session ${agent.sessionId}).`);
  });

program
  .command('attach <id>')
  .description("reattach to the agent's tmux session")
  .action((id: string) => {
    const agent = findAgent(id, readRegistry());
    if (!agent) {
      console.error(chalk.red(`no agent matching '${id}' (see \`appliance agent list\`).`));
      process.exit(1);
    }
    const vm = agent.vm ?? targetVm();
    process.exit(runVm(['shell', vm, '--session', agent.sessionId]));
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

/** Colorize a (pre-padded) status cell by status + reconciled liveness:
 *  green = running + live, cyan = running but the VM was unreachable
 *  (liveness unknown), yellow = running yet the session is gone (a
 *  pre-reconcile race), red = error, dim = exited/done. */
function colorStatus(text: string, status: AgentStatus, live: boolean | null | undefined): string {
  if (status === 'running') {
    if (live === false) return chalk.yellow(text);
    if (live == null) return chalk.cyan(text);
    return chalk.green(text);
  }
  if (status === 'error') return chalk.red(text);
  if (status === 'exited' || status === 'done') return chalk.dim(text);
  return text;
}

/** Truncate a label with an ellipsis for single-line table display. */
function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

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
