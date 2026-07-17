import { Command } from 'commander';
import chalk from 'chalk';
import { ensureHelperBinOnPath } from '@appliance.sh/helper';
import { runFixes, runPreflight } from './utils/preflight.js';
import type { CheckResult, FixOutcome, PreflightReport } from './utils/preflight.js';
import { runRuntimeDoctor } from './utils/runtime-doctor.js';
import type { RuntimeDoctorReport, RuntimeFinding, RuntimeFixOutcome } from './utils/runtime-doctor.js';
import { writeSupportBundle } from './utils/doctor-bundle.js';
import { DEFAULT_VM_NAME } from './utils/microvm-up.js';

// `appliance doctor` — reliability diagnostics in two sections:
//
//   Preflight: can a fresh machine run an Appliance runtime? (container
//   runtime, helper binaries, toolchains, free ports, macOS signing.)
//
//   Runtime: why doesn't the ALREADY-SET-UP runtime work? Dead/unknown
//   API keys (the opaque-401 class), guest clock skew, orphaned or
//   cross-wired credential profiles, duplicate ingress claims, stale
//   guest binaries, profiles↔Keychain drift.
//
// Exits non-zero when any hard check fails so it slots into CI and
// pre-deploy gates. The checks live in utils/preflight.ts and
// utils/runtime-doctor.ts so the desktop sidecar and other surfaces can
// reuse the same verdicts; this file is only the CLI presentation +
// the `--fix` driver.

ensureHelperBinOnPath();

const program = new Command();

program
  .description('run preflight + runtime diagnostics and print a pass/fail checklist with remediations')
  .option('--fix', 'auto-resolve the checks doctor can safely fix (pull binaries, re-mint a dead key, …)', false)
  .option('--json', 'emit the report as JSON instead of a checklist', false)
  .option('--vm <name>', 'microVM whose runtime to diagnose', DEFAULT_VM_NAME)
  .option(
    '--bundle [path]',
    'also write a REDACTED support tarball (report + env + VM state + scrubbed log tails; no secrets)'
  )
  .action(async (opts: { fix: boolean; json: boolean; vm: string; bundle?: string | boolean }) => {
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

    // An IMPLICIT default-VM run (no --vm) must not fail a machine that
    // has never created a Dev Machine; an explicit --vm keeps the hard
    // "VM does not exist" verdict.
    const vmExplicit = program.getOptionValueSource('vm') !== 'default';
    const runtime = await runRuntimeDoctor({ vm: opts.vm, vmExplicit, fix: opts.fix });

    if (opts.json) {
      printJson(report, fixes, runtime);
    } else {
      printChecklist(report, fixes, runtime);
    }

    if (opts.bundle !== undefined && opts.bundle !== false) {
      try {
        const tarball = await writeSupportBundle({
          vm: opts.vm,
          report: reportJson(report, fixes, runtime),
          ...(typeof opts.bundle === 'string' ? { outPath: opts.bundle } : {}),
        });
        console.log();
        console.log(`${chalk.green('✓')} support bundle written to ${chalk.bold(tarball)}`);
        console.log(
          chalk.dim(
            '  redacted: no API secrets, bootstrap tokens, captured credentials, or kubeconfig certs are included'
          )
        );
      } catch (err) {
        console.error(chalk.red(`support bundle failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    }

    if (!report.ok || !runtime.ok) process.exit(1);
  });

program.parse(process.argv);

// ---- rendering ----------------------------------------------------------

function marker(status: CheckResult['status'] | RuntimeFinding['severity']): string {
  if (status === 'pass' || status === 'ok') return chalk.green('✓');
  if (status === 'warn') return chalk.yellow('!');
  if (status === 'info') return chalk.cyan('i');
  return chalk.red('✗');
}

function fixTag(status: 'fixed' | 'failed' | 'skipped'): string {
  return status === 'fixed'
    ? chalk.green('fixed  ')
    : status === 'failed'
      ? chalk.red('failed ')
      : chalk.yellow('skipped');
}

function printChecklist(report: PreflightReport, fixes: FixOutcome[], runtime: RuntimeDoctorReport): void {
  console.log(chalk.bold('Appliance doctor'));
  console.log();
  console.log(chalk.bold('Preflight (can this machine run Appliance?)'));

  for (const result of report.results) {
    const detail = result.detail ? chalk.dim(` — ${result.detail}`) : '';
    console.log(`${marker(result.status)} ${result.label}${detail}`);
    if (result.status !== 'pass' && result.remediation) {
      console.log(`    ${chalk.cyan('→')} ${result.remediation}`);
    }
  }

  console.log();
  console.log(chalk.bold(`Runtime (VM '${runtime.vm}')`));
  for (const finding of runtime.findings) {
    const detail = finding.detail ? chalk.dim(` — ${finding.detail}`) : '';
    const fixed = finding.fix?.applied ? chalk.green(' [fixed]') : '';
    console.log(`${marker(finding.severity)} ${finding.title}${detail}${fixed}`);
    if (finding.severity !== 'ok' && !finding.fix?.applied && finding.remediation) {
      console.log(`    ${chalk.cyan('→')} ${finding.remediation}`);
    }
  }

  const allFixes: Array<FixOutcome | RuntimeFixOutcome> = [...fixes, ...runtime.fixes];
  if (allFixes.length > 0) {
    console.log();
    console.log(chalk.bold('Fixes'));
    for (const fix of allFixes) {
      console.log(`${fixTag(fix.status)} ${fix.label} ${chalk.dim(`— ${fix.detail}`)}`);
    }
  }

  console.log();
  const combined = [
    ...report.results.map((r) => r.status as string),
    ...runtime.findings.map((f) => f.severity as string),
  ];
  const fails = combined.filter((s) => s === 'fail').length;
  const warns = combined.filter((s) => s === 'warn').length;
  if (fails === 0 && warns === 0) {
    console.log(chalk.green('All checks passed. This machine and its runtime look healthy.'));
  } else if (fails === 0) {
    console.log(chalk.yellow(`${warns} warning${warns === 1 ? '' : 's'} — non-blocking, but worth a look above.`));
  } else {
    const hint =
      !fixes.length && !runtime.fixes.length
        ? ' Re-run with `appliance doctor --fix` to auto-resolve the safe ones.'
        : '';
    console.log(
      chalk.red(
        `${fails} check${fails === 1 ? '' : 's'} failed${warns ? ` (and ${warns} warning${warns === 1 ? '' : 's'})` : ''}. Fix the items marked → above, then re-run.${hint}`
      )
    );
  }
}

function reportJson(report: PreflightReport, fixes: FixOutcome[], runtime: RuntimeDoctorReport): unknown {
  return {
    ok: report.ok && runtime.ok,
    checks: report.results,
    fixes,
    runtime,
  };
}

function printJson(report: PreflightReport, fixes: FixOutcome[], runtime: RuntimeDoctorReport): void {
  console.log(JSON.stringify(reportJson(report, fixes, runtime), null, 2));
}
