import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ApplianceType, applianceInput } from '@appliance.sh/sdk';
import type { ApplianceInput } from '@appliance.sh/sdk';
import {
  buildZipPath,
  ensureDockerfile,
  generateFrameworkDockerfile,
  maxBuildContentBytes,
  writeBuildContent,
  BuildContentTooLargeError,
} from './image-build.service';
import { Readable } from 'node:stream';

type FrameworkManifest = Extract<ApplianceInput, { type: ApplianceType.framework }>;

function frameworkManifest(overrides: Record<string, unknown> = {}): FrameworkManifest {
  return applianceInput.parse({
    manifest: 'v1',
    type: 'framework',
    name: 'my-app',
    framework: 'node',
    ...overrides,
  }) as FrameworkManifest;
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgbuild-spec-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('generateFrameworkDockerfile', () => {
  it('generates a node Dockerfile with npm ci when package-lock exists', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node server.js' } }));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    const content = generateFrameworkDockerfile(frameworkManifest(), dir);
    expect(content).toContain('FROM node:22-alpine');
    expect(content).toContain('npm ci --omit=dev');
    expect(content).toContain('ENV PORT=8080');
    expect(content).toContain('"npm start"');
  });

  it('prefers pnpm when a pnpm lockfile exists', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    const content = generateFrameworkDockerfile(frameworkManifest(), dir);
    expect(content).toContain('corepack enable && pnpm install --frozen-lockfile --prod');
  });

  it('falls back to plain npm install without a lockfile', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    const content = generateFrameworkDockerfile(frameworkManifest(), dir);
    expect(content).toContain('npm install --omit=dev');
  });

  it('uses scripts.start over package.json start', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node server.js' } }));
    const content = generateFrameworkDockerfile(frameworkManifest({ scripts: { start: 'node custom.js' } }), dir);
    expect(content).toContain('"node custom.js"');
  });

  it('defaults to node index.js without any start script', () => {
    const content = generateFrameworkDockerfile(frameworkManifest(), dir);
    expect(content).toContain('"node index.js"');
  });

  it('generates a python Dockerfile with requirements install', () => {
    fs.writeFileSync(path.join(dir, 'requirements.txt'), 'flask');
    const content = generateFrameworkDockerfile(frameworkManifest({ framework: 'python', port: 5000 }), dir);
    expect(content).toContain('FROM python:3.13-slim');
    expect(content).toContain('pip install --no-cache-dir -r requirements.txt');
    expect(content).toContain('ENV PORT=5000');
    expect(content).toContain('"python app.py"');
  });

  it('auto-detects python from requirements.txt', () => {
    fs.writeFileSync(path.join(dir, 'requirements.txt'), 'flask');
    const content = generateFrameworkDockerfile(frameworkManifest({ framework: 'auto' }), dir);
    expect(content).toContain('FROM python:3.13-slim');
  });

  it('auto-detects node from package.json (wins over python markers)', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'requirements.txt'), 'flask');
    const content = generateFrameworkDockerfile(frameworkManifest({ framework: 'auto' }), dir);
    expect(content).toContain('FROM node:22-alpine');
  });
});

describe('ensureDockerfile', () => {
  it('requires a Dockerfile for container appliances', () => {
    const manifest = applianceInput.parse({ manifest: 'v1', type: 'container', name: 'c', port: 3000 });
    expect(() => ensureDockerfile(dir, manifest)).toThrow(/no Dockerfile/);
  });

  it('passes container appliances through with their port', () => {
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM scratch');
    const manifest = applianceInput.parse({ manifest: 'v1', type: 'container', name: 'c', port: 3000 });
    expect(ensureDockerfile(dir, manifest)).toEqual({ port: 3000, generated: false });
  });

  it('generates a Dockerfile for framework appliances', () => {
    const result = ensureDockerfile(dir, frameworkManifest());
    expect(result.generated).toBe(true);
    expect(result.port).toBe(8080);
    expect(fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf-8')).toContain('FROM node:22-alpine');
  });

  it('leaves an existing Dockerfile alone (user escape hatch)', () => {
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM custom');
    const result = ensureDockerfile(dir, frameworkManifest());
    expect(result.generated).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf-8')).toBe('FROM custom');
  });

  it('rejects appliance types that cannot become images', () => {
    const manifest = applianceInput.parse({ manifest: 'v1', type: 'other', name: 'o' });
    expect(() => ensureDockerfile(dir, manifest)).toThrow(/can't be built into a container image/);
  });
});

describe('buildZipPath', () => {
  it('resolves under the data dir', () => {
    expect(buildZipPath(dir, 'build_abc')).toBe(path.resolve(dir, 'builds', 'build_abc.zip'));
  });

  it('refuses traversal outside the data dir', () => {
    expect(() => buildZipPath(dir, '../../escape')).toThrow(/outside data dir/);
  });
});

describe('writeBuildContent', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it('streams the body to builds/<id>.zip', async () => {
    const bytes = await writeBuildContent(dir, 'build_ok', Readable.from([Buffer.from('zip-bytes')]));
    expect(bytes).toBe(9);
    expect(fs.readFileSync(path.join(dir, 'builds', 'build_ok.zip'), 'utf-8')).toBe('zip-bytes');
  });

  it('rejects oversized uploads and leaves no zip behind', async () => {
    process.env = { ...originalEnv, APPLIANCE_MAX_BUILD_SIZE_MB: '1' };
    expect(maxBuildContentBytes()).toBe(1024 * 1024);
    const big = Buffer.alloc(1024 * 1024 + 1);
    await expect(writeBuildContent(dir, 'build_big', Readable.from([big]))).rejects.toBeInstanceOf(
      BuildContentTooLargeError
    );
    expect(fs.existsSync(path.join(dir, 'builds', 'build_big.zip'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'builds', 'build_big.zip.tmp'))).toBe(false);
  });
});
