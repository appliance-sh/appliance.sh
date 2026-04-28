#!/usr/bin/env node

import { Command } from 'commander';
import * as prompts from '@inquirer/prompts';
import * as slug from 'random-word-slugs';
import chalk from 'chalk';
import { runBootstrap, type BootstrapEvent, type BootstrapPhase } from '@appliance.sh/bootstrap';
import { ApplianceBaseType, type ApplianceBaseConfigInput } from '@appliance.sh/sdk';

const COMMON_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'eu-west-1',
  'eu-west-2',
  'eu-central-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-south-1',
];

const ALL_PHASES: BootstrapPhase[] = ['phase1', 'phase2', 'phase3'];

const program = new Command();

program
  .option('--name <name>', 'base name (e.g. my-cluster)')
  .option('--region <region>', 'AWS region')
  .option('--domain <domain>', 'domain name for the installation')
  .option('--create-zone', 'create a new Route53 zone for the domain')
  .option('--attach-zone', 'attach an existing Route53 zone')
  .option(
    '--phases <phases>',
    `comma-separated phases to run (${ALL_PHASES.join(',')}); phase 2/3 are not implemented yet`,
    'phase1'
  )
  .option('--cache-dir <dir>', 'override ~/.appliance cache directory')
  .option(
    '--image-uri <uri>',
    'override the default api-server image (default: `ghcr.io/appliance-sh/api-server:<version>`)'
  )
  .option('--profile <name>', 'AWS profile to authenticate with (overrides shell env credentials)')
  .option('-y, --yes', 'skip the confirmation prompt')
  .action(
    async (options: {
      name?: string;
      region?: string;
      domain?: string;
      createZone?: boolean;
      attachZone?: boolean;
      phases: string;
      cacheDir?: string;
      imageUri?: string;
      profile?: string;
      yes?: boolean;
    }) => {
      const name =
        options.name ??
        (await prompts.input({
          message: 'Base name:',
          default: slug.generateSlug(2, { format: 'kebab' }),
          validate: (v) => /^[a-z][a-z0-9-]*$/.test(v) || 'lowercase letters, digits, and dashes only',
        }));

      const region =
        options.region ??
        (await prompts.select({
          message: 'AWS region:',
          choices: COMMON_REGIONS.map((r) => ({ value: r, name: r })),
          default: 'us-east-1',
        }));

      const domain =
        options.domain ??
        (await prompts.input({
          message: 'Domain name:',
          validate: (v) => v.includes('.') || 'must be a valid domain (e.g. example.com)',
        }));

      let createZone: boolean;
      let attachZone: boolean;
      if (options.createZone !== undefined || options.attachZone !== undefined) {
        createZone = options.createZone ?? false;
        attachZone = options.attachZone ?? !createZone;
      } else {
        createZone = await prompts.confirm({
          message: `Create a new Route53 zone for ${domain}?`,
          default: true,
        });
        attachZone = !createZone;
      }

      const baseConfig: ApplianceBaseConfigInput = {
        type: ApplianceBaseType.ApplianceAwsPublic,
        name,
        region,
        dns: { domainName: domain, createZone, attachZone },
      };

      const phases = parsePhases(options.phases);

      // --image-uri is optional. When absent, phase 2 falls back to
      // the pinned `ghcr.io/appliance-sh/api-server:<version>` default
      // baked into @appliance.sh/bootstrap.
      const imageUri = options.imageUri;

      if (!options.yes) {
        console.log();
        console.log(chalk.bold('Bootstrap plan'));
        console.log(`  Base:    ${name}`);
        console.log(`  Region:  ${region}`);
        console.log(`  Domain:  ${domain}`);
        console.log(`  Zone:    ${createZone ? 'create new' : 'attach existing'}`);
        console.log(`  Phases:  ${phases.join(', ')}`);
        console.log(`  Image:   ${imageUri ?? '(default ghcr.io/appliance-sh/api-server)'}`);
        console.log(`  Profile: ${options.profile ?? '(shell env)'}`);
        if (options.cacheDir) console.log(`  Cache:   ${options.cacheDir}`);
        console.log();
        const ok = await prompts.confirm({ message: 'Proceed?', default: true });
        if (!ok) {
          console.log(chalk.yellow('aborted'));
          process.exit(0);
        }
      }

      try {
        const result = await runBootstrap(
          {
            base: { name, config: baseConfig },
            apiServerImageUri: imageUri,
            aws: options.profile ? { profile: options.profile } : undefined,
          },
          {
            phases,
            cacheDir: options.cacheDir,
            onEvent: renderEvent,
          }
        );

        console.log();
        console.log(chalk.green('Bootstrap complete'));
        console.log(`  State backend:  ${result.stateBackendUrl}`);
        if (result.apiServerUrl) {
          console.log(`  API server:     ${result.apiServerUrl}`);
        }
        if (result.apiKey) {
          console.log(`  API key id:     ${result.apiKey.id}`);
          console.log(chalk.yellow(`  API key secret: ${result.apiKey.secret}  (shown once; save it now)`));
        }
      } catch (e) {
        console.error();
        const msg = e instanceof Error ? e.message : String(e);
        console.error(chalk.red('Bootstrap failed:'), msg);
        if (/ENOENT.*pulumi|pulumi.*ENOENT|spawn pulumi/i.test(msg)) {
          console.error(
            chalk.yellow('\nThe Pulumi CLI is not on PATH. Install it from https://www.pulumi.com/docs/install/')
          );
        }
        process.exit(1);
      }
    }
  );

function parsePhases(raw: string): BootstrapPhase[] {
  const normalized = raw === 'all' ? ALL_PHASES.join(',') : raw;
  const parts = normalized
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const p of parts) {
    if (!ALL_PHASES.includes(p as BootstrapPhase)) {
      throw new Error(`unknown phase '${p}'. valid: ${ALL_PHASES.join(', ')}`);
    }
  }
  return parts as BootstrapPhase[];
}

function renderEvent(e: BootstrapEvent): void {
  switch (e.type) {
    case 'phase-started':
      console.log();
      console.log(chalk.bold.cyan(`▸ ${phaseLabel(e.phase)}`));
      break;
    case 'phase-completed':
      console.log(chalk.green(`✓ ${phaseLabel(e.phase)}`));
      break;
    case 'phase-failed':
      console.log(chalk.red(`✗ ${phaseLabel(e.phase)}: ${e.error}`));
      break;
    case 'phase-skipped':
      console.log(chalk.dim(`⚬ ${phaseLabel(e.phase)} skipped (${e.reason})`));
      break;
    case 'resource': {
      if (e.op === 'same') return;
      const glyph = e.op === 'create' ? '+' : e.op === 'delete' ? '-' : e.op === 'replace' ? '↻' : '·';
      const color =
        e.op === 'create' ? chalk.green : e.op === 'delete' ? chalk.red : e.op === 'replace' ? chalk.yellow : chalk.dim;
      console.log(`  ${color(glyph)} ${e.resourceType.padEnd(44)} ${e.name}`);
      break;
    }
    case 'log':
      if (e.level === 'warn') console.log(chalk.yellow(e.message));
      if (e.level === 'error') console.log(chalk.red(e.message));
      break;
  }
}

function phaseLabel(p: BootstrapPhase): string {
  switch (p) {
    case 'phase1':
      return 'Phase 1 — base infrastructure';
    case 'phase2':
      return 'Phase 2 — hoist api-server';
    case 'phase3':
      return 'Phase 3 — promote state to S3';
  }
}

program.parse(process.argv);
