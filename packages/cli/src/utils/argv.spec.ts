import { describe, it, expect } from 'vitest';
import { userArgs } from './argv.js';

// `resolve` stub: pretend the install symlink points at dist/appliance.js,
// and that any other path resolves to itself. Mirrors fs.realpathSync
// without touching the filesystem.
const SYMLINK = '/opt/homebrew/bin/appliance';
const TARGET = '/opt/homebrew/lib/node_modules/@appliance.sh/cli/dist/appliance.js';
const resolve = (p: string) => (p === SYMLINK ? TARGET : p);

describe('userArgs', () => {
  it('drops the script slot for a plain `node dist/appliance.js` invocation', () => {
    expect(userArgs(['/usr/bin/node', '/repo/dist/appliance.js', 'status'], resolve)).toEqual(['status']);
  });

  // Regression: npm/Homebrew install `appliance` as an extensionless
  // symlink. Node reports the *symlink* path in argv[1], so the old
  // extension-only heuristic kept it as the first user arg, producing
  // "Unknown command: /opt/homebrew/bin/appliance".
  it('resolves an extensionless install symlink before the extension test', () => {
    expect(userArgs(['/usr/bin/node', SYMLINK, 'status'], resolve)).toEqual(['status']);
    expect(userArgs(['/usr/bin/node', SYMLINK, 'deploy', '--json'], resolve)).toEqual(['deploy', '--json']);
  });

  it('handles an older Bun-compiled binary (/$bunfs/ entry)', () => {
    expect(userArgs(['/bin/appliance', '/$bunfs/root/appliance', 'status'], resolve)).toEqual(['status']);
  });

  // Regression: on Windows, Bun reports the embedded entry with forward
  // slashes ("B:/~BUN/root/appliance"), so a backslash-only test missed it
  // and every command failed with "Unknown command: B:/~BUN/root/appliance".
  it('handles the Windows Bun virtual-filesystem entry in either slash direction', () => {
    expect(userArgs(['C:\\bin\\appliance.exe', 'B:/~BUN/root/appliance', 'vm', 'list'], resolve)).toEqual([
      'vm',
      'list',
    ]);
    expect(userArgs(['C:\\bin\\appliance.exe', 'B:\\~BUN\\root\\appliance', 'status'], resolve)).toEqual(['status']);
  });

  it('handles a newer Bun-compiled binary that repeats the binary path', () => {
    expect(userArgs(['/bin/appliance', '/bin/appliance', 'status'], resolve)).toEqual(['status']);
  });

  it('still slices a normal `.ts` dev entry (bun src/appliance.ts)', () => {
    expect(userArgs(['/bin/bun', '/repo/src/appliance.ts', 'whoami'], resolve)).toEqual(['whoami']);
  });

  it('falls back to argv[1..] when argv[1] is not a resolvable script slot', () => {
    // A harness that strips the script slot entirely: argv[1] is a real
    // user arg, and resolve() throws (not a path).
    const throwing = (p: string): string => {
      throw new Error(`no such path: ${p}`);
    };
    expect(userArgs(['/bin/appliance', 'status'], throwing)).toEqual(['status']);
  });

  it('returns no args when only the interpreter/binary is present', () => {
    expect(userArgs(['/usr/bin/node'], resolve)).toEqual([]);
  });
});
