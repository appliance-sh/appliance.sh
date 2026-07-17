import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_STACK_ENVIRONMENT,
  loadStack,
  resolveStackApps,
  resolveStackAppEnv,
  STACK_FILENAME,
  type ResolvedStackApp,
  type StackMemberInfo,
} from './stack';

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

  it('carries per-app env through resolution', () => {
    const stack = {
      ...baseStack,
      apps: [{ dir: 'web', env: { API_URL: '{{service:api}}' } }, { dir: 'api' }],
    };
    const dir = makeStackDir(stack, ['web', 'api']);
    const apps = resolveStackApps(loadStack(undefined, dir));
    expect(apps[0].env).toEqual({ API_URL: '{{service:api}}' });
    expect(apps[1].env).toBeUndefined();
  });

  it('rejects env keys a shell could not export', () => {
    const stack = { ...baseStack, apps: [{ dir: 'web', env: { 'BAD-KEY': 'x' } }] };
    const dir = makeStackDir(stack, ['web']);
    expect(() => loadStack(undefined, dir)).toThrow(/Invalid stack file/);
  });
});

describe('resolveStackAppEnv', () => {
  const app = (env?: Record<string, string>): ResolvedStackApp => ({
    dir: '/abs/web',
    relDir: 'web',
    environment: 'dev',
    env,
  });
  const members = new Map<string, StackMemberInfo>([
    ['web', { projectName: 'demo-frontend', environment: 'dev', port: 3000 }],
    ['api', { projectName: 'demo-backend', environment: 'dev', port: 4000 }],
  ]);

  it('returns undefined when the entry declares no env', () => {
    expect(resolveStackAppEnv(app(), members, new Map())).toBeUndefined();
    expect(resolveStackAppEnv(app({}), members, new Map())).toBeUndefined();
  });

  it('resolves {{service:dir}} to the deterministic in-network address', () => {
    const resolved = resolveStackAppEnv(app({ API_URL: '{{service:api}}' }), members, new Map());
    expect(resolved).toEqual({ API_URL: 'http://demo-backend-dev:4000' });
  });

  it('resolves {{url:dir}} from the deployed URLs of earlier members', () => {
    const urls = new Map([['api', 'http://localhost:8366']]);
    const resolved = resolveStackAppEnv(app({ PUBLIC_API: '{{url:api}}' }), members, urls);
    expect(resolved).toEqual({ PUBLIC_API: 'http://localhost:8366' });
  });

  it('interpolates placeholders embedded in larger values, tolerating spaces', () => {
    const resolved = resolveStackAppEnv(app({ ENDPOINT: '{{ service:api }}/api/v2' }), members, new Map());
    expect(resolved).toEqual({ ENDPOINT: 'http://demo-backend-dev:4000/api/v2' });
  });

  it('passes through values without placeholders untouched', () => {
    const resolved = resolveStackAppEnv(app({ LOG_LEVEL: 'debug' }), members, new Map());
    expect(resolved).toEqual({ LOG_LEVEL: 'debug' });
  });

  it('errors on an unknown member with the known dirs listed', () => {
    expect(() => resolveStackAppEnv(app({ X: '{{service:nope}}' }), members, new Map())).toThrow(
      /unknown stack member "nope".*web, api/
    );
  });

  it('errors on {{url:...}} of a member not yet deployed, suggesting alternatives', () => {
    expect(() => resolveStackAppEnv(app({ X: '{{url:api}}' }), members, new Map())).toThrow(
      /needs "api" deployed first.*\{\{service:api\}\}/
    );
  });

  it('errors on {{service:...}} when the member has no resolvable project name', () => {
    const anonymous = new Map<string, StackMemberInfo>([['api', { environment: 'dev', port: 4000 }]]);
    expect(() => resolveStackAppEnv(app({ X: '{{service:api}}' }), anonymous, new Map())).toThrow(/no manifest `name`/);
  });
});
