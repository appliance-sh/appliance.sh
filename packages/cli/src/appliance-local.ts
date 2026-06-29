import chalk from 'chalk';

// `appliance local` is a one-release deprecation stub.
//
// The host-side k3d runtime this command used to manage (status / up /
// stop / delete / exec / shell / runtime / install / update) has been
// removed — the microVM is now the sole local runtime. The command is
// still registered (so it doesn't fall through to a bare "unknown
// command") but every invocation errors immediately with guidance toward
// its replacements.

const REMOVED_MESSAGE =
  '`appliance local` has been removed — the local k3d runtime is gone.\n' +
  'Use `appliance up` for local dev, or `appliance vm` to manage the microVM runtime.';

console.error(chalk.red(REMOVED_MESSAGE));
process.exit(1);
