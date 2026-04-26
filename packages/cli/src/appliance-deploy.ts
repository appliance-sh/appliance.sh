import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createApplianceClient } from '@appliance.sh/sdk';
import type { Project, Environment } from '@appliance.sh/sdk';
import { loadCredentials } from './utils/credentials.js';
import { extractApplianceFile, registerManifestOptions } from './utils/common.js';
import chalk from 'chalk';

const POLL_INTERVAL_MS = 3000;

function parseEnvFile(filePath: string): Record<string, string> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

async function findOrCreateProject(client: ReturnType<typeof createApplianceClient>, name: string): Promise<Project> {
  const listResult = await client.listProjects();
  if (!listResult.success) throw new Error(`Failed to list projects: ${listResult.error.message}`);

  const existing = listResult.data.find((p) => p.name === name);
  if (existing) {
    console.log(chalk.dim(`Using existing project: ${existing.id}`));
    return existing;
  }

  const createResult = await client.createProject({ name });
  if (!createResult.success) throw new Error(`Failed to create project: ${createResult.error.message}`);
  console.log(chalk.green(`Created project: ${createResult.data.id}`));
  return createResult.data;
}

async function findOrCreateEnvironment(
  client: ReturnType<typeof createApplianceClient>,
  projectId: string,
  projectName: string,
  name: string
): Promise<Environment> {
  const expectedStackName = `${projectName}-${name}`;
  const listResult = await client.listEnvironments(projectId);
  if (!listResult.success) throw new Error(`Failed to list environments: ${listResult.error.message}`);

  const existing = listResult.data.find((e) => e.name === name);
  if (existing) {
    if (existing.stackName === expectedStackName) {
      console.log(chalk.dim(`Using existing environment: ${existing.id}`));
      return existing;
    }
    console.log(chalk.yellow(`Replacing environment with stale stack name: ${existing.stackName}`));
    await client.deleteEnvironment(projectId, existing.id);
  }

  const createResult = await client.createEnvironment({ name, projectId });
  if (!createResult.success) throw new Error(`Failed to create environment: ${createResult.error.message}`);
  console.log(chalk.green(`Created environment: ${createResult.data.id} (stack: ${createResult.data.stackName})`));
  return createResult.data;
}

// Re-render the manifest at deploy time with project + environment
// context so the manifest function (if any) can produce per-target
// env vars. Returns undefined when there's no manifest source
// reachable from cwd or when the manifest declares no env — in
// either case the deploy proceeds with just --env-file values.
async function renderManifestEnv(
  program: Command,
  projectName: string,
  environmentName: string
): Promise<Record<string, string> | undefined> {
  const result = await extractApplianceFile(program, {
    project: projectName,
    environment: environmentName,
  });
  if (!result.success) {
    if (result.error.name === 'File Not Found') {
      // Deploy from a location without the manifest source is
      // legitimate (e.g. promoting a prebuilt zip). No manifest
      // env, just continue.
      return undefined;
    }
    console.error(chalk.red(`Failed to render manifest env: ${result.error.message}`));
    process.exit(1);
  }
  const env = result.data.env;
  if (env && Object.keys(env).length > 0) {
    console.log(chalk.dim(`Rendered ${Object.keys(env).length} env vars from manifest`));
    return env;
  }
  return undefined;
}

function loadEnvFile(explicit: string | undefined, environmentName: string): Record<string, string> | undefined {
  const envFilePath = path.resolve(explicit ?? `.env.${environmentName}`);
  if (fs.existsSync(envFilePath)) {
    const vars = parseEnvFile(envFilePath);
    console.log(chalk.dim(`Loaded ${Object.keys(vars).length} env vars from ${path.basename(envFilePath)}`));
    return vars;
  }
  if (explicit) {
    console.error(chalk.red(`Env file not found: ${envFilePath}`));
    process.exit(1);
  }
  return undefined;
}

async function pollDeployment(client: ReturnType<typeof createApplianceClient>, deploymentId: string) {
  while (true) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const status = await client.getDeployment(deploymentId);
    if (!status.success) {
      console.error(chalk.red(`Failed to get deployment status: ${status.error.message}`));
      process.exit(1);
    }

    const { status: deployStatus, message } = status.data;
    console.log(chalk.dim(`  status: ${deployStatus}${message ? ` — ${message}` : ''}`));

    if (deployStatus === 'succeeded') {
      console.log(chalk.green('Deployment succeeded.'));
      console.log(JSON.stringify(status.data, null, 2));
      return;
    }
    if (deployStatus === 'failed') {
      console.error(chalk.red(`Deployment failed: ${message ?? 'unknown error'}`));
      process.exit(1);
    }
  }
}

const program = new Command();

registerManifestOptions(program)
  .description('deploy a named project/environment')
  .argument('<project>', 'project name')
  .argument('<environment>', 'environment name')
  .option('-a, --build <path>', 'appliance.zip build to deploy', 'appliance.zip')
  .option(
    '--image-uri <uri>',
    'reference an already-published image (e.g. ghcr.io/org/app:tag) instead of uploading a build'
  )
  .option('-e, --env-file <path>', 'env file with runtime environment variables')
  .action(async (projectName: string, environmentName: string) => {
    const opts = program.opts<{
      build: string;
      imageUri?: string;
      envFile?: string;
      file?: string;
      directory?: string;
      variant?: string;
    }>();

    // --image-uri and --build are mutually exclusive; detect the
    // explicit --build override by looking for a non-default path.
    if (opts.imageUri && opts.build !== 'appliance.zip') {
      console.error(chalk.red('Provide either --image-uri or --build, not both.'));
      process.exit(1);
    }

    const credentials = loadCredentials();
    if (!credentials) {
      console.error(chalk.red('Credentials not found. Run `appliance init` first.'));
      process.exit(1);
    }

    const client = createApplianceClient({
      baseUrl: credentials.apiUrl,
      credentials: { keyId: credentials.keyId, secret: credentials.secret },
    });

    try {
      const project = await findOrCreateProject(client, projectName);
      const environment = await findOrCreateEnvironment(client, project.id, projectName, environmentName);

      // Resolve the build source. Both paths end at a buildId the
      // deploy references:
      //   --image-uri → createBuild({ uploadUrl: <image> }) records
      //                 an external-reference build (no upload).
      //   default    → zip upload via uploadBuild().
      let buildId: string;
      if (opts.imageUri) {
        console.log(chalk.dim(`Using image: ${opts.imageUri}`));
        const createResult = await client.createBuild({ uploadUrl: opts.imageUri });
        if (!createResult.success) {
          console.error(chalk.red(`Failed to create external build: ${createResult.error.message}`));
          process.exit(1);
        }
        buildId = createResult.data.buildId;
        console.log(chalk.dim(`External build created: ${buildId}`));
      } else {
        const buildPath = path.resolve(opts.build);
        if (!fs.existsSync(buildPath)) {
          console.error(chalk.red(`Build not found: ${buildPath}`));
          console.error(chalk.dim('Run `appliance build` first, or pass --image-uri <uri>.'));
          process.exit(1);
        }
        const buildData = fs.readFileSync(buildPath);
        const sizeMb = (buildData.length / 1024 / 1024).toFixed(1);
        console.log(chalk.dim(`Uploading build (${sizeMb} MB)...`));
        const uploadResult = await client.uploadBuild(buildData);
        if (!uploadResult.success) {
          console.error(chalk.red(`Upload failed: ${uploadResult.error.message}`));
          process.exit(1);
        }
        buildId = uploadResult.data.buildId;
        console.log(chalk.dim(`Build uploaded: ${buildId}`));
      }

      // Render env from the manifest, merge with --env-file. The
      // build artifact is environment-invariant — env is rendered
      // fresh per-deploy with full ManifestContext (project,
      // environment, variant) so the same zip can deploy to many
      // environments. Manifest source is best-effort: deploys from
      // a checkout-less location (e.g. promoting a prebuilt zip)
      // degrade gracefully to env-file-only.
      const manifestEnv = await renderManifestEnv(program, projectName, environmentName);

      const envFileVars = loadEnvFile(opts.envFile, environmentName);

      // --env-file wins on conflict: it's the most local, ad-hoc
      // override surface (typically holds secrets or per-deploy
      // values), while manifest env represents declared defaults.
      const envVars: Record<string, string> | undefined =
        manifestEnv || envFileVars ? { ...(manifestEnv ?? {}), ...(envFileVars ?? {}) } : undefined;

      console.log(chalk.dim(`Deploying ${projectName}/${environmentName}...`));
      const result = await client.deploy(environment.id, { buildId, environment: envVars });
      if (!result.success) {
        console.error(chalk.red(`Deploy failed: ${result.error.message}`));
        process.exit(1);
      }

      console.log(chalk.dim(`Deployment started: ${result.data.id}`));
      await pollDeployment(client, result.data.id);
    } catch (error) {
      console.error(chalk.red(String(error)));
      process.exit(1);
    }
  });

program.parse(process.argv);
