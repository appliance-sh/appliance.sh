#!/usr/bin/env node
// Stage a repo-built api-server GUEST binary (the linux control plane
// the microVM boots) as a Tauri bundle resource:
//   packages/desktop/src-tauri/apiserver-bin/appliance-api-server-linux-<arch>
//   packages/desktop/src-tauri/apiserver-bin/appliance-console.tar.gz
//
// Why: at bring-up the bundled CLI stages the guest binary for the VM
// engine (packages/cli/src/utils/api-server-artifact.ts). Its repo
// probe can't fire under the bundled runtime, so a desktop built from
// unreleased main falls back to the release download pinned to the SDK
// VERSION — a schema-skewed guest. Dev pipelines (tauri:dev /
// tauri:build) run this script so the app carries the in-repo build
// and the Rust side can point APPLIANCE_API_SERVER_BINARY at it; the
// release pipeline runs `--clear` instead, which scrubs any staging
// left by a prior dev build so the version-pinned download stays
// authoritative.
//
// Best-effort by design: compiling the guest binary needs bun. Without
// bun (or on a compile failure) we warn and stage nothing — the
// runtime keeps today's release-download behavior.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const stagingDir = path.join(desktopRoot, 'src-tauri', 'apiserver-bin');

// The microVM's guest arch follows the host arch — mirrors GUEST_ARCH
// in api-server-artifact.ts (arm64 on Apple Silicon).
const guestArch = process.arch === 'arm64' ? 'arm64' : 'x64';
const binName = `appliance-api-server-linux-${guestArch}`;

function newestMtimeMs(dir) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtimeMs(p) : fs.statSync(p).mtimeMs);
  }
  return newest;
}

/**
 * A prebuilt guest binary is fresh when it postdates the api-server and
 * sdk sources — the two packages whose schema skew motivates staging.
 * Other workspace deps aren't tracked; this is a dev convenience build.
 */
function guestBinaryIsFresh(prebuilt) {
  if (!fs.existsSync(prebuilt)) return false;
  const built = fs.statSync(prebuilt).mtimeMs;
  return [path.join(repoRoot, 'packages', 'api-server', 'src'), path.join(repoRoot, 'packages', 'sdk', 'src')].every(
    (d) => !fs.existsSync(d) || newestMtimeMs(d) <= built
  );
}

function bunAvailable() {
  const r = spawnSync('bun', ['--version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

function main() {
  // Reset so a previous staging (other arch, older build) can't
  // linger. The dir itself must exist in both modes: tauri-build fails
  // on a missing resource path (an empty dir is fine).
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  if (process.argv.includes('--clear')) {
    console.log('stage-apiserver: cleared staging (release build keeps the version-pinned download)');
    return;
  }

  const apiServerDir = path.join(repoRoot, 'packages', 'api-server');
  const prebuilt = path.join(apiServerDir, 'dist', 'guest', binName);

  if (!guestBinaryIsFresh(prebuilt)) {
    if (!bunAvailable()) {
      if (!fs.existsSync(prebuilt)) {
        console.warn(
          'stage-apiserver: bun is not on PATH — cannot compile the api-server guest binary. ' +
            'The app will fall back to the release download pinned to the SDK version ' +
            '(schema skew possible on unreleased main). Install bun (https://bun.sh) to fix.'
        );
        return;
      }
      // A stale repo build still beats the release download for skew.
      console.warn('stage-apiserver: bun is not on PATH — staging the existing (possibly stale) dist/guest binary.');
    } else {
      console.log(`stage-apiserver: compiling api-server guest binary (linux-${guestArch}, bun)`);
      const r = spawnSync('pnpm', ['run', `compile:guest-${guestArch}`], { cwd: apiServerDir, stdio: 'inherit' });
      if (r.status !== 0) {
        console.warn(
          'stage-apiserver: guest compile failed — packaging without a staged binary (release-download fallback).'
        );
        return;
      }
    }
  }

  const dest = path.join(stagingDir, binName);
  fs.copyFileSync(prebuilt, dest);
  fs.chmodSync(dest, 0o755);
  console.log(`stage-apiserver: ${path.relative(repoRoot, prebuilt)} → ${path.relative(repoRoot, dest)}`);

  // Console bundle: best-effort — the API serves headless without it.
  // Tar contents at the archive root, matching tarGzDirectory in
  // api-server-artifact.ts (the guest extracts with -C).
  const consoleDist = path.join(repoRoot, 'packages', 'console', 'dist');
  if (fs.existsSync(path.join(consoleDist, 'index.html'))) {
    const tarDest = path.join(stagingDir, 'appliance-console.tar.gz');
    const tar = spawnSync('tar', ['-czf', tarDest, '-C', consoleDist, '.'], { stdio: 'inherit' });
    if (tar.status === 0) {
      console.log('stage-apiserver: staged web console bundle');
    } else {
      fs.rmSync(tarDest, { force: true });
      console.warn('stage-apiserver: could not tar the console bundle — the VM serves API only.');
    }
  } else {
    console.log('stage-apiserver: console bundle not built (pnpm --filter @appliance.sh/console build) — API only');
  }
}

main();
