#!/usr/bin/env node

import { Command } from 'commander';
import { ensureHelperBinOnPath } from '@appliance.sh/helper';

import * as sdk from '@appliance.sh/sdk';

// Prepend ~/.appliance/bin to PATH so subcommands spawned by
// commander (and any tools they invoke — docker, k3d, kubectl)
// resolve helper-installed binaries when the system PATH lacks them.
// Idempotent; safe to also call from a subcommand entry directly.
ensureHelperBinOnPath();

const program = new Command();

program
  .name('appliance')
  .version(sdk.VERSION)
  .command('app', 'manage applications (setup, status, list)')
  .alias('application')
  .command('bootstrap', 'provision a new Appliance installation on AWS')
  .command('build', 'builds the appliance in the current working directory')
  .command('configure', 'configures the appliance in the current working directory')
  .command('deploy [project] [environment]', 'deploy the linked (or named) project/environment')
  .command('deployment', 'manage deployments')
  .command('destroy [project] [environment]', 'destroy the linked (or named) project/environment')
  .command('init', 'initialise the CLI with the appliance server')
  .command('install [project] [environment]', 'alias for deploy')
  .command('link', 'link this folder to a project/environment')
  .command('list', 'list applications and environments')
  .command('local', 'manage the local k3d-backed runtime (doctor, …)')
  .command('login', 'authenticate with the appliance API')
  .command('open', 'open the latest deployment URL in a browser')
  .command('remove [project] [environment]', 'alias for destroy')
  .command('setup', 'connect local codebase to a cloud application')
  .command('status [project]', 'show application status')
  .command('unlink', 'remove the local project/environment link')
  .command('whoami', 'show active profile, server URL, and linked project')
  .command('profile', 'manage credential profiles (shared with the desktop app)')
  .command('teardown', 'destroy a bootstrap installation (reverses `appliance bootstrap`)')
  .command('test', 'run connection and signing diagnostics');

program.parse(process.argv);
