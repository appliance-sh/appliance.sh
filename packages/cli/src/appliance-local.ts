import { Command } from 'commander';
import chalk from 'chalk';
import { defaultProviders, ensureHelperBinOnPath, helperBinDir, runInstall, runStatus } from '@appliance.sh/helper';
import type { ProgressEvent, StatusEntry } from '@appliance.sh/helper';

ensureHelperBinOnPath();

// `appliance local` umbrella command. Diagnostics + first-run setup
// for the local k3d-backed runtime — what the desktop's Local Runtime
// page does in the GUI, exposed for CI / headless / power-user flows.

const program = new Command();
program.description('manage the local k3d-backed runtime');

// ---- status -----------------------------------------------------------

program
  .command('status')
  .alias('doctor')
  .description('check that docker, k3d, and kubectl are installed and ready')
  .action(async () => {
    const entries = await runStatus();
    printStatus(entries);
    const missing = entries.filter((e) => !e.check.installed);
    if (missing.length === 0) {
      console.log();
      console.log(chalk.green('All prerequisites installed. The local runtime is ready to start.'));
      return;
    }
    console.log();
    const autoCount = missing.filter((m) => m.provider.autoInstallable).length;
    if (autoCount > 0) {
      console.log(
        chalk.yellow(
          `${missing.length} of ${entries.length} tools missing. Run \`appliance local install\` to install ${autoCount} of them automatically.`
        )
      );
    } else {
      console.log(chalk.yellow(`${missing.length} of ${entries.length} tools missing. See the install hints above.`));
    }
    process.exit(1);
  });

// ---- install ----------------------------------------------------------

program
  .command('install')
  .description(`install missing prerequisites under ${helperBinDir()}`)
  .argument(
    '[tools...]',
    `tools to install (defaults to all required: ${defaultProviders
      .filter((p) => p.required)
      .map((p) => p.name)
      .join(', ')})`
  )
  .option('--force', 're-install even when already present', false)
  .option('--json', 'emit NDJSON progress + final result (one event per line) for tooling/IPC', false)
  .action(async (tools: string[], opts: { force: boolean; json: boolean }) => {
    try {
      await runWithLiveProgress(tools, opts);
    } catch (err) {
      reportError(err, opts.json);
    }
  });

// ---- update -----------------------------------------------------------

program
  .command('update')
  .description('re-install the latest helper-managed binaries (forces auto-installable tools)')
  .argument('[tools...]', 'tools to update (defaults to every auto-installable tool)')
  .option('--json', 'emit NDJSON progress + final result (one event per line) for tooling/IPC', false)
  .action(async (tools: string[], opts: { json: boolean }) => {
    const targets = tools.length > 0 ? tools : defaultProviders.filter((p) => p.autoInstallable).map((p) => p.name);
    try {
      await runWithLiveProgress(targets, { force: true, json: opts.json });
    } catch (err) {
      reportError(err, opts.json);
    }
  });

program.parse(process.argv);

// ---- helpers ----------------------------------------------------------

function printStatus(entries: StatusEntry[]): void {
  for (const { provider, check } of entries) {
    const marker = check.installed ? chalk.green('●') : chalk.red('●');
    const versionTail = check.version ? chalk.dim(` — ${check.version}`) : '';
    console.log(`${marker} ${chalk.bold(provider.name)}${versionTail}`);
    console.log(`    ${chalk.dim(provider.description)}`);
    if (!check.installed) {
      if (check.error) console.log(`    ${chalk.dim(check.error)}`);
      if (provider.autoInstallable) {
        console.log(`    ${chalk.bold('Install:')} ${chalk.cyan(`appliance local install ${provider.name}`)}`);
      } else {
        // Detect-only providers (docker). Surface the upstream
        // install path so users have a copy-paste line for their
        // platform.
        const manual = provider.manualInstall({
          binDir: '',
          platform: process.platform as 'darwin' | 'linux' | 'win32',
          arch: (process.arch === 'arm64' ? 'arm64' : 'x64') as 'arm64' | 'x64',
        });
        for (const line of manual.instructions.split('\n')) {
          console.log(`    ${chalk.bold('Install:')} ${chalk.cyan(line)}`);
        }
        if (manual.url) console.log(`    ${chalk.dim(manual.url)}`);
      }
    }
  }
}

async function runWithLiveProgress(tools: string[], opts: { force: boolean; json: boolean }): Promise<void> {
  const targets = tools.length > 0 ? tools : undefined;
  const onProgress = (event: ProgressEvent) => {
    if (opts.json) {
      // Match the shape the desktop sidecar emits so the Rust-side
      // event channel can consume CLI-driven installs and sidecar-
      // driven installs interchangeably. `stage` carries the tool
      // name; `message` is the human-readable progress line.
      emitJson({ type: 'progress', stage: event.tool, message: event.message });
      return;
    }
    const prefix = event.type === 'error' ? chalk.red('✗') : event.type === 'done' ? chalk.green('✓') : chalk.cyan('»');
    console.log(`${prefix} ${chalk.dim(event.tool)} ${event.message}`);
  };
  const outcomes = await runInstall({ tools: targets, force: opts.force, onProgress });

  if (opts.json) {
    emitJson({
      type: 'result',
      result: {
        outcomes: outcomes.map((o) => ({
          tool: o.provider.name,
          description: o.provider.description,
          autoInstallable: o.provider.autoInstallable,
          required: o.provider.required,
          status: o.status,
          message: o.message,
        })),
      },
    });
    if (outcomes.some((o) => o.status === 'failed')) process.exit(1);
    return;
  }

  console.log();
  let anyFailed = false;
  let anyGuidance = false;
  for (const o of outcomes) {
    const tag =
      o.status === 'installed'
        ? chalk.green('installed  ')
        : o.status === 'already'
          ? chalk.dim('already    ')
          : o.status === 'failed'
            ? chalk.red('failed     ')
            : chalk.yellow('manual     ');
    console.log(`${tag} ${chalk.bold(o.provider.name)}`);
    if (o.status !== 'already') {
      for (const line of o.message.split('\n')) {
        console.log(`    ${chalk.dim(line)}`);
      }
    }
    if (o.status === 'failed') anyFailed = true;
    if (o.status === 'guidance') anyGuidance = true;
  }

  if (anyGuidance) {
    console.log();
    console.log(
      chalk.yellow(
        'Some tools require a manual install (typically Docker). Follow the link above, then re-run `appliance local status`.'
      )
    );
  }
  if (anyFailed) {
    console.log();
    console.log(chalk.red('One or more installs failed. See the error above.'));
    process.exit(1);
  }
}

/** NDJSON emitter: one JSON object per line on stdout. */
function emitJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** Report a thrown error in the form matching `--json` (or plain text). */
function reportError(err: unknown, json: boolean): void {
  const message = err instanceof Error ? err.message : String(err);
  if (json) {
    emitJson({ type: 'error', error: message });
  } else {
    console.error(chalk.red(message));
  }
  process.exit(1);
}
