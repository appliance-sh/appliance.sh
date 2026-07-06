import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { input } from '@inquirer/prompts';
import {
  ApplianceType,
  createApplianceClient,
  DeploymentStatus,
  isDockerBase,
  isKubernetesBase,
} from '@appliance.sh/sdk';
import type { ApplianceBaseConfig, Project, Environment, Deployment } from '@appliance.sh/sdk';
import { getActiveProfileOverride } from './credentials.js';
import { extractApplianceFile, resolveApplianceDir } from './common.js';
import { buildApplianceZip } from './build-package.js';
import { buildLocalApplianceImage, publishLocalApplianceImage } from './local-image.js';
import { readLink, writeLink } from './link.js';
import { pollDeploymentUntilDone, extractDeploymentUrl } from './deploy-poll.js';
import { startProgressLine, BRAND } from './progress.js';
import chalk from 'chalk';

// The deploy engine, shared by `appliance deploy` (single app in cwd)
// and `appliance stack deploy` (fan-out over a collection). Everything
// here throws instead of process.exit-ing so an orchestrator can run
// several deploys in one process and still print a summary.

export const DEFAULT_BUILD_OUTPUT = 'appliance.zip';

// Error whose message has already been rendered to the terminal (e.g.
// via a progress line's fail state). Callers should exit/continue
// without printing it again.
export class PrintedError extends Error {
  readonly printed = true;
}

export function isPrintedError(err: unknown): err is PrintedError {
  return err instanceof Error && (err as PrintedError).printed === true;
}

export interface DeployOptions {
  /** Path to an appliance.zip; DEFAULT_BUILD_OUTPUT triggers auto-build. */
  build: string;
  /** Deploy an already-published image instead of uploading a build. */
  imageUri?: string;
  /** Env file with runtime variables; defaults to `.env.<environment>`. */
  envFile?: string;
  /** Pre-resolved deploy-time env from an orchestrator (stack deploy's
   *  wiring). Beats manifest env, loses to --env-file. */
  extraEnv?: Record<string, string>;
  /** Never prompt; fail when input would be needed. */
  yes: boolean;
}

export interface DeployOutcome {
  deployment: Deployment;
  projectName: string;
  environmentName: string;
  url?: string;
}

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

export async function findOrCreateProject(
  client: ReturnType<typeof createApplianceClient>,
  name: string
): Promise<Project> {
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

export async function findOrCreateEnvironment(
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
  replicas?: number;
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
    throw new Error(`Failed to render manifest runtime config: ${result.error.message}`);
  }
  const { env, memory, timeout, storage, replicas } = result.data;
  const runtime: RenderedRuntime = {};
  if (env && Object.keys(env).length > 0) {
    console.log(chalk.dim(`Rendered ${Object.keys(env).length} env vars from manifest`));
    runtime.env = env;
  }
  if (memory !== undefined) runtime.memory = memory;
  if (timeout !== undefined) runtime.timeout = timeout;
  if (storage !== undefined) runtime.storage = storage;
  if (replicas !== undefined) runtime.replicas = replicas;
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
    throw new Error(`Env file not found: ${envFilePath}`);
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

// Resolve which build to deploy. Five mutually-exclusive paths:
//   --image-uri <uri>    : register an external image build (no upload)
//   <docker base>        : build the image into the local docker daemon
//                          and register its image ID — the server runs
//                          containers on the same daemon, so there is
//                          no push at all
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
  kubernetesBase: ApplianceBaseConfig | null,
  dockerBase: ApplianceBaseConfig | null
): Promise<string> {
  if (opts.imageUri) {
    console.log(chalk.dim(`Using image: ${opts.imageUri}`));
    const createResult = await client.createBuild({ uploadUrl: opts.imageUri });
    if (!createResult.success) throw new Error(`Failed to create external build: ${createResult.error.message}`);
    console.log(chalk.dim(`External build created: ${createResult.data.buildId}`));
    return createResult.data.buildId;
  }

  if (dockerBase) {
    return resolveDockerBuildId(client, program);
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

// Docker-base build (the local daemon runtime): build the image into
// the SAME docker daemon the server deploys from and register its
// immutable image ID. No registry, no push, no delivery — the fastest
// local loop there is.
async function resolveDockerBuildId(
  client: ReturnType<typeof createApplianceClient>,
  program: Command
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
      `This environment runs on the local Docker runtime, which deploys container images. ` +
        `"${appliance.type}" appliances can't be built into an image by the CLI yet — ` +
        'add a Dockerfile and switch to `"type": "container"`, or pass --image-uri <ref>.'
    );
  }

  // The containers run on this machine's daemon — pin the build to the
  // host arch like the microVM path does, so a manifest that targets a
  // cloud platform doesn't produce an emulated (or unrunnable) image.
  const hostArch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  if (!appliance.scripts?.build && appliance.platform && !appliance.platform.endsWith(hostArch)) {
    console.log(
      chalk.yellow(
        `Manifest platform "${appliance.platform}" targets a different architecture — building linux/${hostArch} for the local daemon instead.`
      )
    );
  }
  const imageId = await buildLocalApplianceImage({
    name: appliance.name,
    platform: appliance.scripts?.build ? undefined : `linux/${hostArch}`,
    buildScript: appliance.scripts?.build,
    context: resolveApplianceDir(program),
  });

  const createResult = await client.createBuild({ uploadUrl: imageId, port: appliance.port });
  if (!createResult.success) throw new Error(`Failed to create image build: ${createResult.error.message}`);
  console.log(chalk.dim(`Image build created: ${createResult.data.buildId} (${imageId.slice(0, 19)}…)`));
  return createResult.data.buildId;
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

  // Loopback registries mean the cluster runs on this machine, and it
  // can't emulate — the microVM has no binfmt. A cross-arch image just
  // crashloops with `exec format error` after an opaque rollout timeout,
  // so pin the build to
  // the host arch for local targets regardless of the manifest's
  // `platform` (which typically targets a cloud runtime). The override
  // doesn't touch a user `scripts.build` — that script owns its arch.
  const registryUrl = baseConfig.kubernetes?.registry?.url ?? null;
  const hostArch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const isLocalTarget = registryUrl?.startsWith('localhost') ?? false;
  // Widen to string: a local override produces a plain `linux/<arch>`
  // ref, and publishLocalApplianceImage takes a string platform.
  let platform: string | undefined = appliance.platform;
  if (isLocalTarget) {
    if (!appliance.scripts?.build && appliance.platform && !appliance.platform.endsWith(hostArch)) {
      console.log(
        chalk.yellow(
          `Manifest platform "${appliance.platform}" can't run on this local cluster (linux/${hostArch}) — ` +
            `building linux/${hostArch} instead.`
        )
      );
    }
    platform = `linux/${hostArch}`;
  }
  const imageRef = await publishLocalApplianceImage({
    name: appliance.name,
    platform,
    buildScript: appliance.scripts?.build,
    registryUrl,
    // Build the appliance's own directory (honors -d/-f), not whatever
    // cwd the deploy was invoked from.
    context: resolveApplianceDir(program),
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

export function printFinalBanner(deployment: Deployment, projectName: string, environmentName: string): void {
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

export interface RunDeployParams {
  client: ReturnType<typeof createApplianceClient>;
  /** API server URL the client points at (for the link file). */
  apiUrl: string;
  /** Commander instance carrying the -f/-d/--variant manifest options. */
  program: Command;
  cliProject?: string;
  cliEnvironment?: string;
  opts: DeployOptions;
}

// One full deploy: resolve target, find-or-create project + environment,
// resolve/produce the build, dispatch, write the link, poll to a
// terminal state, and print the final banner. Returns the outcome (the
// caller decides the exit code); throws on any pre-terminal failure.
export async function runDeploy(params: RunDeployParams): Promise<DeployOutcome> {
  const { client, apiUrl, program, opts } = params;

  const { projectName, environmentName, source } = await resolveTarget(
    params.cliProject,
    params.cliEnvironment,
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

  // Container-runtime bases deploy images, not uploaded zips — probe
  // the server's base type once so the build step can pick the right
  // pipeline. Treat probe failures as "cloud-shaped": older
  // api-servers without /cluster-info predate the container runtimes.
  const clusterInfo = await client.getClusterInfo();
  const baseConfig = clusterInfo.success ? clusterInfo.data.baseConfig : null;
  const kubernetesBase = baseConfig && isKubernetesBase(baseConfig) ? baseConfig : null;
  const dockerBase = baseConfig && isDockerBase(baseConfig) ? baseConfig : null;

  const buildId = await resolveBuildId(
    client,
    program,
    { imageUri: opts.imageUri, build: opts.build },
    kubernetesBase,
    dockerBase
  );

  const manifestRuntime = await renderRuntimeConfig(program, projectName, environmentName);
  const envFileVars = loadEnvFile(opts.envFile, environmentName);

  // Cascade, least to most local: manifest env (declared defaults) <
  // orchestrator extraEnv (stack wiring) < --env-file (ad-hoc,
  // per-deploy overrides, typically secrets).
  const envVars: Record<string, string> | undefined =
    manifestRuntime?.env || opts.extraEnv || envFileVars
      ? { ...(manifestRuntime?.env ?? {}), ...(opts.extraEnv ?? {}), ...(envFileVars ?? {}) }
      : undefined;

  const result = await client.deploy(environment.id, {
    buildId,
    environment: envVars,
    memory: manifestRuntime?.memory,
    timeout: manifestRuntime?.timeout,
    storage: manifestRuntime?.storage,
    replicas: manifestRuntime?.replicas,
  });
  if (!result.success) {
    // Throw rather than print-and-exit so the caller's shared handler
    // attaches a remediation line (auth/cluster/network shapes).
    throw new Error(`Deploy failed: ${result.error.message}`);
  }

  // Persist the link so the next `appliance deploy` (no args)
  // targets the same place. Done after the dispatch succeeds so
  // we don't link to something that never got an id.
  writeLink({
    projectName,
    environmentName,
    apiUrl,
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
    const message = err instanceof Error ? err.message : String(err);
    progress.fail(chalk.red(message));
    throw new PrintedError(message);
  }

  printFinalBanner(finalDeployment, projectName, environmentName);

  return {
    deployment: finalDeployment,
    projectName,
    environmentName,
    url: extractDeploymentUrl(finalDeployment.message) ?? undefined,
  };
}
