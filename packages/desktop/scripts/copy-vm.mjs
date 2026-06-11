#!/usr/bin/env node
// Stage the appliance-vm microVM engine binary as a Tauri bundle
// resource:
//   packages/desktop/src-tauri/vm-bin/appliance-vm
//
// tauri.conf.json lists `vm-bin/*` under bundle.resources, so a
// packaged app carries the engine inside Resources/ and the desktop's
// `microvm_install` command can place it in ~/.appliance/bin (and
// re-sign it with the virtualization entitlement) on demand — the
// user never builds or fetches the engine by hand.
//
// Unlike the CLI sidecar (copy-cli.mjs), a missing source binary is
// not fatal: the engine is platform-gated (Virtualization.framework
// on macOS today) and absent from Linux/Windows CI builds. When it's
// missing the resource glob simply matches nothing and the desktop
// reports the engine as not installable. Dev builds don't need this
// staging at all — the Rust side falls back to
// packages/vm/target/{release,debug} directly.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const vmTarget = path.join(repoRoot, 'packages', 'vm', 'target');
const stagingDir = path.join(desktopRoot, 'src-tauri', 'vm-bin');

function main() {
  // Always create the staging dir so the bundle.resources glob has a
  // directory to scan even when no engine binary is available.
  fs.mkdirSync(stagingDir, { recursive: true });

  const release = path.join(vmTarget, 'release', 'appliance-vm');
  if (!fs.existsSync(release)) {
    console.log(
      'copy-vm: no packages/vm release build — packaging without the microVM engine. ' +
        'Build it with `cargo build --release && ./scripts/sign-dev.sh --release` in packages/vm.'
    );
    return;
  }
  const dest = path.join(stagingDir, 'appliance-vm');
  fs.copyFileSync(release, dest);
  fs.chmodSync(dest, 0o755);
  console.log(`copy-vm: ${path.relative(repoRoot, release)} → ${path.relative(repoRoot, dest)}`);
}

main();
