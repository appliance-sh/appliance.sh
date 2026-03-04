import { Command } from 'commander';
import { createApplianceClient } from '@appliance.sh/sdk';
import { loadCredentials } from './utils/credentials.js';
import chalk from 'chalk';

const program = new Command();

program.action(async () => {
  let failed = false;

  // 1. Check credentials
  const credentials = loadCredentials();
  if (!credentials) {
    console.log(chalk.red('✗ Credentials not found (~/.appliance/credentials.json)'));
    console.log(chalk.dim('  Run `appliance init` to set up credentials.'));
    process.exit(1);
  }
  console.log(chalk.green(`✓ Credentials loaded (${credentials.keyId})`));

  const client = createApplianceClient({ baseUrl: credentials.apiUrl });

  // 2. Check connectivity
  const statusResult = await client.getBootstrapStatus();
  if (!statusResult.success) {
    console.log(chalk.red(`✗ Server unreachable at ${credentials.apiUrl}`));
    console.log(chalk.dim(`  Error: ${statusResult.error.message}`));
    process.exit(1);
  }
  console.log(chalk.green(`✓ Server reachable at ${credentials.apiUrl}`));

  // 3. Bootstrap status
  if (statusResult.data.initialized) {
    console.log(chalk.green('✓ Server initialized'));
  } else {
    console.log(chalk.yellow('⚠ Server not initialized'));
    failed = true;
  }

  // 4. Signed request
  const signedClient = createApplianceClient({
    baseUrl: credentials.apiUrl,
    credentials: { keyId: credentials.keyId, secret: credentials.secret },
  });

  const projectsResult = await signedClient.listProjects();
  if (!projectsResult.success) {
    console.log(chalk.red('✗ Signed request failed'));
    console.log(chalk.dim(`  Error: ${projectsResult.error.message}`));
    failed = true;
  } else {
    console.log(chalk.green('✓ Signed request succeeded'));
  }

  if (failed) {
    process.exit(1);
  }
});

program.parse(process.argv);
