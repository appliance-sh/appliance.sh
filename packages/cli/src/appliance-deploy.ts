import { Command } from 'commander';
import { createApplianceClient, DeploymentStatus } from '@appliance.sh/sdk';
import { loadCredentials } from './utils/credentials.js';
import { attachProfileOption } from './utils/profile-flag.js';
import { registerManifestOptions } from './utils/common.js';
import { DEFAULT_BUILD_OUTPUT, isPrintedError, runDeploy } from './utils/deploy-core.js';
import { printCliError } from './utils/errors.js';
import chalk from 'chalk';

// Thin commander wrapper around the shared deploy engine in
// utils/deploy-core.ts (also driven by `appliance stack deploy`).

const program = new Command();

attachProfileOption(program);

registerManifestOptions(program)
  .description('deploy the linked (or named) project/environment')
  .argument('[project]', 'project name (defaults to the linked project, then to the manifest `name`)')
  .argument('[environment]', 'environment name (defaults to the linked environment)')
  .option('-a, --build <path>', 'appliance.zip build to deploy', DEFAULT_BUILD_OUTPUT)
  .option(
    '--image-uri <uri>',
    'reference an already-published image (e.g. ghcr.io/org/app:tag) instead of uploading a build'
  )
  .option('-e, --env-file <path>', 'env file with runtime environment variables')
  .option('-y, --yes', 'skip interactive prompts; fail when input would be needed', false)
  .action(async (cliProject: string | undefined, cliEnvironment: string | undefined) => {
    const opts = program.opts<{
      build: string;
      imageUri?: string;
      envFile?: string;
      file?: string;
      directory?: string;
      variant?: string;
      yes: boolean;
    }>();

    if (opts.imageUri && opts.build !== DEFAULT_BUILD_OUTPUT) {
      console.error(chalk.red('Provide either --image-uri or --build, not both.'));
      process.exit(1);
    }

    const credentials = loadCredentials();
    if (!credentials) {
      console.error(chalk.red('Not logged in — no credentials for the active profile.'));
      console.error(
        chalk.dim(
          'Run `appliance login` to authenticate, or start the local runtime with `appliance vm up` ' +
            '(which saves a profile for you). `appliance whoami` shows the active profile; `appliance doctor` checks the host prerequisites.'
        )
      );
      process.exit(1);
    }

    const client = createApplianceClient({
      baseUrl: credentials.apiUrl,
      credentials: { keyId: credentials.keyId, secret: credentials.secret },
    });

    try {
      const outcome = await runDeploy({
        client,
        apiUrl: credentials.apiUrl,
        program,
        cliProject,
        cliEnvironment,
        opts: { build: opts.build, imageUri: opts.imageUri, envFile: opts.envFile, yes: opts.yes },
      });

      if (outcome.deployment.status !== DeploymentStatus.Succeeded) {
        process.exit(1);
      }
    } catch (error) {
      if (isPrintedError(error)) process.exit(1);
      printCliError(error, { apiUrl: credentials.apiUrl });
      process.exit(process.exitCode ?? 1);
    }
  });

program.parse(process.argv);
