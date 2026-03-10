import { Command } from 'commander';
import { execSync } from 'child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import archiver from 'archiver';
import { ApplianceType } from '@appliance.sh/sdk';
import { extractApplianceFile } from './utils/common.js';
import chalk from 'chalk';

const DEFAULT_OUTPUT = 'appliance.zip';

const program = new Command();

program
  .description('build an appliance and package it as appliance.zip')
  .option('-f, --file <file>', 'appliance manifest file', 'appliance.json')
  .option('-d, --directory <directory>', 'appliance directory')
  .option('-o, --output <output>', 'output file', DEFAULT_OUTPUT)
  .action(async () => {
    const opts = program.opts();
    const manifestPath = opts.file as string;

    // Read appliance.json
    const applianceFile = extractApplianceFile(program);
    if (!applianceFile.success) {
      console.error(chalk.red('Could not read appliance manifest. Run `appliance configure` first.'));
      process.exit(1);
    }

    const appliance = applianceFile.data;

    // Run the build script if defined
    if (appliance.scripts?.build) {
      console.log(chalk.dim(`Running build: ${appliance.scripts.build}`));
      try {
        execSync(appliance.scripts.build, { stdio: 'inherit' });
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

    // Always include the manifest
    archive.file(path.resolve(manifestPath), { name: 'appliance.json' });

    if (appliance.type === ApplianceType.container) {
      await packageContainer(archive, appliance.name, appliance.platform, appliance.scripts?.build);
    } else if (appliance.type === ApplianceType.framework) {
      const framework = appliance.framework === 'auto' ? detectFramework() : appliance.framework;
      installDependencies(framework);
      packageBundle(archive, framework, appliance.includes, appliance.excludes);
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

async function packageContainer(archive: archiver.Archiver, name: string, platform: string, buildScript?: string) {
  // Build the image if no build script was already run (default docker build)
  const imageTag = name;
  if (!buildScript) {
    console.log(
      chalk.dim(`Building container: docker build --platform ${platform} --provenance=false -t ${imageTag} .`)
    );
    try {
      execSync(`docker build --platform ${platform} --provenance=false -t ${imageTag} .`, { stdio: 'inherit' });
    } catch {
      console.error(chalk.red('Docker build failed.'));
      process.exit(1);
    }
  }

  // Export the container image as a tar archive
  console.log(chalk.dim(`Exporting image layers: ${imageTag}`));
  const imageTar = `${imageTag}-image.tar`;
  try {
    execSync(`docker save -o ${imageTar} ${imageTag}`, { stdio: 'inherit' });
    archive.file(path.resolve(imageTar), { name: 'image.tar' });
  } finally {
    // Clean up the tar after archiving finalizes
    archive.on('end', () => {
      try {
        fs.unlinkSync(imageTar);
      } catch {
        // ignore cleanup errors
      }
    });
  }
}

function installDependencies(framework: string) {
  if (framework === 'python' && fs.existsSync('requirements.txt')) {
    console.log(chalk.dim('Installing Python dependencies...'));
    try {
      execSync('pip install -r requirements.txt -t . -q', { stdio: 'inherit' });
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
