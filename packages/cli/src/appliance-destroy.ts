import { Command } from 'commander';
import { createApplianceClient } from '@appliance.sh/sdk';
import type { Project, Environment } from '@appliance.sh/sdk';
import { loadCredentials } from './utils/credentials.js';
import chalk from 'chalk';

const POLL_INTERVAL_MS = 3000;

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

async function pollDeployment(client: ReturnType<typeof createApplianceClient>, deploymentId: string) {
  while (true) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const status = await client.getDeployment(deploymentId);
    if (!status.success) {
      console.error(chalk.red(`Failed to get deployment status: ${status.error.message}`));
      process.exit(1);
    }

    const { status: deployStatus, message } = status.data;
    console.log(chalk.dim(`  status: ${deployStatus}${message ? ` — ${message}` : ''}`));

    if (deployStatus === 'succeeded') {
      console.log(chalk.green('Destroy succeeded.'));
      console.log(JSON.stringify(status.data, null, 2));
      return;
    }
    if (deployStatus === 'failed') {
      console.error(chalk.red(`Destroy failed: ${message ?? 'unknown error'}`));
      process.exit(1);
    }
  }
}

const program = new Command();

program
  .description('destroy a named project/environment')
  .argument('<project>', 'project name')
  .argument('<environment>', 'environment name')
  .action(async (projectName: string, environmentName: string) => {
    const credentials = loadCredentials();
    if (!credentials) {
      console.error(chalk.red('Credentials not found. Run `appliance init` first.'));
      process.exit(1);
    }

    const client = createApplianceClient({
      baseUrl: credentials.apiUrl,
      credentials: { keyId: credentials.keyId, secret: credentials.secret },
    });

    try {
      const project = await findProject(client, projectName);
      const environment = await findEnvironment(client, project.id, environmentName);

      console.log(chalk.dim(`Destroying ${projectName}/${environmentName}...`));
      const result = await client.destroy(environment.id);
      if (!result.success) {
        console.error(chalk.red(`Destroy failed: ${result.error.message}`));
        process.exit(1);
      }

      console.log(chalk.dim(`Destroy deployment started: ${result.data.id}`));
      await pollDeployment(client, result.data.id);
    } catch (error) {
      console.error(chalk.red(String(error)));
      process.exit(1);
    }
  });

program.parse(process.argv);
