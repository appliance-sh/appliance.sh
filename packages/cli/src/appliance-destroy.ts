import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import { createApplianceClient, DeploymentStatus } from '@appliance.sh/sdk';
import type { Project, Environment, Deployment } from '@appliance.sh/sdk';
import { loadCredentials } from './utils/credentials.js';
import { attachProfileOption } from './utils/profile-flag.js';
import { readLink } from './utils/link.js';
import { pollDeploymentUntilDone } from './utils/deploy-poll.js';
import { startProgressLine, BRAND } from './utils/progress.js';
import chalk from 'chalk';

async function findProject(client: ReturnType<typeof createApplianceClient>, name: string): Promise<Project> {
  const listResult = await client.listProjects();
  if (!listResult.success) throw new Error(`Failed to list projects: ${listResult.error.message}`);

  const existing = listResult.data.find((p) => p.name === name);
  if (!existing) throw new Error(`Project "${name}" not found.`);
  console.log(chalk.dim(`Found project: ${existing.id}`));
  return existing;
}

async function findEnvironment(
  client: ReturnType<typeof createApplianceClient>,
  projectId: string,
  name: string
): Promise<Environment> {
  const listResult = await client.listEnvironments(projectId);
  if (!listResult.success) throw new Error(`Failed to list environments: ${listResult.error.message}`);

  const existing = listResult.data.find((e) => e.name === name);
  if (!existing) throw new Error(`Environment "${name}" not found.`);
  console.log(chalk.dim(`Found environment: ${existing.id}`));
  return existing;
}

function formatStatus(d: Deployment): string {
  const base = chalk.dim(d.status);
  return d.message ? `${base} ${chalk.dim('—')} ${d.message}` : base;
}

function printFinalBanner(deployment: Deployment, projectName: string, environmentName: string): void {
  console.log();
  if (deployment.status === DeploymentStatus.Succeeded) {
    console.log(`${chalk.green(BRAND)} ${chalk.bold('Destroyed')} ${projectName}/${environmentName}`);
  } else if (deployment.status === DeploymentStatus.Cancelled) {
    console.log(`${chalk.yellow(BRAND)} ${chalk.bold('Cancelled')} ${projectName}/${environmentName}`);
    if (deployment.message) console.log(`  ${deployment.message}`);
  } else {
    console.log(`${chalk.red(BRAND)} ${chalk.bold('Failed')} ${projectName}/${environmentName}`);
    if (deployment.message) console.log(`  ${deployment.message}`);
  }
  console.log(`  ${chalk.dim('deployment')} ${deployment.id}`);
}

const program = new Command();

attachProfileOption(program);

program
  .description('destroy the linked (or named) project/environment')
  .argument('[project]', 'project name (defaults to the linked project)')
  .argument('[environment]', 'environment name (defaults to the linked environment)')
  .option('-y, --yes', 'skip confirmation prompt', false)
  .action(async (cliProject: string | undefined, cliEnvironment: string | undefined) => {
    const opts = program.opts<{ yes: boolean }>();

    const credentials = loadCredentials();
    if (!credentials) {
      console.error(chalk.red('Not logged in. Run `appliance login` first.'));
      process.exit(1);
    }

    const link = readLink();
    const projectName = cliProject ?? link?.projectName;
    const environmentName = cliEnvironment ?? link?.environmentName;
    if (!projectName || !environmentName) {
      console.error(
        chalk.red(
          'No target to destroy. Pass `<project> <environment>` or run `appliance setup` / `appliance link` to link this folder.'
        )
      );
      process.exit(1);
    }

    const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!opts.yes && isTTY) {
      const ok = await confirm({
        message: `Destroy ${chalk.bold(projectName)}/${chalk.bold(environmentName)}? This tears down its stack.`,
        default: false,
      });
      if (!ok) {
        console.log(chalk.dim('Cancelled.'));
        return;
      }
    }

    const client = createApplianceClient({
      baseUrl: credentials.apiUrl,
      credentials: { keyId: credentials.keyId, secret: credentials.secret },
    });

    try {
      const project = await findProject(client, projectName);
      const environment = await findEnvironment(client, project.id, environmentName);

      const result = await client.destroy(environment.id);
      if (!result.success) {
        console.error(chalk.red(`Destroy failed: ${result.error.message}`));
        process.exit(1);
      }

      const progress = startProgressLine(`Destroying ${projectName}/${environmentName} — pending`);
      let finalDeployment: Deployment;
      try {
        const { deployment } = await pollDeploymentUntilDone(client, result.data.id, {
          onProgress: (d) => progress.update(`Destroying ${projectName}/${environmentName} — ${formatStatus(d)}`),
        });
        finalDeployment = deployment;
        progress.clear();
      } catch (err) {
        progress.fail(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      printFinalBanner(finalDeployment, projectName, environmentName);

      if (finalDeployment.status !== DeploymentStatus.Succeeded) {
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

program.parse(process.argv);
