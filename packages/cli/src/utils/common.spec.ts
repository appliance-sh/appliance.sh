import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { Command } from 'commander';
import { registerManifestOptions, resolveApplianceDir } from './common.js';

// Builds a Command carrying the standard manifest options, parsed from
// user-style argv (no node/script prefix). exitOverride keeps a parse
// error throwing instead of killing the test process.
function cmdWith(args: string[]): Command {
  const cmd = new Command();
  cmd.exitOverride();
  registerManifestOptions(cmd);
  cmd.parse(args, { from: 'user' });
  return cmd;
}

// resolveApplianceDir decides the docker build context for local
// deploys. Regression guard for the bug where `appliance deploy -d app/`
// read the manifest from app/ but built `.` (cwd) — a missing Dockerfile.
describe('resolveApplianceDir', () => {
  it('defaults to cwd when neither --file nor --directory is given', () => {
    expect(resolveApplianceDir(cmdWith([]))).toBe(process.cwd());
  });

  it('resolves --directory relative to cwd', () => {
    expect(resolveApplianceDir(cmdWith(['--directory', 'app']))).toBe(path.resolve(process.cwd(), 'app'));
  });

  it("ignores the default --file sentinel so it doesn't override --directory", () => {
    // -f defaults to "appliance.json"; that sentinel must not win over -d.
    expect(resolveApplianceDir(cmdWith(['--directory', 'app']))).toBe(path.resolve(process.cwd(), 'app'));
  });

  it("uses an explicit --file's directory", () => {
    expect(resolveApplianceDir(cmdWith(['--file', 'svc/appliance.json']))).toBe(path.resolve(process.cwd(), 'svc'));
  });

  it('lets an explicit --file take precedence over --directory (mirrors manifest resolution)', () => {
    expect(resolveApplianceDir(cmdWith(['--directory', 'app', '--file', 'svc/x.json']))).toBe(
      path.resolve(process.cwd(), 'svc')
    );
  });
});
