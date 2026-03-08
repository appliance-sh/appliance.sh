import { Command } from 'commander';
import { signRequest } from '@appliance.sh/sdk';
import { loadCredentials } from './utils/credentials.js';
import chalk from 'chalk';

const program = new Command();

program.description('destroy the default test stack via /api/v1/infra/destroy').action(async () => {
  const credentials = loadCredentials();
  if (!credentials) {
    console.error(chalk.red('Credentials not found. Run `appliance init` first.'));
    process.exit(1);
  }

  const url = `${credentials.apiUrl.replace(/\/$/, '')}/api/v1/infra/destroy`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  const sigHeaders = await signRequest(
    { keyId: credentials.keyId, secret: credentials.secret },
    { method: 'POST', url, headers }
  );
  Object.assign(headers, sigHeaders);

  console.log(chalk.dim('Sending destroy request to /api/v1/infra/destroy...'));

  const response = await fetch(url, { method: 'POST', headers });

  if (!response.ok) {
    const body = await response.text();
    console.error(chalk.red(`Destroy failed: HTTP ${response.status}: ${body}`));
    process.exit(1);
  }

  const result = await response.json();
  console.log(chalk.green('Destroy result:'));
  console.log(JSON.stringify(result, null, 2));
});

program.parse(process.argv);
