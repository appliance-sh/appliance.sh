import { Command } from 'commander';
import { createApplianceClient } from '@appliance.sh/sdk';
import { loadCredentials } from './utils/credentials.js';
import chalk from 'chalk';

function requireClient() {
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

const program = new Command();

program.description('manage deployments');

// --- appliance deployment status <id> ---
program
  .command('status')
  .description('check deployment status')
  .argument('<deployment-id>', 'deployment ID')
  .action(async (deploymentId: string) => {
    const client = requireClient();

    try {
      const result = await client.getDeployment(deploymentId);
      if (!result.success) {
        console.error(chalk.red(`Failed to get deployment: ${result.error.message}`));
        process.exit(1);
      }

      const d = result.data;
      const statusColor = d.status === 'succeeded' ? chalk.green : d.status === 'failed' ? chalk.red : chalk.yellow;

      console.log(chalk.bold('Deployment'));
      console.log(`  ID:          ${d.id}`);
      console.log(`  Action:      ${d.action}`);
      console.log(`  Status:      ${statusColor(d.status)}`);
      console.log(`  Started:     ${d.startedAt}`);
      if (d.completedAt) {
        console.log(`  Completed:   ${d.completedAt}`);
      }
      if (d.message) {
        console.log(`  Message:     ${d.message}`);
      }
      if (d.idempotentNoop) {
        console.log(chalk.dim('  (no changes needed)'));
      }
    } catch (error) {
      console.error(chalk.red(String(error)));
      process.exit(1);
    }
  });

program.parse(process.argv);
