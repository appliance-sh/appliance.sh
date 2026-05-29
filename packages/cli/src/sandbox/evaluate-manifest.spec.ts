import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ManifestContext } from '@appliance.sh/sdk';
import { evaluateManifest, evaluateManifestSource } from './evaluate-manifest.js';

function ctx(overrides: Partial<ManifestContext> = {}): ManifestContext {
  return {
    cwd: '/sandbox/cwd',
    env: { FOO: 'bar' },
    ...overrides,
  };
}

function withTempFile<T>(filename: string, source: string, fn: (filePath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), 'appliance-sandbox-'));
  const filePath = path.join(dir, filename);
  writeFileSync(filePath, source, 'utf-8');
  return fn(filePath).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

describe('evaluateManifestSource', () => {
  describe('return shapes', () => {
    it('returns an object-form manifest verbatim', async () => {
      const source = `
        export default {
          manifest: 'v1',
          type: 'container',
          name: 'demo',
          port: 3000,
        };
      `;
      const result = await evaluateManifestSource(source, '.js', ctx());
      expect(result).toEqual({
        manifest: 'v1',
        type: 'container',
        name: 'demo',
        port: 3000,
      });
    });

    it('invokes a sync function-form manifest with the supplied context', async () => {
      const source = `
        export default (ctx) => ({
          manifest: 'v1',
          type: 'container',
          name: 'demo',
          port: 3000,
          env: { CWD: ctx.cwd, FOO: ctx.env.FOO },
        });
      `;
      const result = await evaluateManifestSource(source, '.js', ctx());
      expect(result).toMatchObject({
        env: { CWD: '/sandbox/cwd', FOO: 'bar' },
      });
    });

    it('awaits an async function-form manifest', async () => {
      const source = `
        export default async (ctx) => {
          await Promise.resolve();
          return {
            manifest: 'v1',
            type: 'framework',
            name: 'async-app',
            framework: 'node',
            env: { PROJECT: ctx.project ?? 'unset' },
          };
        };
      `;
      const result = await evaluateManifestSource(source, '.js', ctx({ project: 'my-proj' }));
      expect(result).toMatchObject({
        manifest: 'v1',
        type: 'framework',
        env: { PROJECT: 'my-proj' },
      });
    });
  });

  describe('typescript support', () => {
    it('strips type annotations from .ts manifests', async () => {
      const source = `
        type Mode = 'container' | 'framework';
        interface Config { name: string; port: number; }
        const cfg: Config = { name: 'ts-app', port: 4000 };
        const mode: Mode = 'container';
        export default (ctx: { project?: string }) => ({
          manifest: 'v1' as const,
          type: mode,
          name: cfg.name,
          port: cfg.port,
        });
      `;
      const result = await evaluateManifestSource(source, '.ts', ctx());
      expect(result).toMatchObject({
        manifest: 'v1',
        type: 'container',
        name: 'ts-app',
        port: 4000,
      });
    });

    it('drops type-only imports from @appliance.sh/sdk', async () => {
      const source = `
        import type { ApplianceFullInput, ManifestContext } from '@appliance.sh/sdk';
        const m: ApplianceFullInput = {
          manifest: 'v1',
          type: 'container',
          name: 'typed',
          port: 8080,
        };
        export default (_ctx: ManifestContext) => m;
      `;
      const result = await evaluateManifestSource(source, '.ts', ctx());
      expect(result).toMatchObject({ name: 'typed', port: 8080 });
    });

    it('allows value imports from @appliance.sh/sdk via the SDK stub', async () => {
      const source = `
        import { ApplianceType, AppliancePlatform } from '@appliance.sh/sdk';
        export default {
          manifest: 'v1',
          type: ApplianceType.container,
          name: 'enum-app',
          port: 3000,
          platform: AppliancePlatform.LinuxArm64,
        };
      `;
      const result = await evaluateManifestSource(source, '.ts', ctx());
      expect(result).toMatchObject({
        type: 'container',
        platform: 'linux/arm64',
      });
    });
  });

  describe('sandbox isolation', () => {
    it('blocks `fs` and similar Node built-ins via the import gate', async () => {
      const source = `
        import * as fs from 'node:fs';
        export default { name: 'leak', port: 1, manifest: 'v1', type: 'other' };
      `;
      await expect(evaluateManifestSource(source, '.js', ctx())).rejects.toThrow(/not allowed/);
    });

    it('blocks arbitrary npm imports', async () => {
      const source = `
        import lodash from 'lodash';
        export default { name: 'leak', manifest: 'v1', type: 'other' };
      `;
      await expect(evaluateManifestSource(source, '.js', ctx())).rejects.toThrow(/not allowed/);
    });

    it('does not expose process, fetch, require, Bun, or __dirname', async () => {
      const source = `
        export default () => ({
          manifest: 'v1', type: 'other', name: 'introspect',
          env: {
            process: typeof process,
            fetch: typeof fetch,
            require: typeof require,
            bun: typeof Bun,
            dirname: typeof __dirname,
          },
        });
      `;
      const result = await evaluateManifestSource(source, '.js', ctx());
      expect(result).toMatchObject({
        env: {
          process: 'undefined',
          fetch: 'undefined',
          require: 'undefined',
          bun: 'undefined',
          dirname: 'undefined',
        },
      });
    });

    it('does not leak host env vars beyond what ctx.env contains', async () => {
      const source = `
        export default (ctx) => ({
          manifest: 'v1', type: 'other', name: 'env-test',
          env: { keys: Object.keys(ctx.env).sort().join(',') },
        });
      `;
      const result = (await evaluateManifestSource(
        source,
        '.js',
        ctx({
          env: { A: '1', B: '2' },
        })
      )) as { env: { keys: string } };
      expect(result.env.keys).toBe('A,B');
    });

    it('enforces the wall-clock timeout on a hot loop', async () => {
      const source = `
        export default () => {
          // Busy loop; no microtasks, just synchronous CPU.
          while (true) {}
        };
      `;
      await expect(evaluateManifestSource(source, '.js', ctx(), { timeoutMs: 200 })).rejects.toThrow();
    });

    it('propagates manifest-thrown errors with the original message', async () => {
      const source = `
        export default () => { throw new Error('boom from inside'); };
      `;
      await expect(evaluateManifestSource(source, '.js', ctx())).rejects.toThrow(/boom from inside/);
    });

    it('reports a clear error when the manifest TypeScript is malformed', async () => {
      const source = `export default = 5;`;
      await expect(evaluateManifestSource(source, '.ts', ctx())).rejects.toThrow(/transpile/i);
    });
  });

  describe('runtime config passthrough', () => {
    it('returns memory/timeout/storage from a programmatic manifest', async () => {
      const source = `
        export default (ctx) => ({
          manifest: 'v1', type: 'container', name: 'rt', port: 3000,
          memory: 512, timeout: 30, storage: 1024,
          env: { ENV_NAME: ctx.environment ?? 'unset' },
        });
      `;
      const result = await evaluateManifestSource(source, '.ts', ctx({ environment: 'prod' }));
      expect(result).toMatchObject({
        memory: 512,
        timeout: 30,
        storage: 1024,
        env: { ENV_NAME: 'prod' },
      });
    });
  });
});

describe('evaluateManifest (file-based)', () => {
  it('reads and evaluates an on-disk .ts manifest', async () => {
    const source = `
      export default (ctx: { project?: string }) => ({
        manifest: 'v1' as const,
        type: 'container' as const,
        name: 'on-disk',
        port: 8000,
        env: { PROJECT: ctx.project ?? 'none' },
      });
    `;
    const result = await withTempFile('appliance.ts', source, (filePath) =>
      evaluateManifest(filePath, ctx({ project: 'demo' }))
    );
    expect(result).toMatchObject({
      name: 'on-disk',
      env: { PROJECT: 'demo' },
    });
  });

  it('rejects unsupported extensions', async () => {
    await expect(withTempFile('appliance.json', '{}', (filePath) => evaluateManifest(filePath, ctx()))).rejects.toThrow(
      /Unsupported manifest extension/
    );
  });
});
