import { describe, expect, it } from 'vitest';
import { buildctlProvider, buildctlReleaseUrl } from './buildctl.js';
import { findProvider } from '../registry.js';
import type { Context } from '../types.js';

function ctx(platform: NodeJS.Platform, arch: string): Context {
  return { platform, arch, binDir: '/tmp/bin' } as Context;
}

describe('buildctl provider', () => {
  it('builds the pinned release URL per platform/arch', () => {
    expect(buildctlReleaseUrl(ctx('darwin', 'arm64'))).toMatch(
      /moby\/buildkit\/releases\/download\/v[\d.]+\/buildkit-v[\d.]+\.darwin-arm64\.tar\.gz$/
    );
    expect(buildctlReleaseUrl(ctx('linux', 'x64'))).toContain('.linux-amd64.tar.gz');
    expect(buildctlReleaseUrl(ctx('win32', 'x64'))).toContain('.windows-amd64.tar.gz');
    expect(buildctlReleaseUrl(ctx('win32', 'arm64'))).toContain('.windows-arm64.tar.gz');
  });

  it('is registered, optional, and auto-installable', () => {
    expect(findProvider('buildctl')).toBe(buildctlProvider);
    expect(buildctlProvider.required).toBe(false);
    expect(buildctlProvider.autoInstallable).toBe(true);
  });
});
