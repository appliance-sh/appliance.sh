import { Command } from 'commander';
import { createApplianceClient } from '@appliance.sh/sdk';
import type { Project, Environment } from '@appliance.sh/sdk';
import { loadCredentials } from './utils/credentials.js';
import chalk from 'chalk';

const POLL_INTERVAL_MS = 3000;

async function findOrCreateProject(client: ReturnType<typeof createApplianceClient>, name: string): Promise<Project> {
  const listResult = await client.listProjects();
  if (!listResult.success) throw new Error(`Failed to list projects: ${listResult.error.message}`);

  const existing = listResult.data.find((p) => p.name === name);
  if (existing) {
    console.log(chalk.dim(`Using existing project: ${existing.id}`));
    return existing;
  }

  const createResult = await client.createProject({ name });
  if (!createResult.success) throw new Error(`Failed to create project: ${createResult.error.message}`);
  console.log(chalk.green(`Created project: ${createResult.data.id}`));
  return createResult.data;
}

async function findOrCreateEnvironment(
  client: ReturnType<typeof createApplianceClient>,
  projectId: string,
  projectName: string,
  name: string
): Promise<Environment> {
  const expectedStackName = `${projectName}-${name}`;
  const listResult = await client.listEnvironments(projectId);
  if (!listResult.success) throw new Error(`Failed to list environments: ${listResult.error.message}`);

  const existing = listResult.data.find((e) => e.name === name);
  if (existing) {
    if (existing.stackName === expectedStackName) {
      console.log(chalk.dim(`Using existing environment: ${existing.id}`));
      return existing;
    }
    console.log(chalk.yellow(`Replacing environment with stale stack name: ${existing.stackName}`));
    await client.deleteEnvironment(projectId, existing.id);
  }

  const createResult = await client.createEnvironment({ name, projectId });
  if (!createResult.success) throw new Error(`Failed to create environment: ${createResult.error.message}`);
  console.log(chalk.green(`Created environment: ${createResult.data.id} (stack: ${createResult.data.stackName})`));
  return createResult.data;
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
      console.log(chalk.green('Deployment succeeded.'));
      console.log(JSON.stringify(status.data, null, 2));
      return;
    }
    if (deployStatus === 'failed') {
      console.error(chalk.red(`Deployment failed: ${message ?? 'unknown error'}`));
      process.exit(1);
    }
  }
}

const program = new Command();

program
  .description('deploy a named project/environment')
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
      const project = await findOrCreateProject(client, projectName);
      const environment = await findOrCreateEnvironment(client, project.id, projectName, environmentName);

      console.log(chalk.dim(`Deploying ${projectName}/${environmentName}...`));
      const result = await client.deploy(environment.id);
      if (!result.success) {
        console.error(chalk.red(`Deploy failed: ${result.error.message}`));
        process.exit(1);
      }

      console.log(chalk.dim(`Deployment started: ${result.data.id}`));
      await pollDeployment(client, result.data.id);
    } catch (error) {
      console.error(chalk.red(String(error)));
      process.exit(1);
    }
  });

program.parse(process.argv);
