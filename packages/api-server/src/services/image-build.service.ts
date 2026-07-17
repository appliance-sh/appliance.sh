import { applianceInput, ApplianceType } from '@appliance.sh/sdk';
import type { ApplianceInput } from '@appliance.sh/sdk';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { logger } from '../logger';

// Server-side image builds. Every base builds images the same way:
// the api-server extracts an uploaded source zip, ensures a Dockerfile
// (generating one for `framework` apps), and drives BuildKit
// (`buildctl`) to build + push the image to the base's registry.
// Locally that's the in-guest buildkitd unix socket + in-VM registry;
// on cloud it's the base's BuildKit instance + ECR. The CLI never
// builds images — it only uploads source or passes an image reference.

export interface BuildKitBuildOptions {
  /** Build context directory (extracted source). */
  contextDir: string;
  /** Fully-qualified tag ref to push, e.g. `localhost:5052/my-app:build_x`. */
  ref: string;
  /** buildkitd address, e.g. `unix:///run/buildkit/buildkitd.sock` or `tcp://…`. */
  addr: string;
  /** Push with `registry.insecure=true` (plain-HTTP registries). */
  insecure?: boolean;
  /** linux/<arch> platform, or undefined for the builder's native arch. */
  platform?: string;
  /** Extra env for buildctl (e.g. DOCKER_CONFIG for registry auth). */
  env?: Record<string, string>;
}

/** Max accepted upload size for direct build-content PUTs. */
export function maxBuildContentBytes(): number {
  const raw = process.env.APPLIANCE_MAX_BUILD_SIZE_MB;
  const mb = raw ? Number.parseInt(raw, 10) : NaN;
  return (Number.isFinite(mb) && mb > 0 ? mb : 512) * 1024 * 1024;
}

/** Where an upload build's zip lives under a filesystem dataDir. */
export function buildZipPath(dataDir: string, buildId: string): string {
  // buildIds are server-generated (`build_<uuid>`), but stay defensive
  // against traversal the same way FilesystemObjectStore does.
  const resolved = path.resolve(dataDir, 'builds', `${buildId}.zip`);
  if (!resolved.startsWith(path.resolve(dataDir) + path.sep)) {
    throw new Error(`Refusing build path outside data dir: ${buildId}`);
  }
  return resolved;
}

export class BuildContentTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Build content exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit`);
  }
}

/**
 * Stream an incoming request body to the build's zip path, enforcing
 * the size cap. Writes to `<path>.tmp` and renames so a failed or
 * oversized upload never leaves a plausible-looking zip behind.
 */
export async function writeBuildContent(
  dataDir: string,
  buildId: string,
  body: NodeJS.ReadableStream
): Promise<number> {
  const dest = buildZipPath(dataDir, buildId);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  const max = maxBuildContentBytes();
  let received = 0;
  const capped = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      if (received > max) {
        cb(new BuildContentTooLargeError(max));
        return;
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(body, capped, fs.createWriteStream(tmp));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.renameSync(tmp, dest);
  return received;
}

/**
 * Validate and extract a build zip into `destDir`. Rejects path
 * traversal (`../` entries) before extraction and symlinks after —
 * uploaded zips are caller-controlled content.
 */
export function extractZipSafely(zipPath: string, destDir: string): void {
  const entries = execFileSync('zipinfo', ['-1', zipPath], { encoding: 'utf-8' }).trim().split('\n');
  for (const entryPath of entries) {
    const resolved = path.resolve(destDir, entryPath);
    if (!resolved.startsWith(destDir + path.sep) && resolved !== destDir) {
      throw new Error(`Zip contains path traversal: ${entryPath}`);
    }
  }

  execFileSync('unzip', ['-o', '-q', zipPath, '-d', destDir], { stdio: 'pipe' });

  for (const entryPath of entries) {
    const fullPath = path.join(destDir, entryPath);
    if (fs.existsSync(fullPath) && fs.lstatSync(fullPath).isSymbolicLink()) {
      throw new Error(`Zip contains symlink: ${entryPath}`);
    }
  }
}

/** Read and validate the `appliance.json` manifest in an extracted build. */
export function readBuildManifest(dir: string): ApplianceInput {
  const manifestPath = path.join(dir, 'appliance.json');
  if (!fs.existsSync(manifestPath)) throw new Error('Build missing appliance.json');
  return applianceInput.parse(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')));
}

function detectFramework(dir: string): 'node' | 'python' {
  if (fs.existsSync(path.join(dir, 'package.json'))) return 'node';
  if (fs.existsSync(path.join(dir, 'requirements.txt'))) return 'python';
  if (fs.existsSync(path.join(dir, 'Pipfile'))) return 'python';
  if (fs.existsSync(path.join(dir, 'pyproject.toml'))) return 'python';
  return 'node';
}

function nodeStartCommand(dir: string, scripts?: Record<string, string>): string {
  if (scripts?.start) return scripts.start;
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, string> };
      if (pkg.scripts?.start) return 'npm start';
    } catch {
      // fall through to the default
    }
  }
  return 'node index.js';
}

/**
 * Generate a Dockerfile for a `framework` appliance so framework apps
 * are first-class on every base — no user Dockerfile, no host-side
 * dependency install. Exported for tests (pure given the dir's files).
 */
export function generateFrameworkDockerfile(
  manifest: Extract<ApplianceInput, { type: ApplianceType.framework }>,
  dir: string
): string {
  const framework = !manifest.framework || manifest.framework === 'auto' ? detectFramework(dir) : manifest.framework;
  const port = manifest.port ?? 8080;

  if (framework === 'python') {
    const start = manifest.scripts?.start ?? 'python app.py';
    return [
      'FROM python:3.13-slim',
      'WORKDIR /app',
      'COPY . .',
      'RUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi',
      `ENV PORT=${port}`,
      `EXPOSE ${port}`,
      `CMD ["sh", "-c", ${JSON.stringify(start)}]`,
      '',
    ].join('\n');
  }

  // node (and unknown frameworks — same default as the legacy run.sh path)
  const start = nodeStartCommand(dir, manifest.scripts);
  const hasPnpmLock = fs.existsSync(path.join(dir, 'pnpm-lock.yaml'));
  const hasNpmLock = fs.existsSync(path.join(dir, 'package-lock.json'));
  const install = hasPnpmLock
    ? 'RUN corepack enable && pnpm install --frozen-lockfile --prod'
    : hasNpmLock
      ? 'RUN npm ci --omit=dev'
      : 'RUN if [ -f package.json ]; then npm install --omit=dev; fi';
  return [
    'FROM node:22-alpine',
    'WORKDIR /app',
    'COPY . .',
    install,
    `ENV PORT=${port} NODE_ENV=production`,
    `EXPOSE ${port}`,
    `CMD ["sh", "-c", ${JSON.stringify(start)}]`,
    '',
  ].join('\n');
}

/**
 * Make sure an extracted build has a Dockerfile to build from.
 * `container` builds must ship their own; `framework` builds get a
 * generated one (an existing Dockerfile wins — it's the escape hatch
 * for generation misses). Returns the effective app port for Service
 * wiring, and whether the Dockerfile was generated.
 */
export function ensureDockerfile(
  dir: string,
  manifest: ApplianceInput
): { port: number | undefined; generated: boolean } {
  const dockerfile = path.join(dir, 'Dockerfile');
  const hasDockerfile = fs.existsSync(dockerfile);

  if (manifest.type === ApplianceType.container) {
    if (!hasDockerfile) {
      throw new Error(
        'Container build has no Dockerfile. Add one next to appliance.json, or deploy a pre-built image with --image-uri.'
      );
    }
    return { port: manifest.port, generated: false };
  }

  if (manifest.type === ApplianceType.framework) {
    if (!hasDockerfile) {
      const content = generateFrameworkDockerfile(manifest, dir);
      fs.writeFileSync(dockerfile, content);
      logger.info('generated framework Dockerfile', { framework: manifest.framework });
      return { port: manifest.port ?? 8080, generated: true };
    }
    return { port: manifest.port ?? 8080, generated: false };
  }

  throw new Error(
    `"${manifest.type}" appliances can't be built into a container image. ` +
      'Use type "container" (with a Dockerfile) or "framework", or deploy a pre-built image with --image-uri.'
  );
}

/**
 * Build the Dockerfile in `contextDir` with BuildKit and push the
 * result to the registry named in `ref`. Returns the digest-qualified
 * reference (`<repo>@sha256:…`) so deploys are immutable.
 */
export async function buildImageWithBuildKit(opts: BuildKitBuildOptions): Promise<string> {
  const metadataFile = path.join(os.tmpdir(), `appliance-imgbuild-${process.pid}-${Date.now()}.json`);
  const args = [
    '--addr',
    opts.addr,
    'build',
    '--frontend',
    'dockerfile.v0',
    '--local',
    `context=${opts.contextDir}`,
    '--local',
    `dockerfile=${opts.contextDir}`,
    ...(opts.platform ? ['--opt', `platform=${opts.platform}`] : []),
    '--output',
    `type=image,name=${opts.ref},push=true${opts.insecure ? ',registry.insecure=true' : ''}`,
    '--metadata-file',
    metadataFile,
  ];

  try {
    await runCapture('buildctl', args, opts.env);
    const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf-8')) as Record<string, unknown>;
    const digest = metadata['containerimage.digest'];
    if (typeof digest !== 'string' || !digest.startsWith('sha256:')) {
      throw new Error('buildctl metadata carried no containerimage.digest');
    }
    const repo = opts.ref.includes('@') ? opts.ref.split('@')[0] : opts.ref.replace(/:[^:/]+$/, '');
    return `${repo}@${digest}`;
  } finally {
    fs.rmSync(metadataFile, { force: true });
  }
}

/** Run a command, capturing output; on failure throw with the tail. */
function runCapture(cmd: string, args: string[], extraEnv?: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...(extraEnv ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', (err) => reject(new Error(`${cmd} not available: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const output = Buffer.concat(chunks).toString('utf-8');
      const tail = output.split('\n').slice(-25).join('\n').trim();
      reject(new Error(`${cmd} failed (exit ${code ?? 'signal'})${tail ? `:\n${tail}` : ''}`));
    });
  });
}

export interface KubernetesUploadBuildParams {
  buildId: string;
  dataDir: string;
  registry: { url: string; insecure?: boolean };
  buildkitAddr: string;
}

/**
 * The Kubernetes-base upload pipeline: extract the uploaded source
 * zip, ensure/generate a Dockerfile, build with the base's buildkitd,
 * push to the base's registry. Returns the deployable image reference
 * and the app port for Service wiring.
 */
export async function resolveKubernetesUpload(
  params: KubernetesUploadBuildParams
): Promise<{ imageUri: string; localPort?: number }> {
  const zipPath = buildZipPath(params.dataDir, params.buildId);
  if (!fs.existsSync(zipPath)) {
    throw new Error(`Build content not uploaded yet: ${params.buildId}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-build-'));
  try {
    extractZipSafely(zipPath, tmpDir);
    const manifest = readBuildManifest(tmpDir);
    const { port } = ensureDockerfile(tmpDir, manifest);

    // Build on the base's own builder: native arch, no platform pin —
    // the builder IS the machine the image will run on.
    const ref = `${params.registry.url}/${manifest.name}:${params.buildId}`;
    logger.info('building image server-side', { buildId: params.buildId, ref, type: manifest.type });
    const imageUri = await buildImageWithBuildKit({
      contextDir: tmpDir,
      ref,
      addr: params.buildkitAddr,
      insecure: params.registry.insecure ?? true,
    });
    logger.info('image built', { buildId: params.buildId, imageUri });
    return { imageUri, localPort: port };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
