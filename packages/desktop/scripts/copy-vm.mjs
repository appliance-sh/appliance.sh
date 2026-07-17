#!/usr/bin/env node
// Stage the appliance-vm microVM engine binary (built by the
// preceding `vm:build` script — build-vm.mjs) as a Tauri bundle
// resource:
//   packages/desktop/src-tauri/vm-bin/appliance-vm      (macOS)
//   packages/desktop/src-tauri/vm-bin/appliance-vm.exe  (Windows)
//
// tauri.conf.json lists `vm-bin/*` under bundle.resources, so a
// packaged app carries the engine inside its resources and the
// desktop's `microvm_install` command can place it in ~/.appliance/bin
// (re-signing it with the virtualization entitlement on macOS) on
// demand — the user never builds or fetches the engine by hand.
//
// The engine is platform-gated (Virtualization.framework on macOS,
// WSL2 on Windows): on platforms without a backend the staging dir
// stays empty, the resource glob matches nothing, and the desktop
// reports the engine as not installable. Dev (tauri dev) doesn't
// strictly need this staging — the Rust side falls back to
// packages/vm/target/{release,debug} directly.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const stagingDir = path.join(desktopRoot, 'src-tauri', 'vm-bin');

// Cargo's output name per platform — must match VM_BIN_NAME in the
// desktop's lib.rs, which resolves the same file out of the bundle.
const binName = process.platform === 'win32' ? 'appliance-vm.exe' : 'appliance-vm';
const supported = process.platform === 'darwin' || process.platform === 'win32';

function main() {
  // Always create the staging dir so the bundle.resources glob has a
  // directory to scan even when no engine binary is available.
  fs.mkdirSync(stagingDir, { recursive: true });

  const release = path.join(repoRoot, 'packages', 'vm', 'target', 'release', binName);
  if (!fs.existsSync(release)) {
    if (supported) {
      throw new Error(`copy-vm: ${release} not found — did the vm:build step run?`);
    }
    console.log(`copy-vm: no microVM engine for ${process.platform} yet — packaging without it.`);
    return;
  }
  const dest = path.join(stagingDir, binName);
  fs.copyFileSync(release, dest);
  fs.chmodSync(dest, 0o755);
  console.log(`copy-vm: ${path.relative(repoRoot, release)} → ${path.relative(repoRoot, dest)}`);
}

main();
