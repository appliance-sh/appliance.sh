import { Command } from 'commander';
import chalk from 'chalk';
import { password } from '@inquirer/prompts';
import { createApplianceClient } from '@appliance.sh/sdk';
import type { Project, Environment } from '@appliance.sh/sdk';
import { loadCredentials } from './utils/credentials.js';
import { attachProfileOption } from './utils/profile-flag.js';
import { printCliError } from './utils/errors.js';

// `appliance env` — per-environment variables ("environment secrets").
//
// Unlike `appliance deploy --env-file`, which applies only to the single
// deploy that passed it, values set here are stored server-side on the
// environment and injected into *every* subsequent deploy. They persist
// across machines, CI, and the desktop. Per-deploy values (manifest /
// --env-file) still win over stored ones, so a stored secret is the
// baseline and a local override stays local.
//
// Values are write-only over the API: `list` returns key names only, and
// nothing ever prints a secret value.

function client() {
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

async function resolveProject(api: ReturnType<typeof createApplianceClient>, name: string): Promise<Project> {
  const result = await api.listProjects();
  if (!result.success) throw new Error(`Failed to list projects: ${result.error.message}`);
  const project = result.data.find((p) => p.name === name);
  if (!project) {
    throw new Error(`Project not found: ${name}. Run \`appliance deploy ${name} <env>\` to create it first.`);
  }
  return project;
}

async function resolveEnvironment(
  api: ReturnType<typeof createApplianceClient>,
  projectId: string,
  name: string
): Promise<Environment> {
  const result = await api.listEnvironments(projectId);
  if (!result.success) throw new Error(`Failed to list environments: ${result.error.message}`);
  const env = result.data.find((e) => e.name === name);
  if (!env) {
    throw new Error(`Environment not found: ${name}. Deploy it once to create it.`);
  }
  return env;
}

const program = new Command();

attachProfileOption(program);

program.description('manage per-environment variables injected at deploy time');

program
  .command('set <project> <environment> <key> [value]')
  .description('store (or update) a variable on an environment; omit <value> to be prompted (hidden input)')
  .action(async (projectName: string, environmentName: string, key: string, value: string | undefined) => {
    try {
      const api = client();
      const project = await resolveProject(api, projectName);
      const env = await resolveEnvironment(api, project.id, environmentName);

      // Prompting keeps the secret out of shell history / process args.
      const resolvedValue = value ?? (await password({ message: `Value for ${key} (hidden):`, mask: '*' }));

      const result = await api.setEnvVars(project.id, env.id, { [key]: resolvedValue });
      if (!result.success) {
        console.error(chalk.red(`Failed to set ${key}: ${result.error.message}`));
        process.exit(1);
      }
      // Never echo the value back.
      console.log(`${chalk.green('✓')} Set ${chalk.bold(key)} on ${projectName}/${environmentName}.`);
      console.log(chalk.dim('  Applied on the next deploy.'));
    } catch (err) {
      printCliError(err);
    }
  });

program
  .command('list <project> <environment>')
  .alias('ls')
  .description('list the variable names stored on an environment (values are never shown)')
  .action(async (projectName: string, environmentName: string) => {
    try {
      const api = client();
      const project = await resolveProject(api, projectName);
      const env = await resolveEnvironment(api, project.id, environmentName);

      const result = await api.listEnvVars(project.id, env.id);
      if (!result.success) {
        console.error(chalk.red(`Failed to list variables: ${result.error.message}`));
        process.exit(1);
      }
      if (result.data.keys.length === 0) {
        console.log(chalk.dim(`No variables set on ${projectName}/${environmentName}.`));
        return;
      }
      console.log(chalk.bold(`Variables on ${projectName}/${environmentName}:`));
      for (const key of result.data.keys) {
        console.log(`  ${key}`);
      }
    } catch (err) {
      printCliError(err);
    }
  });

program
  .command('unset <project> <environment> <key>')
  .alias('rm')
  .description('remove a variable from an environment')
  .action(async (projectName: string, environmentName: string, key: string) => {
    try {
      const api = client();
      const project = await resolveProject(api, projectName);
      const env = await resolveEnvironment(api, project.id, environmentName);

      const result = await api.unsetEnvVar(project.id, env.id, key);
      if (!result.success) {
        console.error(chalk.red(`Failed to unset ${key}: ${result.error.message}`));
        process.exit(1);
      }
      console.log(`${chalk.green('✓')} Removed ${chalk.bold(key)} from ${projectName}/${environmentName}.`);
      console.log(chalk.dim('  Applied on the next deploy.'));
    } catch (err) {
      printCliError(err);
    }
  });

program.parse(process.argv);
