import { Command } from 'commander';
import { createApplianceClient } from '@appliance.sh/sdk';
import { loadCredentials, getActiveProfileOverride } from './utils/credentials.js';
import { attachProfileOption } from './utils/profile-flag.js';
import { readProfiles, resolveProfile, DEFAULT_PROFILE_NAME } from './utils/profile-store.js';
import { readLink, findLinkLocation } from './utils/link.js';
import * as sdk from '@appliance.sh/sdk';
import chalk from 'chalk';

const program = new Command();

attachProfileOption(program);

program.description('show active profile, server URL, and linked project').action(async () => {
  const file = readProfiles();
  const resolved = resolveProfile(file, { override: getActiveProfileOverride() });
  if (!resolved) {
    console.error(chalk.red('Not logged in. Run `appliance login` to authenticate.'));
    console.log(chalk.dim('  (or pass --profile <name> to select a profile)'));
    process.exit(1);
  }
  const { name: profileName, profile } = resolved;
  const apiUrl = process.env.APPLIANCE_API_URL ?? profile.apiUrl;

  console.log(chalk.bold('Profile'));
  console.log(`  Name:     ${profileName}${profileName === DEFAULT_PROFILE_NAME ? chalk.dim(' (default)') : ''}`);
  console.log(`  API URL:  ${apiUrl}`);
  console.log(`  Key ID:   ${profile.keyId}`);
  console.log();

  // Server reachability — useful for diagnosing CLI vs server
  // mismatches without forcing the user to run a separate command.
  const credentials = loadCredentials();
  if (credentials) {
    const client = createApplianceClient({
      baseUrl: credentials.apiUrl,
      credentials: { keyId: credentials.keyId, secret: credentials.secret },
    });
    const probe = await client.listProjects();
    if (probe.success) {
      console.log(`${chalk.green('●')} Server reachable (${probe.data.length} projects visible)`);
    } else {
      console.log(`${chalk.red('●')} Server unreachable: ${probe.error.message}`);
    }
  }

  const link = readLink();
  const linkLoc = findLinkLocation();
  console.log();
  console.log(chalk.bold('Link'));
  if (link && linkLoc) {
    console.log(`  Project:      ${link.projectName}`);
    console.log(`  Environment:  ${link.environmentName}`);
    console.log(`  File:         ${linkLoc.filePath}`);
    if (link.apiUrl && link.apiUrl !== apiUrl) {
      console.log(
        chalk.yellow(
          `  ⚠ Link recorded apiUrl ${link.apiUrl}, but active profile uses ${apiUrl}. ` +
            `Run \`appliance link\` to refresh or \`appliance unlink\` to clear.`
        )
      );
    }
  } else {
    console.log(chalk.dim('  No link in this directory tree.'));
    console.log(chalk.dim('  Run `appliance setup` or `appliance link` to bind a project.'));
  }

  console.log();
  console.log(chalk.dim(`appliance ${sdk.VERSION}`));
});

program.parse(process.argv);
