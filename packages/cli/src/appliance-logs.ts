import { Command } from 'commander';
import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import { createApplianceClient } from '@appliance.sh/sdk';
import { ensureHelperBinOnPath } from '@appliance.sh/helper';
import { loadCredentials, getActiveProfileOverride } from './utils/credentials.js';
import { attachProfileOption } from './utils/profile-flag.js';
import { readLink, readSandboxLink } from './utils/link.js';
import { vmShell } from './utils/sandbox.js';
import { resolveEnvironment } from './utils/deployment-target.js';
import { ClusterTargetError, kubectlBaseArgs, resolveClusterTarget, stackSelector } from './utils/cluster-target.js';

// `appliance logs <project> <environment>` — stream container logs for
// the active deployment's pods on a local engine (microVM or k3d).
//
// The api-server schedules each environment as a Deployment whose pods
// carry `app.kubernetes.io/name: <stackName>`. We resolve the
// environment's stackName via the SDK, resolve the cluster's kubeconfig
// / context from the active profile (the same on-disk layout `appliance
// vm` / `appliance local` use), then drive `kubectl logs -l <selector>`
// — inheriting kubectl's streaming, `--follow`, and multi-pod fan-out
// for free rather than reimplementing a log multiplexer over the SDK
// (which exposes no log endpoint today).

ensureHelperBinOnPath();

const program = new Command();

attachProfileOption(program);

program
  .description("stream a deployment's container logs (local engines)")
  .argument('[project]', 'project name (defaults to the linked project)')
  .argument('[environment]', 'environment name (defaults to the linked environment)')
  .option('-f, --follow', 'stream new logs as they arrive (kubectl -f)', false)
  .option('-n, --namespace <ns>', 'kubernetes namespace (defaults to the appliance namespace)')
  .option('--tail <lines>', 'number of recent lines to show per container (default: 200)', '200')
  .option('--since <duration>', 'only logs newer than this (e.g. 10m, 1h)')
  .option('-c, --container <name>', 'container to read from (default: all containers in the pod)')
  .option('-p, --previous', "read logs from the pod's previous (crashed) container instance", false)
  .option('--timestamps', 'prefix every line with an RFC3339 timestamp', false)
  .option('--kubeconfig <path>', 'explicit kubeconfig (overrides the profile-derived cluster)')
  .option('--context <name>', 'explicit kubectl context (overrides the profile-derived cluster)')
  .action(async (cliProject: string | undefined, cliEnvironment: string | undefined) => {
    const opts = program.opts<{
      follow: boolean;
      namespace?: string;
      tail: string;
      since?: string;
      container?: string;
      previous: boolean;
      timestamps: boolean;
      kubeconfig?: string;
      context?: string;
    }>();

    // Route by link.json (docs/up.md §2): an `appliance up` folder logs
    // its sandbox container via the in-guest docker engine. Only when no
    // explicit api-server `<project> <environment>` target was passed —
    // that always means the deployment-logs path below.
    const sandbox = readSandboxLink();
    if (sandbox && !cliProject && !cliEnvironment) {
      const args = ['docker', 'logs', '--tail', opts.tail];
      if (opts.follow) args.push('-f');
      args.push(sandbox.project);
      console.error(
        chalk.dim(
          `Streaming logs for sandbox ${chalk.bold(sandbox.project)} (${sandbox.vm})${
            opts.follow ? ' — Ctrl-C to stop' : ''
          }`
        )
      );
      process.exit(vmShell(sandbox.vm, args));
    }

    const credentials = loadCredentials();
    if (!credentials) {
      console.error(chalk.red('Not logged in. Run `appliance login` first.'));
      process.exit(1);
    }

    // Fall back to the cwd link so `appliance logs` works with no args
    // from a linked project directory, matching `deploy` / `open`.
    const link = readLink();
    const projectName = cliProject ?? link?.projectName;
    const environmentName = cliEnvironment ?? link?.environmentName;
    if (!projectName || !environmentName) {
      console.error(
        chalk.red(
          'No target. Pass `<project> <environment>` or run `appliance setup` / `appliance link` to link this folder.'
        )
      );
      process.exit(1);
    }

    const client = createApplianceClient({
      baseUrl: credentials.apiUrl,
      credentials: { keyId: credentials.keyId, secret: credentials.secret },
    });

    let stackName: string;
    try {
      const env = await resolveEnvironment(client, projectName, environmentName);
      stackName = env.stackName;
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }

    let target;
    try {
      target = resolveClusterTarget({
        profile: getActiveProfileOverride() ?? process.env.APPLIANCE_PROFILE,
        kubeconfig: opts.kubeconfig,
        context: opts.context,
        namespace: opts.namespace,
      });
    } catch (err) {
      if (err instanceof ClusterTargetError) {
        console.error(chalk.red(err.message));
        console.error(
          chalk.dim(
            'Logs stream from a local engine. For a remote/cloud deployment, view logs in the Appliance Console.'
          )
        );
        process.exit(1);
      }
      throw err;
    }

    const selector = stackSelector(stackName);
    const args = [
      ...kubectlBaseArgs(target),
      'logs',
      '--selector',
      selector,
      '--tail',
      opts.tail,
      // Prefix each line with its pod name so a multi-pod / multi-replica
      // stream stays legible.
      '--prefix',
      '--max-log-requests',
      '20',
    ];
    if (opts.follow) args.push('--follow');
    if (opts.since) args.push('--since', opts.since);
    if (opts.previous) args.push('--previous');
    if (opts.timestamps) args.push('--timestamps');
    if (opts.container) {
      args.push('--container', opts.container);
    } else {
      // Default to every container in the matched pods so sidecars (and
      // future multi-container workloads) aren't silently dropped.
      args.push('--all-containers');
    }

    console.error(
      chalk.dim(
        `Streaming logs for ${chalk.bold(`${projectName}/${environmentName}`)} ` +
          `(stack ${stackName}, ${target.source})${opts.follow ? ' — Ctrl-C to stop' : ''}`
      )
    );

    const r = spawnSync('kubectl', args, { stdio: 'inherit' });
    if (r.error) {
      const code = (r.error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        console.error(chalk.red('kubectl not found on PATH. Install it (e.g. `appliance local install kubectl`).'));
        process.exit(1);
      }
      console.error(chalk.red(`Failed to run kubectl: ${r.error.message}`));
      process.exit(1);
    }
    // kubectl exits non-zero when the selector matched no pods. Translate
    // that into an actionable hint instead of a bare exit code.
    if (r.status !== 0) {
      console.error(
        chalk.yellow(
          `No logs for ${projectName}/${environmentName}. ` +
            'The deployment may not be running, or this profile may point at a different cluster ' +
            '(use --profile, --kubeconfig, or --context).'
        )
      );
    }
    process.exit(r.status ?? 1);
  });

program.parse(process.argv);
