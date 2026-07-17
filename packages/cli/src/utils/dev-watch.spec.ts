import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRebuildQueue, shouldIgnorePath } from './dev-watch.js';

describe('shouldIgnorePath', () => {
  it('ignores dependency/VCS/build-output trees anywhere in the path', () => {
    expect(shouldIgnorePath('node_modules/express/index.js')).toBe(true);
    expect(shouldIgnorePath('src\\node_modules\\x.js')).toBe(true);
    expect(shouldIgnorePath('.git/HEAD')).toBe(true);
    expect(shouldIgnorePath('dist/main.js')).toBe(true);
    expect(shouldIgnorePath('target/debug/app')).toBe(true);
    expect(shouldIgnorePath('__pycache__/app.cpython-312.pyc')).toBe(true);
  });

  it('ignores editor/OS noise and the build artifact', () => {
    expect(shouldIgnorePath('server.js~')).toBe(true);
    expect(shouldIgnorePath('.server.js.swp')).toBe(true);
    expect(shouldIgnorePath('.DS_Store')).toBe(true);
    expect(shouldIgnorePath('appliance.zip')).toBe(true);
  });

  it('keeps real source, including dotfiles like .env.dev', () => {
    expect(shouldIgnorePath('server.js')).toBe(false);
    expect(shouldIgnorePath('src/routes/index.ts')).toBe(false);
    expect(shouldIgnorePath('Dockerfile')).toBe(false);
    // Env files feed the deploy — a change should redeploy.
    expect(shouldIgnorePath('.env.dev')).toBe(false);
  });
});

describe('createRebuildQueue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces a burst of notifies into one run', async () => {
    const runs: string[] = [];
    const q = createRebuildQueue(async (m) => {
      runs.push(m);
    }, 300);
    q.notify('web');
    q.notify('web');
    await vi.advanceTimersByTimeAsync(200);
    q.notify('web'); // resets the debounce
    await vi.advanceTimersByTimeAsync(299);
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();
    expect(runs).toEqual(['web']);
    q.close();
  });

  it('serializes builds across members', async () => {
    const order: string[] = [];
    let release: (() => void) | null = null;
    const q = createRebuildQueue(async (m) => {
      order.push(`start:${m}`);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push(`end:${m}`);
    }, 10);
    q.notify('a');
    q.notify('b');
    await vi.advanceTimersByTimeAsync(10);
    expect(order).toEqual(['start:a']); // b waits for a
    release!();
    await vi.runAllTimersAsync();
    expect(order[1]).toBe('end:a');
    expect(order[2]).toBe('start:b');
    release!();
    await vi.runAllTimersAsync();
    expect(order[3]).toBe('end:b');
    q.close();
  });

  it('queues exactly one follow-up for a member dirtied mid-build', async () => {
    const runs: string[] = [];
    let release: (() => void) | null = null;
    const q = createRebuildQueue(async (m) => {
      runs.push(m);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }, 10);
    q.notify('web');
    await vi.advanceTimersByTimeAsync(10);
    expect(runs).toEqual(['web']); // building
    // Three saves during the build coalesce into ONE follow-up.
    q.notify('web');
    await vi.advanceTimersByTimeAsync(10);
    q.notify('web');
    await vi.advanceTimersByTimeAsync(10);
    release!();
    await vi.runAllTimersAsync();
    expect(runs).toEqual(['web', 'web']);
    release!();
    await vi.runAllTimersAsync();
    expect(runs).toEqual(['web', 'web']); // no third build
    q.close();
  });

  it('keeps pumping after a failed build', async () => {
    const runs: string[] = [];
    const q = createRebuildQueue(async (m) => {
      runs.push(m);
      if (m === 'bad') throw new Error('boom');
    }, 10);
    q.notify('bad');
    await vi.advanceTimersByTimeAsync(10);
    await vi.runAllTimersAsync();
    q.notify('good');
    await vi.advanceTimersByTimeAsync(10);
    await vi.runAllTimersAsync();
    expect(runs).toEqual(['bad', 'good']);
    q.close();
  });

  it('drops everything after close', async () => {
    const runs: string[] = [];
    const q = createRebuildQueue(async (m) => {
      runs.push(m);
    }, 10);
    q.notify('web');
    q.close();
    await vi.advanceTimersByTimeAsync(50);
    await vi.runAllTimersAsync();
    expect(runs).toEqual([]);
  });
});
