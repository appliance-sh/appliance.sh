import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { input } from '@inquirer/prompts';
import { ApplianceType, createApplianceClient, DeploymentStatus, isKubernetesBase } from '@appliance.sh/sdk';
import type { ApplianceBaseConfig, Project, Environment, Deployment } from '@appliance.sh/sdk';
import { loadCredentials } from './utils/credentials.js';
import { getActiveProfileOverride } from './utils/credentials.js';
import { attachProfileOption } from './utils/profile-flag.js';
import { extractApplianceFile, registerManifestOptions } from './utils/common.js';
import { buildApplianceZip } from './utils/build-package.js';
import { publishLocalApplianceImage } from './utils/local-image.js';
import { readLink, writeLink } from './utils/link.js';
import { pollDeploymentUntilDone, extractDeploymentUrl } from './utils/deploy-poll.js';
import { startProgressLine, BRAND } from './utils/progress.js';
import chalk from 'chalk';

const DEFAULT_BUILD_OUTPUT = 'appliance.zip';

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

interface RenderedRuntime {
  env?: Record<string, string>;
  memory?: number;
  timeout?: number;
  storage?: number;
}

// Re-render the manifest at deploy time with project + environment
// context so the manifest function (if any) can produce per-target
// runtime config (env vars + Lambda memory/timeout/storage). Returns
// undefined when there's no manifest source reachable from cwd — in
// that case the deploy proceeds with just --env-file values and
// whatever defaults the api-server applies.
async function renderRuntimeConfig(
  program: Command,
  projectName: string,
  environmentName: string
): Promise<RenderedRuntime | undefined> {
  const result = await extractApplianceFile(program, {
    project: projectName,
    environment: environmentName,
  });
  if (!result.success) {
    if (result.error.name === 'File Not Found') return undefined;
    console.error(chalk.red(`Failed to render manifest runtime config: ${result.error.message}`));
    process.exit(1);
  }
  const { env, memory, timeout, storage } = result.data;
  const runtime: RenderedRuntime = {};
  if (env && Object.keys(env).length > 0) {
    console.log(chalk.dim(`Rendered ${Object.keys(env).length} env vars from manifest`));
    runtime.env = env;
  }
  if (memory !== undefined) runtime.memory = memory;
  if (timeout !== undefined) runtime.timeout = timeout;
  if (storage !== undefined) runtime.storage = storage;
  if (Object.keys(runtime).length === 0) return undefined;
  return runtime;
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

// Resolve which project and environment the deploy should target.
// Cascade, in priority order:
//   1. Explicit positional args (back-compat with `appliance deploy <p> <e>`)
//   2. .appliance/link.json (set by a prior setup/deploy in this tree)
//   3. Manifest `name` for project + prompt for env (TTY only)
// Non-TTY without args or link is a hard error with a clear remediation.
async function resolveTarget(
  cliProject: string | undefined,
  cliEnv: string | undefined,
  program: Command,
  yes: boolean
): Promise<{ projectName: string; environmentName: string; source: string }> {
  if (cliProject && cliEnv) {
    return { projectName: cliProject, environmentName: cliEnv, source: 'args' };
  }

  const link = readLink();
  const manifest = await extractApplianceFile(program);

  let projectName = cliProject ?? link?.projectName;
  let environmentName = cliEnv ?? link?.environmentName;
  let source = link ? 'link' : 'args';

  // Fill project from manifest when neither args nor link supplied one.
  if (!projectName && manifest.success && manifest.data.name) {
    projectName = manifest.data.name;
    source = 'manifest';
  }

  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  if (!projectName) {
    if (!isTTY || yes) {
      throw new Error(
        'No project to deploy to. Pass `<project>` as an argument, run `appliance setup` to link this folder, or set a manifest `name`.'
      );
    }
    projectName = await input({ message: 'Project name:' });
    if (!projectName) throw new Error('Project name is required.');
    source = 'prompt';
  }

  if (!environmentName) {
    if (!isTTY || yes) {
      throw new Error(
        'No environment to deploy to. Pass `<environment>` as an argument or run `appliance setup` to link this folder.'
      );
    }
    environmentName = await input({ message: 'Environment name:', default: 'production' });
    if (!environmentName) throw new Error('Environment name is required.');
    source = source === 'link' ? 'link' : 'prompt';
  }

  return { projectName, environmentName, source };
}

// Resolve which build to deploy. Four mutually-exclusive paths:
//   --image-uri <uri>    : register an external image build (no upload)
//   <kubernetes base>    : build the image host-side, push/import it
//                          into the cluster, register a remote-image
//                          build (upload-flow builds aren't supported
//                          by k8s-driven api-servers)
//   <existing zip path>  : upload the existing zip
//   <no zip + default>   : auto-build the manifest into appliance.zip,
//                          then upload it
async function resolveBuildId(
  client: ReturnType<typeof createApplianceClient>,
  program: Command,
  opts: { imageUri?: string; build: string },
  kubernetesBase: ApplianceBaseConfig | null
): Promise<string> {
  if (opts.imageUri) {
    console.log(chalk.dim(`Using image: ${opts.imageUri}`));
    const createResult = await client.createBuild({ uploadUrl: opts.imageUri });
    if (!createResult.success) throw new Error(`Failed to create external build: ${createResult.error.message}`);
    console.log(chalk.dim(`External build created: ${createResult.data.buildId}`));
    return createResult.data.buildId;
  }

  if (kubernetesBase) {
    return resolveKubernetesBuildId(client, program, kubernetesBase);
  }

  const buildPath = path.resolve(opts.build);
  const buildExists = fs.existsSync(buildPath);
  const isDefaultBuildPath = opts.build === DEFAULT_BUILD_OUTPUT;

  if (!buildExists && !isDefaultBuildPath) {
    // User passed an explicit --build path that doesn't exist. Bail
    // with the file they actually wanted — no auto-build surprise.
    throw new Error(`Build not found: ${buildPath}`);
  }

  if (!buildExists) {
    // Default path doesn't exist — auto-build inline so `appliance
    // deploy` works as a single command. Mirrors `vercel` building
    // implicitly before deploy.
    console.log(chalk.dim('No appliance.zip found — building first.'));
    const manifest = await extractApplianceFile(program);
    if (!manifest.success) {
      throw new Error(
        `Cannot auto-build: ${manifest.error.message}. Run \`appliance build\` first, or pass --image-uri / --build <path>.`
      );
    }
    const built = await buildApplianceZip({ appliance: manifest.data, outputPath: buildPath });
    const sizeMb = (built.sizeBytes / 1024 / 1024).toFixed(1);
    console.log(chalk.green(`Built: ${built.outputPath} (${sizeMb} MB)`));
  }

  const buildData = fs.readFileSync(buildPath);
  const sizeMb = (buildData.length / 1024 / 1024).toFixed(1);
  console.log(chalk.dim(`Uploading build (${sizeMb} MB)...`));
  const uploadResult = await client.uploadBuild(buildData);
  if (!uploadResult.success) throw new Error(`Upload failed: ${uploadResult.error.message}`);
  console.log(chalk.dim(`Build uploaded: ${uploadResult.data.buildId}`));
  return uploadResult.data.buildId;
}

// Kubernetes-base build: produce a container image on the host and
// hand the api-server an image reference. The in-cluster api-server
// has no docker daemon, so it rejects zip uploads — image production
// is the CLI's job here, exactly like the desktop's deploy wizard.
async function resolveKubernetesBuildId(
  client: ReturnType<typeof createApplianceClient>,
  program: Command,
  baseConfig: ApplianceBaseConfig
): Promise<string> {
  const manifest = await extractApplianceFile(program);
  if (!manifest.success) {
    throw new Error(
      `This environment deploys container images, and no manifest was found to build one from: ${manifest.error.message}. ` +
        'Pass --image-uri <ref> to deploy a pre-built image.'
    );
  }
  const appliance = manifest.data;
  if (appliance.type !== ApplianceType.container) {
    throw new Error(
      `This environment runs on a Kubernetes base, which deploys container images. ` +
        `"${appliance.type}" appliances can't be built into an image by the CLI yet — ` +
        'add a Dockerfile and switch to `"type": "container"`, or pass --image-uri <ref>.'
    );
  }

  const registryUrl = baseConfig.kubernetes?.registry?.url ?? null;
  const clusterName = baseConfig.local?.cluster?.clusterName;
  const imageRef = await publishLocalApplianceImage({
    name: appliance.name,
    platform: appliance.platform,
    buildScript: appliance.scripts?.build,
    registryUrl,
    clusterName,
  });

  const createResult = await client.createBuild({ uploadUrl: imageRef, port: appliance.port });
  if (!createResult.success) throw new Error(`Failed to create image build: ${createResult.error.message}`);
  console.log(chalk.dim(`Image build created: ${createResult.data.buildId}`));
  return createResult.data.buildId;
}

function formatStatus(d: Deployment): string {
  const base = chalk.dim(d.status);
  return d.message ? `${base} ${chalk.dim('—')} ${d.message}` : base;
}

function printFinalBanner(deployment: Deployment, projectName: string, environmentName: string): void {
  const url = extractDeploymentUrl(deployment.message);
  console.log();
  if (deployment.status === DeploymentStatus.Succeeded) {
    if (deployment.idempotentNoop) {
      console.log(
        `${chalk.cyan(BRAND)} ${chalk.bold('No changes')} — ${projectName}/${environmentName} is up to date.`
      );
    } else {
      console.log(`${chalk.green(BRAND)} ${chalk.bold('Deployed')} ${projectName}/${environmentName}`);
    }
    if (url) {
      console.log(`  ${chalk.bold('URL:')} ${chalk.cyan(url)}`);
    }
  } else if (deployment.status === DeploymentStatus.Cancelled) {
    console.log(`${chalk.yellow(BRAND)} ${chalk.bold('Cancelled')} ${projectName}/${environmentName}`);
    if (deployment.message) console.log(`  ${deployment.message}`);
  } else {
    console.log(`${chalk.red(BRAND)} ${chalk.bold('Failed')} ${projectName}/${environmentName}`);
    if (deployment.message) console.log(`  ${deployment.message}`);
  }
  console.log(`  ${chalk.dim('deployment')} ${deployment.id}`);
}

const program = new Command();

attachProfileOption(program);

registerManifestOptions(program)
  .description('deploy the linked (or named) project/environment')
  .argument('[project]', 'project name (defaults to the linked project, then to the manifest `name`)')
  .argument('[environment]', 'environment name (defaults to the linked environment)')
  .option('-a, --build <path>', 'appliance.zip build to deploy', DEFAULT_BUILD_OUTPUT)
  .option(
    '--image-uri <uri>',
    'reference an already-published image (e.g. ghcr.io/org/app:tag) instead of uploading a build'
  )
  .option('-e, --env-file <path>', 'env file with runtime environment variables')
  .option('-y, --yes', 'skip interactive prompts; fail when input would be needed', false)
  .action(async (cliProject: string | undefined, cliEnvironment: string | undefined) => {
    const opts = program.opts<{
      build: string;
      imageUri?: string;
      envFile?: string;
      file?: string;
      directory?: string;
      variant?: string;
      yes: boolean;
    }>();

    if (opts.imageUri && opts.build !== DEFAULT_BUILD_OUTPUT) {
      console.error(chalk.red('Provide either --image-uri or --build, not both.'));
      process.exit(1);
    }

    const credentials = loadCredentials();
    if (!credentials) {
      console.error(chalk.red('Not logged in. Run `appliance login` first.'));
      process.exit(1);
    }

    const client = createApplianceClient({
      baseUrl: credentials.apiUrl,
      credentials: { keyId: credentials.keyId, secret: credentials.secret },
    });

    try {
      const { projectName, environmentName, source } = await resolveTarget(
        cliProject,
        cliEnvironment,
        program,
        opts.yes
      );

      if (source === 'link') {
        console.log(
          chalk.dim(
            `Deploying linked target: ${chalk.bold(projectName)} → ${chalk.bold(environmentName)} ` +
              `(unlink with \`appliance unlink\`)`
          )
        );
      } else if (source === 'manifest') {
        console.log(chalk.dim(`Deploying ${chalk.bold(projectName)} → ${chalk.bold(environmentName)} (from manifest)`));
      }

      const project = await findOrCreateProject(client, projectName);
      const environment = await findOrCreateEnvironment(client, project.id, projectName, environmentName);

      // Kubernetes-driven bases deploy images, not uploaded zips —
      // probe the server's base type once so the build step can pick
      // the right pipeline. Treat probe failures as "not kubernetes":
      // older api-servers without /cluster-info are cloud-shaped.
      const clusterInfo = await client.getClusterInfo();
      const kubernetesBase =
        clusterInfo.success && isKubernetesBase(clusterInfo.data.baseConfig) ? clusterInfo.data.baseConfig : null;

      const buildId = await resolveBuildId(
        client,
        program,
        { imageUri: opts.imageUri, build: opts.build },
        kubernetesBase
      );

      const manifestRuntime = await renderRuntimeConfig(program, projectName, environmentName);
      const envFileVars = loadEnvFile(opts.envFile, environmentName);

      // --env-file wins on conflict: it's the most local, ad-hoc
      // override surface (typically holds secrets or per-deploy
      // values), while manifest env represents declared defaults.
      const envVars: Record<string, string> | undefined =
        manifestRuntime?.env || envFileVars ? { ...(manifestRuntime?.env ?? {}), ...(envFileVars ?? {}) } : undefined;

      const result = await client.deploy(environment.id, {
        buildId,
        environment: envVars,
        memory: manifestRuntime?.memory,
        timeout: manifestRuntime?.timeout,
        storage: manifestRuntime?.storage,
      });
      if (!result.success) {
        console.error(chalk.red(`Deploy failed: ${result.error.message}`));
        process.exit(1);
      }

      // Persist the link so the next `appliance deploy` (no args)
      // targets the same place. Done after the dispatch succeeds so
      // we don't link to something that never got an id.
      writeLink({
        projectName,
        environmentName,
        apiUrl: credentials.apiUrl,
        profile: getActiveProfileOverride() ?? process.env.APPLIANCE_PROFILE ?? undefined,
      });

      const progress = startProgressLine(`Deploying ${projectName}/${environmentName} — pending`);
      let finalDeployment: Deployment;
      try {
        const { deployment } = await pollDeploymentUntilDone(client, result.data.id, {
          onProgress: (d) => progress.update(`Deploying ${projectName}/${environmentName} — ${formatStatus(d)}`),
        });
        finalDeployment = deployment;
        progress.clear();
      } catch (err) {
        progress.fail(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      printFinalBanner(finalDeployment, projectName, environmentName);

      if (finalDeployment.status !== DeploymentStatus.Succeeded) {
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

program.parse(process.argv);
