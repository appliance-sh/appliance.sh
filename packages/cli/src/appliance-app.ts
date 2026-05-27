import { Command } from 'commander';
import { input, select } from '@inquirer/prompts';
import { createApplianceClient } from '@appliance.sh/sdk';
import { loadCredentials, getActiveProfileOverride } from './utils/credentials.js';
import { attachProfileOption } from './utils/profile-flag.js';
import { readLink, writeLink } from './utils/link.js';
import { urlsByEnvironment } from './utils/deploy-poll.js';
import chalk from 'chalk';

// Fetch the URL map for a single project — one round-trip via
// listDeployments({ projectId }), then a newest-first scan for the
// most recent successful deploy per env. Returns an empty map on
// failure so listing still works when the deployments endpoint is
// transiently degraded.
async function getProjectUrls(
  client: ReturnType<typeof createApplianceClient>,
  projectId: string
): Promise<Map<string, string>> {
  const r = await client.listDeployments({ projectId, limit: 50 });
  if (!r.success) return new Map();
  return urlsByEnvironment(r.data);
}

function requireClient() {
  const credentials = loadCredentials();
  if (!credentials) {
    console.error(chalk.red('Not logged in. Run `appliance login` first.'));
    process.exit(1);
  }
  return {
    client: createApplianceClient({
      baseUrl: credentials.apiUrl,
      credentials: { keyId: credentials.keyId, secret: credentials.secret },
    }),
    apiUrl: credentials.apiUrl,
  };
}

const program = new Command();

attachProfileOption(program);

program.description('manage applications');

// --- appliance app setup ---
program
  .command('setup')
  .description('connect local codebase to a cloud application')
  .action(async () => {
    const { client, apiUrl } = requireClient();

    try {
      // Step 1: Select or create an application
      const projectsResult = await client.listProjects();
      if (!projectsResult.success) {
        console.error(chalk.red(`Failed to list applications: ${projectsResult.error.message}`));
        process.exit(1);
      }

      let projectId: string;
      let projectName: string;

      if (projectsResult.data.length > 0) {
        const choices = [
          ...projectsResult.data.map((p) => ({ name: p.name, value: p.id })),
          { name: '+ Create a new application', value: '__new__' },
        ];

        const selected = await select({
          message: 'Select an application:',
          choices,
        });

        if (selected === '__new__') {
          projectName = await input({ message: 'Application name:' });
          const createResult = await client.createProject({ name: projectName });
          if (!createResult.success) {
            console.error(chalk.red(`Failed to create application: ${createResult.error.message}`));
            process.exit(1);
          }
          projectId = createResult.data.id;
          console.log(chalk.green(`Created application: ${projectName} (${projectId})`));
        } else {
          projectId = selected;
          projectName = projectsResult.data.find((p) => p.id === selected)!.name;
          console.log(chalk.dim(`Using application: ${projectName}`));
        }
      } else {
        projectName = await input({ message: 'Application name:' });
        const createResult = await client.createProject({ name: projectName });
        if (!createResult.success) {
          console.error(chalk.red(`Failed to create application: ${createResult.error.message}`));
          process.exit(1);
        }
        projectId = createResult.data.id;
        console.log(chalk.green(`Created application: ${projectName} (${projectId})`));
      }

      // Step 2: Select or create an environment
      const envsResult = await client.listEnvironments(projectId);
      if (!envsResult.success) {
        console.error(chalk.red(`Failed to list environments: ${envsResult.error.message}`));
        process.exit(1);
      }

      let environmentName: string;

      if (envsResult.data.length > 0) {
        const choices = [
          ...envsResult.data.map((e) => ({ name: `${e.name} (${e.status})`, value: e.name })),
          { name: '+ Create a new environment', value: '__new__' },
        ];

        const selected = await select({
          message: 'Select an environment:',
          choices,
        });

        if (selected === '__new__') {
          environmentName = await input({ message: 'Environment name:', default: 'production' });
        } else {
          environmentName = selected;
        }
      } else {
        environmentName = await input({ message: 'Environment name:', default: 'production' });
      }

      // Create environment if it doesn't exist
      const existingEnv = envsResult.data.find((e) => e.name === environmentName);
      if (!existingEnv) {
        const createResult = await client.createEnvironment({ name: environmentName, projectId });
        if (!createResult.success) {
          console.error(chalk.red(`Failed to create environment: ${createResult.error.message}`));
          process.exit(1);
        }
        console.log(chalk.green(`Created environment: ${environmentName}`));
      } else {
        console.log(chalk.dim(`Using environment: ${environmentName}`));
      }

      // Persist the link so `appliance deploy` / `status` / etc. can
      // run with no args. We always overwrite — re-running setup is
      // the intended way to retarget this folder.
      const linkPath = writeLink({
        projectName,
        environmentName,
        apiUrl,
        profile: getActiveProfileOverride() ?? process.env.APPLIANCE_PROFILE ?? undefined,
      });

      console.log();
      console.log(chalk.green('Setup complete.'));
      console.log(chalk.dim(`Linked ${projectName} → ${environmentName} (${linkPath})`));
      console.log(chalk.dim(`Run ${chalk.bold('appliance deploy')} to deploy.`));
    } catch (error) {
      console.error(chalk.red(String(error)));
      process.exit(1);
    }
  });

// --- appliance app status ---
program
  .command('status')
  .description('show application status')
  .argument('[project]', 'application name (defaults to the linked project)')
  .action(async (projectArg: string | undefined) => {
    const { client } = requireClient();

    // No arg → fall back to the cwd link, so `appliance status` works
    // out of the box from a linked project directory.
    const link = readLink();
    const projectName = projectArg ?? link?.projectName;
    if (!projectName) {
      console.error(
        chalk.red(
          'No project to inspect. Pass `<project>` or run `appliance setup` / `appliance link` to link this folder.'
        )
      );
      process.exit(1);
    }

    try {
      const projectsResult = await client.listProjects();
      if (!projectsResult.success) {
        console.error(chalk.red(`Failed to list applications: ${projectsResult.error.message}`));
        process.exit(1);
      }

      const project = projectsResult.data.find((p) => p.name === projectName);
      if (!project) {
        console.error(chalk.red(`Application "${projectName}" not found.`));
        process.exit(1);
      }

      console.log(chalk.bold(project.name) + chalk.dim(` (${project.id})`));
      console.log(`  Status:    ${project.status}`);
      console.log(`  Created:   ${project.createdAt}`);
      console.log(`  Updated:   ${project.updatedAt}`);
      console.log();

      const envsResult = await client.listEnvironments(project.id);
      if (!envsResult.success) {
        console.error(chalk.red(`Failed to list environments: ${envsResult.error.message}`));
        process.exit(1);
      }

      if (envsResult.data.length === 0) {
        console.log(chalk.dim('No environments.'));
      } else {
        // env.url is the canonical "where is this reachable" address.
        // For environments that predate the field, fall back to a
        // per-project deployment scan so legacy data still surfaces.
        const needsFallback = envsResult.data.some((e) => !e.url);
        const fallback = needsFallback ? await getProjectUrls(client, project.id) : new Map<string, string>();
        console.log(chalk.bold('Environments'));
        for (const env of envsResult.data) {
          const statusColor =
            env.status === 'deployed' ? chalk.green : env.status === 'failed' ? chalk.red : chalk.yellow;
          const linkedMarker = link && link.environmentName === env.name ? chalk.dim(' (linked)') : '';
          console.log(`  ${chalk.bold(env.name)}${linkedMarker}`);
          console.log(`    Status:         ${statusColor(env.status)}`);
          console.log(`    Stack:          ${env.stackName}`);
          if (env.lastDeployedAt) {
            console.log(`    Last deployed:  ${env.lastDeployedAt}`);
          }
          console.log(`    Created:        ${env.createdAt}`);
          const url = env.url ?? fallback.get(env.id);
          if (url) {
            console.log(`    URL:            ${chalk.cyan(url)}`);
          }
        }
      }
    } catch (error) {
      console.error(chalk.red(String(error)));
      process.exit(1);
    }
  });

// --- appliance app list ---
program
  .command('list')
  .description('list applications and environments')
  .action(async () => {
    const { client } = requireClient();

    try {
      const projectsResult = await client.listProjects();
      if (!projectsResult.success) {
        console.error(chalk.red(`Failed to list applications: ${projectsResult.error.message}`));
        process.exit(1);
      }

      if (projectsResult.data.length === 0) {
        console.log(chalk.yellow('No applications found.'));
        return;
      }

      const link = readLink();
      for (const project of projectsResult.data) {
        const linkedMarker = link && link.projectName === project.name ? chalk.dim(' (linked)') : '';
        console.log(chalk.bold(project.name) + linkedMarker + chalk.dim(` (${project.id}) — ${project.status}`));

        const envsResult = await client.listEnvironments(project.id);
        if (!envsResult.success) {
          console.log(chalk.red(`  Failed to list environments: ${envsResult.error.message}`));
          continue;
        }

        if (envsResult.data.length === 0) {
          console.log(chalk.dim('  No environments.'));
        } else {
          const needsFallback = envsResult.data.some((e) => !e.url);
          const fallback = needsFallback ? await getProjectUrls(client, project.id) : new Map<string, string>();
          for (const env of envsResult.data) {
            const deployed = env.lastDeployedAt ? `, last deployed ${env.lastDeployedAt}` : '';
            const envLinked =
              link && link.projectName === project.name && link.environmentName === env.name
                ? chalk.dim(' (linked)')
                : '';
            console.log(`  ${env.name}${envLinked} — ${env.status}${chalk.dim(deployed)}`);
            const url = env.url ?? fallback.get(env.id);
            if (url) {
              console.log(`    ${chalk.dim('URL:')} ${chalk.cyan(url)}`);
            }
          }
        }

        console.log();
      }
    } catch (error) {
      console.error(chalk.red(String(error)));
      process.exit(1);
    }
  });

program.parse(process.argv);
