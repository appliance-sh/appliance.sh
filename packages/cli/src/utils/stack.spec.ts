import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_STACK_ENVIRONMENT, loadStack, resolveStackApps, STACK_FILENAME } from './stack';

function makeStackDir(stack: unknown, appDirs: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-stack-'));
  fs.writeFileSync(path.join(dir, STACK_FILENAME), JSON.stringify(stack, null, 2));
  for (const app of appDirs) {
    fs.mkdirSync(path.join(dir, app), { recursive: true });
  }
  return dir;
}

const baseStack = {
  manifest: 'v1',
  type: 'stack',
  name: 'demo',
  apps: [{ dir: 'web' }, { dir: 'api', project: 'api-server', environment: 'staging' }],
};

describe('loadStack', () => {
  it('loads and validates a stack file from cwd', () => {
    const dir = makeStackDir(baseStack, ['web', 'api']);
    const loaded = loadStack(undefined, dir);
    expect(loaded.stack.name).toBe('demo');
    expect(loaded.stack.apps).toHaveLength(2);
    expect(loaded.rootDir).toBe(dir);
  });

  it('loads via an explicit --file path', () => {
    const dir = makeStackDir(baseStack, ['web', 'api']);
    const loaded = loadStack(path.join(dir, STACK_FILENAME));
    expect(loaded.rootDir).toBe(dir);
  });

  it('errors with the init hint when no stack file exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-stack-'));
    expect(() => loadStack(undefined, dir)).toThrow(/appliance stack init/);
  });

  it('errors on unparseable JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-stack-'));
    fs.writeFileSync(path.join(dir, STACK_FILENAME), '{ not json');
    expect(() => loadStack(undefined, dir)).toThrow(/Failed to parse/);
  });

  it('errors on schema violations with the offending path', () => {
    const dir = makeStackDir({ manifest: 'v1', type: 'stack', name: 'Bad_Name', apps: [{ dir: 'web' }] });
    expect(() => loadStack(undefined, dir)).toThrow(/Invalid stack file .*name/);
  });

  it('rejects an empty apps array', () => {
    const dir = makeStackDir({ manifest: 'v1', type: 'stack', name: 'demo', apps: [] });
    expect(() => loadStack(undefined, dir)).toThrow(/Invalid stack file/);
  });
});

describe('resolveStackApps', () => {
  it('resolves dirs relative to the stack file and applies the env cascade', () => {
    const dir = makeStackDir({ ...baseStack, environment: 'demo-env' }, ['web', 'api']);
    const apps = resolveStackApps(loadStack(undefined, dir));
    expect(apps[0].dir).toBe(path.join(dir, 'web'));
    // No arg, no per-app pin → stack-level default.
    expect(apps[0].environment).toBe('demo-env');
    // Per-app pin beats the stack default.
    expect(apps[1].environment).toBe('staging');
  });

  it('falls back to the built-in default environment', () => {
    const dir = makeStackDir(baseStack, ['web', 'api']);
    const apps = resolveStackApps(loadStack(undefined, dir));
    expect(apps[0].environment).toBe(DEFAULT_STACK_ENVIRONMENT);
  });

  it('lets an explicit environment argument beat every pin', () => {
    const dir = makeStackDir({ ...baseStack, environment: 'demo-env' }, ['web', 'api']);
    const apps = resolveStackApps(loadStack(undefined, dir), 'demo2');
    expect(apps.map((a) => a.environment)).toEqual(['demo2', 'demo2']);
  });

  it('errors when a member directory is missing', () => {
    const dir = makeStackDir(baseStack, ['web']); // no api/
    expect(() => resolveStackApps(loadStack(undefined, dir))).toThrow(/directory not found: .*api/);
  });

  it('refuses duplicate project/environment targets', () => {
    const stack = {
      manifest: 'v1',
      type: 'stack',
      name: 'demo',
      apps: [
        { dir: 'web', project: 'shared' },
        { dir: 'api', project: 'shared' },
      ],
    };
    const dir = makeStackDir(stack, ['web', 'api']);
    expect(() => resolveStackApps(loadStack(undefined, dir))).toThrow(/same target/);
  });

  it('allows the same project in different environments', () => {
    const stack = {
      manifest: 'v1',
      type: 'stack',
      name: 'demo',
      apps: [
        { dir: 'web', project: 'shared', environment: 'dev' },
        { dir: 'api', project: 'shared', environment: 'staging' },
      ],
    };
    const dir = makeStackDir(stack, ['web', 'api']);
    expect(resolveStackApps(loadStack(undefined, dir))).toHaveLength(2);
  });
});
