import { Command } from 'commander';
import chalk from 'chalk';
import { PROFILES_FILE, readProfiles, removeProfile, resolveProfile, setActiveProfile } from './utils/profile-store.js';

const program = new Command();

program.description('manage credential profiles shared with the desktop app');

program
  .command('list')
  .description('list all profiles in ~/.appliance/profiles.json')
  .action(() => {
    const file = readProfiles();
    const names = Object.keys(file.profiles).sort();
    if (names.length === 0) {
      console.log(chalk.dim('No profiles. Run `appliance init` to create one.'));
      return;
    }
    for (const name of names) {
      const profile = file.profiles[name];
      const active = file.activeProfile === name ? chalk.green(' *') : '  ';
      const url = chalk.dim(profile.apiUrl);
      const managed = profile.managed ? chalk.dim(` [${profile.managed}]`) : '';
      console.log(`${active} ${name}${managed}  ${url}`);
    }
  });

program
  .command('current')
  .description('print the active profile name')
  .action(() => {
    const file = readProfiles();
    const resolved = resolveProfile(file);
    if (!resolved) {
      console.error(chalk.red('No active profile.'));
      process.exit(1);
    }
    console.log(resolved.name);
  });

program
  .command('use <name>')
  .description('switch the active profile')
  .action((name: string) => {
    const ok = setActiveProfile(name);
    if (!ok) {
      console.error(chalk.red(`Profile not found: ${name}`));
      console.error(chalk.dim('Run `appliance profile list` to see available profiles.'));
      process.exit(1);
    }
    console.log(chalk.green(`Active profile: ${name}`));
  });

program
  .command('show [name]')
  .description('show profile details (secret is redacted)')
  .action((name?: string) => {
    const file = readProfiles();
    const target = name ?? file.activeProfile;
    if (!target) {
      console.error(chalk.red('No profile name given and no active profile.'));
      process.exit(1);
    }
    const profile = file.profiles[target];
    if (!profile) {
      console.error(chalk.red(`Profile not found: ${target}`));
      process.exit(1);
    }
    console.log(
      JSON.stringify(
        {
          name: target,
          active: file.activeProfile === target,
          apiUrl: profile.apiUrl,
          keyId: profile.keyId,
          // Truncate so a copy-pasted terminal log doesn't leak the
          // full key, while still letting the user recognise which
          // key they're using.
          secret: profile.secret ? `${profile.secret.slice(0, 6)}…(redacted)` : null,
          createdAt: profile.createdAt ?? null,
          managed: profile.managed ?? null,
          stateBackendUrl: profile.stateBackendUrl ?? null,
        },
        null,
        2
      )
    );
  });

program
  .command('remove <name>')
  .description('remove a profile from ~/.appliance/profiles.json')
  .action((name: string) => {
    const ok = removeProfile(name);
    if (!ok) {
      console.error(chalk.red(`Profile not found: ${name}`));
      process.exit(1);
    }
    console.log(chalk.green(`Removed profile: ${name}`));
  });

program
  .command('path')
  .description('print the absolute path of the profiles store')
  .action(() => {
    console.log(PROFILES_FILE);
  });

program.parse(process.argv);
