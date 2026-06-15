// Build-and-archive pipeline used by both `appliance build` and the
// auto-build path inside `appliance deploy`. Factored out so the two
// stay in lockstep without spawning a child Node process.
//
// The flow is the same as the legacy appliance-build command:
//   1. Run any user `scripts.build` (sh -c).
//   2. Open a zip stream at `outputPath`.
//   3. Write the resolved manifest (sans per-env runtime overrides).
//   4. Type-specific packaging:
//      - container : `docker build` (if no user script), wrap with the
//        Lambda Web Adapter, `docker save` to image.tar, append.
//      - framework : install deps if applicable, generate `run.sh`,
//        glob the project tree.
//      - other     : glob the project tree as-is.
//   5. Finalize the zip and return its on-disk size.
//
// All console output remains chalk-coloured to match the rest of the
// CLI; deploy's auto-build path calls this directly so the user sees
// one continuous log.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import archiver from 'archiver';
import chalk from 'chalk';
import { ApplianceType } from '@appliance.sh/sdk';
import type { ApplianceFullInput } from '@appliance.sh/sdk';
import { provenanceArgs } from './docker.js';

export interface BuildResult {
  outputPath: string;
  sizeBytes: number;
}

export interface BuildOptions {
  appliance: ApplianceFullInput;
  outputPath: string;
}

const PYTHON_VENV_DIR = '.venv';
const ALWAYS_EXCLUDES = ['.git/**', '.env', '.env.*', 'appliance.zip', '*.tar'];

export async function buildApplianceZip(opts: BuildOptions): Promise<BuildResult> {
  const { appliance, outputPath } = opts;

  if (appliance.scripts?.build) {
    console.log(chalk.dim(`Running build: ${appliance.scripts.build}`));
    try {
      execFileSync('/bin/sh', ['-c', appliance.scripts.build], { stdio: 'inherit' });
    } catch {
      throw new Error('Build script failed.');
    }
  }

  const output = fs.createWriteStream(outputPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  const done = new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
  });

  archive.pipe(output);

  // Strip per-environment runtime config from the archived manifest;
  // those fields are re-rendered per deploy and forwarded via the
  // deploy payload instead. Keeps a build artifact reusable across
  // environments.
  const {
    env: _env,
    memory: _memory,
    timeout: _timeout,
    storage: _storage,
    ...manifestForZip
  } = appliance as typeof appliance & { memory?: number; timeout?: number; storage?: number };
  archive.append(JSON.stringify(manifestForZip, null, 2), { name: 'appliance.json' });

  if (appliance.type === ApplianceType.container) {
    await packageContainer(archive, appliance);
  } else if (appliance.type === ApplianceType.framework) {
    packageFramework(archive, appliance);
  } else {
    packageBundle(archive);
  }

  await archive.finalize();
  await done;

  const stats = fs.statSync(outputPath);
  return { outputPath, sizeBytes: stats.size };
}

type ContainerAppliance = Extract<ApplianceFullInput, { type: 'container' }>;
type FrameworkAppliance = Extract<ApplianceFullInput, { type: 'framework' }>;

async function packageContainer(archive: archiver.Archiver, appliance: ContainerAppliance) {
  const { name, platform, port } = appliance;

  if (!appliance.scripts?.build) {
    const buildArgs = ['build', '--platform', platform, ...provenanceArgs(), '-t', name, '.'];
    console.log(chalk.dim(`Building container: docker ${buildArgs.join(' ')}`));
    try {
      execFileSync('docker', buildArgs, {
        stdio: 'inherit',
      });
    } catch {
      throw new Error('Docker build failed.');
    }
  }

  console.log(chalk.dim('Injecting Lambda Web Adapter...'));
  const lambdaImageName = `${name}-lambda`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-wrap-'));
  const wrapperDockerfile = path.join(tmpDir, 'Dockerfile.lambda');

  try {
    fs.writeFileSync(
      wrapperDockerfile,
      [
        `FROM --platform=${platform} public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 AS adapter`,
        `FROM ${name}`,
        `COPY --from=adapter /lambda-adapter /opt/extensions/lambda-adapter`,
        `ENV AWS_LWA_PORT=${port}`,
      ].join('\n')
    );
    execFileSync(
      'docker',
      ['build', '--platform', platform, ...provenanceArgs(), '-f', wrapperDockerfile, '-t', lambdaImageName, tmpDir],
      { stdio: 'inherit' }
    );
  } catch {
    throw new Error('Failed to inject Lambda Web Adapter.');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(chalk.dim(`Exporting image: ${lambdaImageName}`));
  const imageTar = `${name}-image.tar`;
  try {
    execFileSync('docker', ['save', '-o', imageTar, lambdaImageName], { stdio: 'inherit' });
    archive.file(path.resolve(imageTar), { name: 'image.tar' });
  } finally {
    archive.on('end', () => {
      try {
        fs.unlinkSync(imageTar);
      } catch {
        // ignore cleanup errors
      }
    });
  }
}

function packageFramework(archive: archiver.Archiver, appliance: FrameworkAppliance) {
  const framework = appliance.framework === 'auto' ? detectFramework() : appliance.framework;

  installDependencies(framework);

  const port = appliance.port ?? 8080;
  const startCommand = appliance.scripts?.start ?? defaultStartCommand(framework);
  const lines = ['#!/bin/bash', `export PORT=${port}`];
  if (framework === 'python') {
    lines.push(`source ${PYTHON_VENV_DIR}/bin/activate`);
  }
  lines.push(`exec ${startCommand}`);
  fs.writeFileSync('run.sh', lines.join('\n'), { mode: 0o755 });
  console.log(chalk.dim(`Generated run.sh: ${startCommand}`));

  packageBundle(archive, framework, appliance.includes, appliance.excludes);

  archive.on('end', () => {
    try {
      fs.unlinkSync('run.sh');
    } catch {
      // ignore
    }
    try {
      fs.rmSync(PYTHON_VENV_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
}

function installDependencies(framework: string | undefined) {
  if (framework === 'python' && fs.existsSync('requirements.txt')) {
    console.log(chalk.dim('Creating virtual environment and installing dependencies...'));
    try {
      execFileSync('python', ['-m', 'venv', PYTHON_VENV_DIR], { stdio: 'inherit' });
      execFileSync(`${PYTHON_VENV_DIR}/bin/pip`, ['install', '-r', 'requirements.txt', '-q'], { stdio: 'inherit' });
    } catch {
      throw new Error('Failed to install Python dependencies.');
    }
  }
}

function detectFramework(): string {
  if (fs.existsSync('package.json')) return 'node';
  if (fs.existsSync('requirements.txt')) return 'python';
  if (fs.existsSync('Pipfile')) return 'python';
  if (fs.existsSync('pyproject.toml')) return 'python';
  return 'node';
}

function defaultStartCommand(framework: string | undefined): string {
  if (framework === 'python') {
    return 'python app.py';
  }
  if (fs.existsSync('package.json')) {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
    if (pkg.scripts?.start) return 'npm start';
  }
  return 'node index.js';
}

function packageBundle(archive: archiver.Archiver, framework?: string, includes?: string[], excludes?: string[]) {
  const defaultExcludes = framework === 'node' ? [] : ['node_modules/**'];
  const ignorePatterns = [...ALWAYS_EXCLUDES, ...defaultExcludes, ...(excludes ?? [])];

  if (includes && includes.length > 0) {
    for (const pattern of includes) {
      archive.glob(pattern, { ignore: ignorePatterns });
    }
  } else {
    archive.glob('**/*', { ignore: ignorePatterns });
  }
}
