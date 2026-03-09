import { Command } from 'commander';
import { input, select, password } from '@inquirer/prompts';
import { createApplianceClient } from '@appliance.sh/sdk';
import { saveCredentials } from './utils/credentials.js';
import chalk from 'chalk';

const program = new Command();

program.action(async () => {
  const apiUrl = await input({
    message: 'API URL:',
    default: 'http://localhost:3000',
  });

  const client = createApplianceClient({ baseUrl: apiUrl });

  const method = await select({
    message: 'Authentication method:',
    choices: [
      { name: 'Bootstrap (create new API key)', value: 'bootstrap' },
      { name: 'Existing API key', value: 'existing' },
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

  saveCredentials({ apiUrl, keyId, secret });
  console.log(chalk.green('Credentials saved. You are now logged in.'));
});

program.parse(process.argv);
