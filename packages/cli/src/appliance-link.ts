import { Command } from 'commander';
import { input, select } from '@inquirer/prompts';
import { createApplianceClient } from '@appliance.sh/sdk';
import { loadCredentials, getActiveProfileOverride } from './utils/credentials.js';
import { attachProfileOption } from './utils/profile-flag.js';
import { writeLink, readLink } from './utils/link.js';
import { printCliError } from './utils/errors.js';
import chalk from 'chalk';

const program = new Command();

attachProfileOption(program);

program
  .description('link this folder to a project/environment without deploying')
  .option('--project <name>', 'project name (skips the picker)')
  .option('--environment <name>', 'environment name (skips the picker)')
  .action(async () => {
    const opts = program.opts<{ project?: string; environment?: string }>();
    const credentials = loadCredentials();
    if (!credentials) {
      console.error(chalk.red('Not logged in. Run `appliance login` first.'));
      process.exit(1);
    }

    const client = createApplianceClient({
      baseUrl: credentials.apiUrl,
      credentials: { keyId: credentials.keyId, secret: credentials.secret },
    });

    try {
      // Resolve project — flag overrides picker. If a flag is given
      // but no project with that name exists, we don't create one
      // here (this is "link", not "setup"). Setup remains the path
      // for creating projects.
      const projectsResult = await client.listProjects();
      if (!projectsResult.success) throw new Error(`Failed to list projects: ${projectsResult.error.message}`);
      if (projectsResult.data.length === 0) {
        console.error(chalk.red('No projects on this server. Run `appliance setup` to create one.'));
        process.exit(1);
      }

      let projectName = opts.project;
      if (!projectName) {
        projectName = await select({
          message: 'Project:',
          choices: projectsResult.data.map((p) => ({ name: p.name, value: p.name })),
        });
      }
      const project = projectsResult.data.find((p) => p.name === projectName);
      if (!project) {
        console.error(chalk.red(`Project "${projectName}" not found on this server.`));
        process.exit(1);
      }

      const envsResult = await client.listEnvironments(project.id);
      if (!envsResult.success) throw new Error(`Failed to list environments: ${envsResult.error.message}`);

      let environmentName = opts.environment;
      if (!environmentName) {
        if (envsResult.data.length === 0) {
          environmentName = await input({
            message: 'Environment (will be created on next deploy):',
            default: 'production',
          });
        } else {
          environmentName = await select({
            message: 'Environment:',
            choices: [
              ...envsResult.data.map((e) => ({ name: `${e.name} (${e.status})`, value: e.name })),
              { name: '+ Type a new environment name', value: '__new__' },
            ],
          });
          if (environmentName === '__new__') {
            environmentName = await input({ message: 'Environment name:', default: 'production' });
          }
        }
      }

      const existing = readLink();
      const linkPath = writeLink({
        projectName,
        environmentName,
        apiUrl: credentials.apiUrl,
        profile: getActiveProfileOverride() ?? process.env.APPLIANCE_PROFILE ?? undefined,
      });

      if (existing) {
        console.log(
          chalk.dim(
            `Replaced link (${existing.projectName}/${existing.environmentName} → ${projectName}/${environmentName}).`
          )
        );
      } else {
        console.log(chalk.green(`Linked ${projectName} → ${environmentName}`));
      }
      console.log(chalk.dim(`  ${linkPath}`));
    } catch (error) {
      printCliError(error, { apiUrl: credentials.apiUrl });
    }
  });

program.parse(process.argv);
