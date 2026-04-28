import { Command } from 'commander';
import { execFileSync } from 'child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import archiver from 'archiver';
import { ApplianceType } from '@appliance.sh/sdk';
import type { ApplianceContainer, ApplianceFrameworkApp } from '@appliance.sh/sdk';
import { extractApplianceFile, registerManifestOptions } from './utils/common.js';
import chalk from 'chalk';

const DEFAULT_OUTPUT = 'appliance.zip';

const program = new Command();

registerManifestOptions(program)
  .description('build an appliance and package it as appliance.zip')
  .option('-o, --output <output>', 'output file', DEFAULT_OUTPUT)
  .action(async () => {
    const opts = program.opts();

    // Read the appliance manifest (JSON or TS/JS, resolved by loader).
    const applianceFile = await extractApplianceFile(program);
    if (!applianceFile.success) {
      console.error(chalk.red(applianceFile.error.message));
      process.exit(1);
    }

    const appliance = applianceFile.data;

    // Run the build script if defined
    if (appliance.scripts?.build) {
      console.log(chalk.dim(`Running build: ${appliance.scripts.build}`));
      try {
        execFileSync('/bin/sh', ['-c', appliance.scripts.build], { stdio: 'inherit' });
      } catch {
        console.error(chalk.red('Build script failed.'));
        process.exit(1);
      }
    }

    // Create the zip
    const outputPath = path.resolve(opts.output as string);
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    const done = new Promise<void>((resolve, reject) => {
      output.on('close', resolve);
      archive.on('error', reject);
    });

    archive.pipe(output);

    // Always include the resolved manifest as JSON. For TS/JS
    // manifests the source isn't parseable server-side, so we ship
    // the resolved object (functions already invoked) — the server
    // only ever reads appliance.json from the zip.
    //
    // Strip per-environment runtime config (env, memory, timeout,
    // storage) before archiving so the build artifact stays
    // environment-invariant. The CLI re-renders the manifest with
    // deploy-time context and forwards these via the deploy payload
    // instead — one zip, many deploys, each with its own runtime
    // config.
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
      // "other" type — include everything except common ignores
      packageBundle(archive);
    }

    await archive.finalize();
    await done;

    const stats = fs.statSync(outputPath);
    const sizeMb = (stats.size / 1024 / 1024).toFixed(1);
    console.log(chalk.green(`Built: ${outputPath} (${sizeMb} MB)`));
  });

async function packageContainer(archive: archiver.Archiver, appliance: ApplianceContainer) {
  const { name, platform, port } = appliance;

  // Build the user's image if no build script was already run
  if (!appliance.scripts?.build) {
    console.log(chalk.dim(`Building container: docker build --platform ${platform} --provenance=false -t ${name} .`));
    try {
      execFileSync('docker', ['build', '--platform', platform, '--provenance=false', '-t', name, '.'], {
        stdio: 'inherit',
      });
    } catch {
      console.error(chalk.red('Docker build failed.'));
      process.exit(1);
    }
  }

  // Wrap the user's image with the Lambda Web Adapter
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
      ['build', '--platform', platform, '--provenance=false', '-f', wrapperDockerfile, '-t', lambdaImageName, tmpDir],
      {
        stdio: 'inherit',
      }
    );
  } catch {
    console.error(chalk.red('Failed to inject Lambda Web Adapter.'));
    process.exit(1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Export the Lambda-ready image as a tar archive
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

function packageFramework(archive: archiver.Archiver, appliance: ApplianceFrameworkApp) {
  const framework = appliance.framework === 'auto' ? detectFramework() : appliance.framework;

  // Install dependencies
  installDependencies(framework);

  // Generate run.sh bootstrap script
  const port = appliance.port ?? 8080;
  const startCommand = appliance.scripts?.start ?? defaultStartCommand(framework);
  const lines = ['#!/bin/bash', `export PORT=${port}`];
  if (framework === 'python') {
    lines.push(`source ${PYTHON_VENV_DIR}/bin/activate`);
  }
  lines.push(`exec ${startCommand}`);
  fs.writeFileSync('run.sh', lines.join('\n'), { mode: 0o755 });
  console.log(chalk.dim(`Generated run.sh: ${startCommand}`));

  // Package everything
  packageBundle(archive, framework, appliance.includes, appliance.excludes);

  // Clean up generated files after archiving
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

const PYTHON_VENV_DIR = '.venv';

function installDependencies(framework: string) {
  if (framework === 'python' && fs.existsSync('requirements.txt')) {
    console.log(chalk.dim('Creating virtual environment and installing dependencies...'));
    try {
      execFileSync('python', ['-m', 'venv', PYTHON_VENV_DIR], { stdio: 'inherit' });
      execFileSync(`${PYTHON_VENV_DIR}/bin/pip`, ['install', '-r', 'requirements.txt', '-q'], { stdio: 'inherit' });
    } catch {
      console.error(chalk.red('Failed to install Python dependencies.'));
      process.exit(1);
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

function defaultStartCommand(framework: string): string {
  if (framework === 'python') {
    return 'python app.py';
  }
  if (fs.existsSync('package.json')) {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
    if (pkg.scripts?.start) return 'npm start';
  }
  return 'node index.js';
}

const ALWAYS_EXCLUDES = ['.git/**', '.env', '.env.*', 'appliance.zip', '*.tar'];

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

program.parse(process.argv);
