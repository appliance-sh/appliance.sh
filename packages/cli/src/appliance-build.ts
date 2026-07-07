import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureHelperBinOnPath } from '@appliance.sh/helper';
import { extractApplianceFile, registerManifestOptions } from './utils/common.js';
import { buildApplianceZip } from './utils/build-package.js';
import chalk from 'chalk';

// When invoked directly (commander dispatch covers this too), make
// sure helper-installed docker / kubectl / crane resolve on PATH.
ensureHelperBinOnPath();

const DEFAULT_OUTPUT = 'appliance.zip';

const program = new Command();

registerManifestOptions(program)
  .description('build an appliance and package it as appliance.zip')
  .option('-o, --output <output>', 'output file', DEFAULT_OUTPUT)
  .option(
    '--upload-url <url>',
    'after packaging, PUT the zip to this URL (plumbing: the desktop deploy wizard mints a one-time ' +
      'upload URL via the api-server and drives this command through the bundled CLI); without an ' +
      'explicit -o the zip is written to a temp file and removed after the upload'
  )
  .option(
    '--no-lambda-prep',
    'skip Lambda zip-runtime prep (host-side dependency install + run.sh) for framework apps — pass ' +
      'when the target base builds container images from source'
  )
  .option('--json', 'emit NDJSON progress events (type: log | error | result) instead of human output')
  .action(async () => {
    const opts = program.opts<{ output: string; uploadUrl?: string; lambdaPrep: boolean; json?: boolean }>();
    const json = Boolean(opts.json);
    const emit = (event: object) => console.log(JSON.stringify(event));
    const info = (message: string, human: string = message) =>
      json ? emit({ type: 'log', level: 'info', message }) : console.log(human);
    const fail = (message: string): never => {
      if (json) emit({ type: 'error', error: message });
      else console.error(chalk.red(message));
      return process.exit(1);
    };

    const applianceFile = await extractApplianceFile(program);
    if (!applianceFile.success) {
      return fail(applianceFile.error.message);
    }

    // With --upload-url the zip is a transport detail, not an artifact
    // the user asked to keep: write it into a temp dir unless they
    // named an output explicitly, and always remove the temp copy.
    const outputExplicit = program.getOptionValueSource('output') !== 'default';
    const tempDir =
      opts.uploadUrl && !outputExplicit ? fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-build-')) : null;
    const outputPath = tempDir ? path.join(tempDir, DEFAULT_OUTPUT) : path.resolve(opts.output);

    try {
      const result = await buildApplianceZip({
        appliance: applianceFile.data,
        outputPath,
        lambdaPrep: opts.lambdaPrep,
      });
      const sizeMb = (result.sizeBytes / 1024 / 1024).toFixed(1);
      info(`Built: ${result.outputPath} (${sizeMb} MB)`, chalk.green(`Built: ${result.outputPath} (${sizeMb} MB)`));

      if (opts.uploadUrl) {
        info(`Uploading source (${sizeMb} MB)…`);
        const data = fs.readFileSync(result.outputPath);
        // Raw PUT, mirroring ApplianceClient.uploadBuild: the URL is
        // presigned/one-time-token authorized, so no request signing.
        const res = await fetch(opts.uploadUrl, {
          method: 'PUT',
          headers: { 'content-type': 'application/zip' },
          body: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
          signal: AbortSignal.timeout(300_000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`upload failed: HTTP ${res.status}${body ? `: ${body}` : ''}`);
        }
        info('Source uploaded.', chalk.green('Source uploaded.'));
      }

      if (json) {
        emit({ type: 'result', result: { sizeBytes: result.sizeBytes, uploaded: Boolean(opts.uploadUrl) } });
      }
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

program.parse(process.argv);
