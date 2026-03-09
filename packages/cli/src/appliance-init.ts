import { Command } from 'commander';
import { input, password } from '@inquirer/prompts';
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

  // Check server connectivity and bootstrap status
  console.log(chalk.dim('Checking server status...'));
  const statusResult = await client.getBootstrapStatus();
  if (!statusResult.success) {
    console.error(chalk.red(`Server unreachable at ${apiUrl}: ${statusResult.error.message}`));
    process.exit(1);
  }

  let keyId: string;
  let secret: string;

  if (!statusResult.data.initialized) {
    // Bootstrap flow — server has no API keys yet
    console.log(chalk.yellow('Server is not initialized. Starting bootstrap flow.'));

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
    // Existing key flow — server already initialized
    console.log(chalk.dim('Server is initialized. Enter your existing API key.'));

    keyId = await input({
      message: 'API key ID (ak_...):',
    });

    secret = await password({
      message: 'API key secret (sk_...):',
    });
  }

  // Verify credentials with a signed request
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
