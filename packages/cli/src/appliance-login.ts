import { Command } from 'commander';
import { input, select, password } from '@inquirer/prompts';
import { createApplianceClient } from '@appliance.sh/sdk';
import { apiServerUrlForHostPort } from '@appliance.sh/helper';
import { saveCredentials } from './utils/credentials.js';
import { attachProfileOption } from './utils/profile-flag.js';
import { DEFAULT_PROFILE_NAME } from './utils/profile-store.js';
import { readVmPorts } from './utils/microvm-up.js';
import chalk from 'chalk';

const program = new Command();

attachProfileOption(program);

program.action(async () => {
  const opts = program.opts<{ profile?: string }>();
  const profileName = opts.profile ?? process.env.APPLIANCE_PROFILE ?? DEFAULT_PROFILE_NAME;
  console.log(
    chalk.dim('For local development you don’t need to log in — `appliance init` sets everything up automatically.')
  );
  const apiUrl = await input({
    message: 'API URL:',
    // Default to where the local runtime's api-server actually answers
    // (the in-VM ingress route), read from the default VM's spec.
    default: apiServerUrlForHostPort(readVmPorts().hostPort),
  });

  const client = createApplianceClient({ baseUrl: apiUrl });

  const method = await select({
    message: 'Authentication method:',
    choices: [
      {
        name: 'Bootstrap (create new API key)',
        value: 'bootstrap',
        description: 'First-time setup: exchange the server’s one-time bootstrap token for a new API key.',
      },
      {
        name: 'Existing API key',
        value: 'existing',
        description: 'Paste a key you already have (ak_… id and sk_… secret).',
      },
    ],
  });

  let keyId: string;
  let secret: string;

  if (method === 'bootstrap') {
    const token = await password({
      message: 'Bootstrap token:',
    });

    const keyName = await input({
      message: 'API key name:',
      default: 'cli',
    });

    const result = await client.bootstrap(token, keyName);
    if (!result.success) {
      console.error(chalk.red(`Bootstrap failed: ${result.error.message}`));
      process.exit(1);
    }

    keyId = result.data.id;
    secret = result.data.secret;
    console.log(chalk.green(`API key created: ${keyId}`));
  } else {
    keyId = await input({
      message: 'API key ID (ak_...):',
    });

    secret = await password({
      message: 'API key secret (sk_...):',
    });
  }

  // Verify credentials by making a test request
  const verifyClient = createApplianceClient({
    baseUrl: apiUrl,
    credentials: { keyId, secret },
  });

  const testResult = await verifyClient.listProjects();
  if (!testResult.success) {
    console.error(chalk.red(`Credential verification failed: ${testResult.error.message}`));
    process.exit(1);
  }

  saveCredentials({ apiUrl, keyId, secret }, profileName);
  console.log(chalk.green(`Credentials saved to profile "${profileName}". You are now logged in.`));
});

program.parse(process.argv);
