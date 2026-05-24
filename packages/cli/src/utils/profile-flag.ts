import type { Command } from 'commander';
import { setActiveProfileOverride } from './credentials.js';

// Attach a shared `--profile <name>` option to a subcommand.
//
// On parse, the override is stored in module state in credentials.ts
// so subsequent loadCredentials() calls resolve the right profile.
// Subcommands that don't load credentials (e.g. `bootstrap`) can omit
// this helper; calling it is a no-op for those flows.
export function attachProfileOption(program: Command): Command {
  return program
    .option('--profile <name>', 'profile from ~/.appliance/profiles.json to use (overrides APPLIANCE_PROFILE)')
    .hook('preAction', (cmd) => {
      const opts = cmd.opts<{ profile?: string }>();
      setActiveProfileOverride(opts.profile);
    });
}
