// Build-and-archive pipeline used by both `appliance build` and the
// auto-build path inside `appliance deploy`. Factored out so the two
// stay in lockstep without spawning a child Node process.
//
// An appliance.zip is SOURCE, not an image: manifest + project tree.
// Images are built server-side by the api-server (BuildKit against
// the base's builder) — the CLI needs no docker/buildctl/crane.
//
//   1. Run any user `scripts.build` (platform shell).
//   2. Open a zip stream at `outputPath`.
//   3. Write the resolved manifest (sans per-env runtime overrides).
//   4. Type-specific packaging:
//      - container : glob the project tree (Dockerfile + source),
//        honoring .dockerignore.
//      - framework : glob the project tree; for Lambda targets only,
//        additionally pre-install deps + generate `run.sh` (the Lambda
//        zip runtime executes the tree as-is — no image build there).
//      - other     : glob the project tree as-is.
//   5. Finalize the zip and return its on-disk size.
//
// All console output remains chalk-coloured to match the rest of the
// CLI; deploy's auto-build path calls this directly so the user sees
// one continuous log.

import * as fs from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import archiver from 'archiver';
import chalk from 'chalk';
import { ApplianceType } from '@appliance.sh/sdk';
import type { ApplianceFullInput } from '@appliance.sh/sdk';

export interface BuildResult {
  outputPath: string;
  sizeBytes: number;
}

export interface BuildOptions {
  appliance: ApplianceFullInput;
  outputPath: string;
  /**
   * Prepare framework apps for the Lambda zip runtime (host-side
   * dependency install + run.sh). Only the cloud/Lambda base consumes
   * zips this way; container-runtime bases build an image from the
   * source server-side and ignore the prep. Defaults to true so a
   * standalone `appliance build` artifact deploys anywhere.
   */
  lambdaPrep?: boolean;
}

const PYTHON_VENV_DIR = '.venv';
const ALWAYS_EXCLUDES = ['.git/**', '.env', '.env.*', 'appliance.zip', '*.tar'];

export async function buildApplianceZip(opts: BuildOptions): Promise<BuildResult> {
  const { appliance, outputPath, lambdaPrep = true } = opts;

  if (appliance.scripts?.build) {
    console.log(chalk.dim(`Running build: ${appliance.scripts.build}`));
    try {
      // Platform shell (`cmd.exe` on Windows, `/bin/sh` elsewhere) —
      // the script is the user's own contract with their machine.
      execSync(appliance.scripts.build, { stdio: 'inherit' });
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
    packageContainerSource(archive);
  } else if (appliance.type === ApplianceType.framework) {
    packageFramework(archive, appliance, lambdaPrep);
  } else {
    packageBundle(archive);
  }

  await archive.finalize();
  await done;

  const stats = fs.statSync(outputPath);
  return { outputPath, sizeBytes: stats.size };
}

type FrameworkAppliance = Extract<ApplianceFullInput, { type: 'framework' }>;

/**
 * Container appliances ship their build context: Dockerfile + source.
 * `.dockerignore` patterns are honored so the zip matches what a
 * local `docker build .` would have sent to the daemon.
 */
function packageContainerSource(archive: archiver.Archiver) {
  if (!fs.existsSync('Dockerfile')) {
    throw new Error('Container appliances need a Dockerfile next to appliance.json.');
  }
  console.log(chalk.dim('Packaging container build context (built server-side).'));
  packageBundle(archive, undefined, undefined, readDockerignore());
}

/** Best-effort .dockerignore → glob ignore patterns (skips negations). */
function readDockerignore(): string[] | undefined {
  if (!fs.existsSync('.dockerignore')) return undefined;
  return fs
    .readFileSync('.dockerignore', 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
    .map((l) => (l.endsWith('/') ? `${l}**` : l));
}

function packageFramework(archive: archiver.Archiver, appliance: FrameworkAppliance, lambdaPrep: boolean) {
  const framework = appliance.framework === 'auto' ? detectFramework() : appliance.framework;

  if (!lambdaPrep) {
    // Container-runtime target: the server generates a Dockerfile and
    // builds from source — dependencies install inside the image, so
    // host node_modules/venvs are excluded noise, not payload.
    console.log(chalk.dim('Packaging framework source (built server-side).'));
    packageBundle(archive, undefined, appliance.includes, appliance.excludes);
    return;
  }

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
