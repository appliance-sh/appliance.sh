import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withFileLock } from './profile-lock.js';

describe('withFileLock', () => {
  it('holds the lockfile during fn and releases it after', () => {
    const target = path.join(os.tmpdir(), `appliance-lock-held-${process.pid}.json`);
    const lock = `${target}.lock`;
    fs.rmSync(lock, { force: true });

    let existedDuring = false;
    const result = withFileLock(target, () => {
      existedDuring = fs.existsSync(lock);
      return 42;
    });

    expect(result).toBe(42);
    expect(existedDuring).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('reclaims a stale lock and proceeds', () => {
    const target = path.join(os.tmpdir(), `appliance-lock-stale-${process.pid}.json`);
    const lock = `${target}.lock`;
    fs.writeFileSync(lock, '');
    // Backdate the lockfile well past the 30s stale threshold.
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, old, old);

    let ran = false;
    withFileLock(target, () => {
      ran = true;
    });

    expect(ran).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('releases the lock even when fn throws', () => {
    const target = path.join(os.tmpdir(), `appliance-lock-throw-${process.pid}.json`);
    const lock = `${target}.lock`;
    fs.rmSync(lock, { force: true });

    expect(() =>
      withFileLock(target, () => {
        throw new Error('boom');
      })
    ).toThrow('boom');
    expect(fs.existsSync(lock)).toBe(false);
  });
});
