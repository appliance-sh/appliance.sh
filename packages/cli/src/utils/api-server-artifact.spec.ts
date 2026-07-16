import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VERSION } from '@appliance.sh/sdk';

import { ensureApiServerArtifacts, guestAssetsDir } from './api-server-artifact.js';

// Redirect the guest-assets dir (~/.appliance/vm/images/guest-assets)
// into a per-test temp home.
const state = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => state.home };
});

const GUEST_ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';

describe('ensureApiServerArtifacts with APPLIANCE_API_SERVER_BINARY', () => {
  let home: string;
  let work: string;

  const staged = () => path.join(guestAssetsDir(), 'appliance-api-server');
  const stagedConsole = () => path.join(guestAssetsDir(), 'appliance-console.tar.gz');
  const stampFile = () => path.join(guestAssetsDir(), 'appliance-api-server.version');

  function overrideBinary(content: string): string {
    const p = path.join(work, `appliance-api-server-linux-${GUEST_ARCH}`);
    fs.writeFileSync(p, content);
    return p;
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'api-server-artifact-home-'));
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'api-server-artifact-work-'));
    state.home = home;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.APPLIANCE_API_SERVER_BINARY;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('warns and falls back when the override points at a missing file', async () => {
    // A stale export in a shell profile must not brick bring-up when
    // valid staged artifacts exist — the override is ignored and the
    // matching VERSION stamp short-circuits.
    fs.mkdirSync(guestAssetsDir(), { recursive: true });
    fs.writeFileSync(staged(), 'previously-staged');
    fs.writeFileSync(stampFile(), `${VERSION}:${GUEST_ARCH}`);
    process.env.APPLIANCE_API_SERVER_BINARY = path.join(work, 'nope');

    await expect(ensureApiServerArtifacts()).resolves.toBeUndefined();

    expect(fs.readFileSync(staged(), 'utf8')).toBe('previously-staged');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(path.join(work, 'nope')));
  });

  it('restages over a VERSION-stamped staged binary (stamp bypass)', async () => {
    // A previous release/repo staging left a matching VERSION stamp —
    // without the override-aware stamp this would short-circuit and
    // keep the stale binary.
    fs.mkdirSync(guestAssetsDir(), { recursive: true });
    fs.writeFileSync(staged(), 'stale-release-build');
    fs.writeFileSync(stampFile(), `${VERSION}:${GUEST_ARCH}`);
    process.env.APPLIANCE_API_SERVER_BINARY = overrideBinary('fresh-dev-build');

    await ensureApiServerArtifacts();

    expect(fs.readFileSync(staged(), 'utf8')).toBe('fresh-dev-build');
    expect(fs.readFileSync(stampFile(), 'utf8')).toMatch(/^override:/);
  });

  it('short-circuits on an unchanged override, restages on a changed one', async () => {
    const bin = overrideBinary('build-one');
    process.env.APPLIANCE_API_SERVER_BINARY = bin;
    await ensureApiServerArtifacts();

    // Drift the staged copy: an unchanged override must not rewrite it.
    fs.writeFileSync(staged(), 'tampered');
    await ensureApiServerArtifacts();
    expect(fs.readFileSync(staged(), 'utf8')).toBe('tampered');

    // A rebuilt override (new size + mtime) restages.
    fs.writeFileSync(bin, 'build-two!');
    fs.utimesSync(bin, new Date(), new Date(Date.now() + 5000));
    await ensureApiServerArtifacts();
    expect(fs.readFileSync(staged(), 'utf8')).toBe('build-two!');
  });

  it('stages a console tarball shipped next to the override binary', async () => {
    fs.writeFileSync(path.join(work, 'appliance-console.tar.gz'), 'tar-bytes');
    process.env.APPLIANCE_API_SERVER_BINARY = overrideBinary('bin');

    await ensureApiServerArtifacts();

    expect(fs.readFileSync(stagedConsole(), 'utf8')).toBe('tar-bytes');
  });

  it('drops a previously staged console tarball when the override has no sibling', async () => {
    // A release download left a console tar behind — keeping it would
    // pair an old web console with the new override server.
    fs.mkdirSync(guestAssetsDir(), { recursive: true });
    fs.writeFileSync(stagedConsole(), 'old-release-console');
    process.env.APPLIANCE_API_SERVER_BINARY = overrideBinary('bin');

    await ensureApiServerArtifacts();

    expect(fs.existsSync(stagedConsole())).toBe(false);
  });

  it('restages on a console-only rebuild (unchanged override binary)', async () => {
    const tar = path.join(work, 'appliance-console.tar.gz');
    fs.writeFileSync(tar, 'console-one');
    process.env.APPLIANCE_API_SERVER_BINARY = overrideBinary('bin');
    await ensureApiServerArtifacts();

    // Only the tarball changes (new size + mtime) — the binary stamp
    // alone would short-circuit and keep the stale console.
    fs.writeFileSync(tar, 'console-two!');
    fs.utimesSync(tar, new Date(), new Date(Date.now() + 5000));
    await ensureApiServerArtifacts();

    expect(fs.readFileSync(stagedConsole(), 'utf8')).toBe('console-two!');
  });
});
