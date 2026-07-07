import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { createApplianceClient, DeploymentStatus } from '@appliance.sh/sdk';
import { loadCredentials, getActiveProfileOverride } from './utils/credentials.js';
import { attachProfileOption } from './utils/profile-flag.js';
import { resolveEnvironment } from './utils/deployment-target.js';
import { ClusterTargetError, kubectlBaseArgs, resolveClusterTarget, stackSelector } from './utils/cluster-target.js';
import { summarizeDeploymentHealth, type DeploymentHealth, type PodHealth, type RawPod } from './utils/pod-health.js';
import { printCliError } from './utils/errors.js';
import chalk from 'chalk';

const CANCEL_POLL_INTERVAL_MS = 2000;
const CANCEL_POLL_TIMEOUT_MS = 5 * 60 * 1000;

function requireClient() {
  const credentials = loadCredentials();
  if (!credentials) {
    console.error(chalk.red('Not logged in. Run `appliance login` first.'));
    process.exit(1);
  }
  return createApplianceClient({
    baseUrl: credentials.apiUrl,
    credentials: { keyId: credentials.keyId, secret: credentials.secret },
  });
}

// Resolve a project + environment name pair to an environment ID.
// Throws with a clear message if either name is not found.
async function resolveEnvironmentId(
  client: ReturnType<typeof createApplianceClient>,
  projectName: string,
  environmentName: string
): Promise<string> {
  const projects = await client.listProjects();
  if (!projects.success) throw new Error(`Failed to list projects: ${projects.error.message}`);
  const project = projects.data.find((p) => p.name === projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  const envs = await client.listEnvironments(project.id);
  if (!envs.success) throw new Error(`Failed to list environments: ${envs.error.message}`);
  const env = envs.data.find((e) => e.name === environmentName);
  if (!env) throw new Error(`Environment not found: ${projectName}/${environmentName}`);
  return env.id;
}

// Resolve a project + environment name pair to the deployment ID
// of the newest non-terminal deployment in that environment. Throws
// with a clear message if anything along the chain isn't found.
// Used by `appliance deployment cancel <project> <environment>`.
async function resolveInFlightDeployment(
  client: ReturnType<typeof createApplianceClient>,
  projectName: string,
  environmentName: string
): Promise<string> {
  const environmentId = await resolveEnvironmentId(client, projectName, environmentName);
  const deployments = await client.listDeployments({ environmentId, limit: 50 });
  if (!deployments.success) throw new Error(`Failed to list deployments: ${deployments.error.message}`);

  // listDeployments returns startedAt-descending, so the newest
  // non-terminal record is the one we want. Pending, InProgress,
  // and Cancelling all qualify (Cancelling re-cancel is a no-op
  // server-side, which is fine).
  const inFlight = deployments.data.find(
    (d) =>
      d.status === DeploymentStatus.Pending ||
      d.status === DeploymentStatus.InProgress ||
      d.status === DeploymentStatus.Cancelling
  );
  if (!inFlight) {
    throw new Error(`No in-flight deployment for ${projectName}/${environmentName}.`);
  }
  return inFlight.id;
}

const program = new Command();

attachProfileOption(program);

program.description('manage deployments');

// --- appliance deployment status <id> ---
program
  .command('status')
  .description('check deployment status')
  .argument('<deployment-id>', 'deployment ID')
  .action(async (deploymentId: string) => {
    const client = requireClient();

    try {
      const result = await client.getDeployment(deploymentId);
      if (!result.success) {
        console.error(chalk.red(`Failed to get deployment: ${result.error.message}`));
        process.exit(1);
      }

      const d = result.data;
      const statusColor = d.status === 'succeeded' ? chalk.green : d.status === 'failed' ? chalk.red : chalk.yellow;

      console.log(chalk.bold('Deployment'));
      console.log(`  ID:          ${d.id}`);
      console.log(`  Action:      ${d.action}`);
      console.log(`  Status:      ${statusColor(d.status)}`);
      console.log(`  Started:     ${d.startedAt}`);
      if (d.completedAt) {
        console.log(`  Completed:   ${d.completedAt}`);
      }
      if (d.message) {
        console.log(`  Message:     ${d.message}`);
      }
      if (d.idempotentNoop) {
        console.log(chalk.dim('  (no changes needed)'));
      }
    } catch (error) {
      printCliError(error);
    }
  });

// --- appliance deployment cancel <id-or-project> [environment] ---
program
  .command('cancel')
  .description('cancel an in-flight deployment (worker calls stack.cancel + refresh)')
  .argument('<id-or-project>', 'deployment ID, or project name (paired with <environment>)')
  .argument('[environment]', 'environment name (resolves the latest in-flight deployment for this project/env)')
  .option('--no-wait', "don't poll for terminal status; exit after cancel is accepted")
  .option(
    '--force',
    'bypass worker cooperation; mark deployment Cancelled immediately. The deployment record may be left out of sync — run `appliance deployment refresh <project> <env>` after to reconcile.',
    false
  )
  .action(async (idOrProject: string, environmentName: string | undefined, opts: { wait: boolean; force: boolean }) => {
    const client = requireClient();

    let deploymentId: string;
    if (environmentName) {
      try {
        deploymentId = await resolveInFlightDeployment(client, idOrProject, environmentName);
      } catch (err) {
        printCliError(err);
        process.exit(1);
      }
      console.log(chalk.dim(`Resolved ${idOrProject}/${environmentName} → ${deploymentId}`));
    } else {
      deploymentId = idOrProject;
    }

    if (opts.force) {
      console.warn(
        chalk.yellow(
          '⚠  --force bypasses the worker, so the deployment record may end up out of sync with what is actually running; ' +
            'run `appliance deployment refresh <project> <env>` afterwards to reconcile.'
        )
      );
    }

    const cancelResult = await client.cancelDeployment(deploymentId, { force: opts.force });
    if (!cancelResult.success) {
      console.error(chalk.red(`Failed to cancel deployment: ${cancelResult.error.message}`));
      process.exit(1);
    }

    const initial = cancelResult.data;
    if (
      initial.status === DeploymentStatus.Succeeded ||
      initial.status === DeploymentStatus.Failed ||
      initial.status === DeploymentStatus.Cancelled
    ) {
      // Force cancel always lands here (terminal Cancelled written
      // server-side immediately); cooperative cancel only when the
      // op finished naturally between request and dispatch.
      const color = initial.status === DeploymentStatus.Succeeded ? chalk.green : chalk.yellow;
      console.log(color(`Deployment ${initial.status}.`));
      if (initial.message) console.log(initial.message);
      return;
    }

    console.log(chalk.dim(`Cancellation requested. Status: ${initial.status}`));

    if (!opts.wait) return;

    const deadline = Date.now() + CANCEL_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, CANCEL_POLL_INTERVAL_MS));
      const status = await client.getDeployment(deploymentId);
      if (!status.success) {
        console.error(chalk.red(`Failed to poll deployment: ${status.error.message}`));
        process.exit(1);
      }

      const d = status.data;
      console.log(chalk.dim(`  status: ${d.status}${d.message ? ` — ${d.message}` : ''}`));

      // Terminal states the worker may settle into. If the operation
      // finished naturally before the cancel was observed, that's
      // succeeded/failed; if cancel was honored, it's cancelled.
      if (
        d.status === DeploymentStatus.Cancelled ||
        d.status === DeploymentStatus.Succeeded ||
        d.status === DeploymentStatus.Failed
      ) {
        const color =
          d.status === DeploymentStatus.Cancelled
            ? chalk.yellow
            : d.status === DeploymentStatus.Succeeded
              ? chalk.green
              : chalk.red;
        console.log(color(`Deployment ${d.status}.`));
        if (d.message) console.log(d.message);
        return;
      }
    }

    console.error(chalk.red(`Timed out waiting for deployment to settle. Last known status: cancelling.`));
    process.exit(1);
  });

// --- appliance deployment refresh <project> <environment> ---
program
  .command('refresh')
  .description('reconcile the stored deployment state with what is actually running in the cloud')
  .argument('<project>', 'project name')
  .argument('<environment>', 'environment name')
  .option('--no-wait', "don't poll for terminal status; exit after refresh is dispatched")
  .action(async (projectName: string, environmentName: string, opts: { wait: boolean }) => {
    const client = requireClient();

    let environmentId: string;
    try {
      environmentId = await resolveEnvironmentId(client, projectName, environmentName);
    } catch (err) {
      printCliError(err);
      process.exit(1);
    }

    const refreshResult = await client.refresh(environmentId);
    if (!refreshResult.success) {
      console.error(chalk.red(`Failed to start refresh: ${refreshResult.error.message}`));
      process.exit(1);
    }

    const initial = refreshResult.data;
    console.log(chalk.dim(`Refresh started: ${initial.id}`));

    if (!opts.wait) return;

    const deadline = Date.now() + CANCEL_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, CANCEL_POLL_INTERVAL_MS));
      const status = await client.getDeployment(initial.id);
      if (!status.success) {
        console.error(chalk.red(`Failed to poll deployment: ${status.error.message}`));
        process.exit(1);
      }

      const d = status.data;
      console.log(chalk.dim(`  status: ${d.status}${d.message ? ` — ${d.message}` : ''}`));

      if (
        d.status === DeploymentStatus.Succeeded ||
        d.status === DeploymentStatus.Failed ||
        d.status === DeploymentStatus.Cancelled
      ) {
        const color =
          d.status === DeploymentStatus.Succeeded
            ? chalk.green
            : d.status === DeploymentStatus.Cancelled
              ? chalk.yellow
              : chalk.red;
        console.log(color(`Refresh ${d.status}.`));
        if (d.message) console.log(d.message);
        if (d.status !== DeploymentStatus.Succeeded) process.exit(1);
        return;
      }
    }

    console.error(chalk.red(`Timed out waiting for refresh to settle.`));
    process.exit(1);
  });

// --- appliance deployment health <project> <environment> ---
// Pod-level readiness + restart state for a running deployment on a
// local engine. The api-server tracks Pulumi-op status (succeeded /
// failed), but not the *runtime* health of the workload it scheduled —
// a deploy can succeed and then crashloop. We read that straight from
// the cluster via kubectl, selecting the deployment's pods by their
// stack-name label.
program
  .command('health')
  .description("show a deployment's pod readiness and restart state (local engines)")
  .argument('<project>', 'project name')
  .argument('<environment>', 'environment name')
  .option('-n, --namespace <ns>', 'kubernetes namespace (defaults to the appliance namespace)')
  .option('--kubeconfig <path>', 'explicit kubeconfig (overrides the profile-derived cluster)')
  .option('--context <name>', 'explicit kubectl context (overrides the profile-derived cluster)')
  .option('--json', 'print the raw health summary as JSON', false)
  .action(
    async (
      projectName: string,
      environmentName: string,
      opts: { namespace?: string; kubeconfig?: string; context?: string; json: boolean }
    ) => {
      const client = requireClient();

      let stackName: string;
      try {
        const env = await resolveEnvironment(client, projectName, environmentName);
        stackName = env.stackName;
      } catch (err) {
        printCliError(err);
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
            chalk.dim('Pod health reads from a local engine. For a remote/cloud deployment, use the Appliance Console.')
          );
          process.exit(1);
        }
        throw err;
      }

      const r = spawnSync(
        'kubectl',
        [...kubectlBaseArgs(target), 'get', 'pods', '--selector', stackSelector(stackName), '-o', 'json'],
        { encoding: 'utf8' }
      );
      if (r.error) {
        const code = (r.error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          console.error(
            chalk.red('kubectl not found on PATH. Install it (e.g. `brew install kubernetes-cli`), then retry.')
          );
          process.exit(1);
        }
        console.error(chalk.red(`Failed to run kubectl: ${r.error.message}`));
        process.exit(1);
      }
      if (r.status !== 0) {
        console.error(chalk.red(`kubectl get pods failed: ${(r.stderr ?? '').trim() || `exit ${r.status}`}`));
        process.exit(1);
      }

      let items: RawPod[];
      try {
        const parsed = JSON.parse(r.stdout) as { items?: RawPod[] };
        items = parsed.items ?? [];
      } catch (err) {
        console.error(chalk.red(`Failed to parse kubectl output: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }

      const health = summarizeDeploymentHealth(items);

      if (opts.json) {
        console.log(
          JSON.stringify({ project: projectName, environment: environmentName, stackName, ...health }, null, 2)
        );
        process.exit(health.healthy ? 0 : 1);
      }

      printHealth(projectName, environmentName, stackName, target.source, health);
      // Non-zero exit when unhealthy so the command is usable as a CI
      // readiness gate.
      process.exit(health.healthy ? 0 : 1);
    }
  );

function printHealth(
  projectName: string,
  environmentName: string,
  stackName: string,
  source: string,
  health: DeploymentHealth
): void {
  console.log(chalk.bold(`${projectName}/${environmentName}`) + chalk.dim(` (stack ${stackName}, ${source})`));
  if (health.total === 0) {
    console.log(chalk.yellow('  No pods found.'));
    console.log(
      chalk.dim(
        '  The deployment may not be running, or this profile may point at a different cluster ' +
          '(use --profile, --kubeconfig, or --context).'
      )
    );
    return;
  }

  const overall = health.healthy ? chalk.green('healthy') : chalk.yellow('degraded');
  console.log(
    `  Overall:   ${overall} ${chalk.dim(`(${health.ready}/${health.total} pods ready, ${health.restarts} restarts)`)}`
  );
  console.log(chalk.bold('  Pods'));
  for (const pod of health.pods) {
    console.log(`    ${podMarker(pod)} ${chalk.bold(pod.name)} ${chalk.dim(`${pod.phase} · ${pod.readyRatio} ready`)}`);
    for (const c of pod.containers) {
      const cMarker = c.ready ? chalk.green('●') : chalk.red('●');
      const restartNote = c.restarts > 0 ? chalk.yellow(` · ${c.restarts} restart${c.restarts === 1 ? '' : 's'}`) : '';
      const reasonNote = c.reason ? chalk.red(` · ${c.reason}`) : '';
      console.log(`      ${cMarker} ${c.name}${restartNote}${reasonNote}`);
    }
  }
}

function podMarker(pod: PodHealth): string {
  if (pod.ready) return chalk.green('●');
  if (pod.restarts > 0 || pod.containers.some((c) => c.reason)) return chalk.red('●');
  return chalk.yellow('●');
}

program.parse(process.argv);
