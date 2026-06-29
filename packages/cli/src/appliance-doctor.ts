import { Command } from 'commander';
import chalk from 'chalk';
import { ensureHelperBinOnPath } from '@appliance.sh/helper';
import { runFixes, runPreflight } from './utils/preflight.js';
import type { CheckResult, FixOutcome, PreflightReport } from './utils/preflight.js';

// `appliance doctor` — first-run reliability preflight. Probes every
// prerequisite a fresh machine needs to run an Appliance runtime
// (container runtime + daemon, helper binaries, build toolchains, free
// ports, a resolvable api-server image, macOS signing) and prints a
// pass/fail checklist where every failure carries its exact
// remediation. Exits non-zero when any hard check fails so it slots
// into CI and pre-deploy gates.
//
// The checks themselves live in utils/preflight.ts so the desktop
// sidecar and other surfaces can reuse the same verdicts; this file is
// only the CLI presentation + the `--fix` driver.

ensureHelperBinOnPath();

const program = new Command();

program
  .description('run first-run preflight checks and print a pass/fail checklist with remediations')
  .option('--fix', 'auto-resolve the checks doctor can safely fix (e.g. pull the api-server image)', false)
  .option('--json', 'emit the report as JSON instead of a checklist', false)
  .action(async (opts: { fix: boolean; json: boolean }) => {
    let report = await runPreflight();

    let fixes: FixOutcome[] = [];
    if (opts.fix) {
      fixes = await runFixes(report);
      // Re-run after fixes so the final report reflects the new state
      // (a pulled image flips from warn/fail to pass).
      if (fixes.some((f) => f.status === 'fixed')) {
        report = await runPreflight();
      }
    }

    if (opts.json) {
      printJson(report, fixes);
    } else {
      printChecklist(report, fixes);
    }

    if (!report.ok) process.exit(1);
  });

program.parse(process.argv);

// ---- rendering ----------------------------------------------------------

function marker(status: CheckResult['status']): string {
  if (status === 'pass') return chalk.green('✓');
  if (status === 'warn') return chalk.yellow('!');
  return chalk.red('✗');
}

function printChecklist(report: PreflightReport, fixes: FixOutcome[]): void {
  console.log(chalk.bold('Appliance doctor'));
  console.log();

  for (const result of report.results) {
    const detail = result.detail ? chalk.dim(` — ${result.detail}`) : '';
    console.log(`${marker(result.status)} ${result.label}${detail}`);
    if (result.status !== 'pass' && result.remediation) {
      console.log(`    ${chalk.cyan('→')} ${result.remediation}`);
    }
  }

  if (fixes.length > 0) {
    console.log();
    console.log(chalk.bold('Fixes'));
    for (const fix of fixes) {
      const tag =
        fix.status === 'fixed'
          ? chalk.green('fixed  ')
          : fix.status === 'failed'
            ? chalk.red('failed ')
            : chalk.yellow('skipped');
      console.log(`${tag} ${fix.label} ${chalk.dim(`— ${fix.detail}`)}`);
    }
  }

  console.log();
  const fails = report.results.filter((r) => r.status === 'fail').length;
  const warns = report.results.filter((r) => r.status === 'warn').length;
  if (fails === 0 && warns === 0) {
    console.log(chalk.green('All checks passed. This machine is ready to run Appliance.'));
  } else if (fails === 0) {
    console.log(chalk.yellow(`${warns} warning${warns === 1 ? '' : 's'} — non-blocking, but worth a look above.`));
  } else {
    const hint = report.results.some((r) => r.status !== 'pass' && r.remediation && !fixes.length)
      ? ' Re-run with `appliance doctor --fix` to auto-resolve the safe ones.'
      : '';
    console.log(
      chalk.red(
        `${fails} check${fails === 1 ? '' : 's'} failed${warns ? ` (and ${warns} warning${warns === 1 ? '' : 's'})` : ''}. Fix the items marked → above, then re-run.${hint}`
      )
    );
  }
}

function printJson(report: PreflightReport, fixes: FixOutcome[]): void {
  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        checks: report.results,
        fixes,
      },
      null,
      2
    )
  );
}
