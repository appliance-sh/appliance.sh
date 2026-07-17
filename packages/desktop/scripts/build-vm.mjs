#!/usr/bin/env node
// Build (and, on macOS, ad-hoc sign) the appliance-vm microVM engine as
// part of the desktop build, so copy-vm.mjs has a binary to stage as a
// bundle resource. Every desktop build has a Rust toolchain anyway —
// tauri compiles the shell right after — and cargo makes re-runs free.
//
// Platform backends:
//   - macOS: Virtualization.framework. The ad-hoc signature
//     (virtualization entitlement) makes the repo build directly
//     runnable; the bundled copy is re-signed anyway by the desktop's
//     microvm_install after it leaves the app bundle.
//   - Windows: WSL2 (packages/vm/src/backend/wsl.rs). No signing step.
//   - Linux: no backend yet — a no-op, and the desktop packages
//     without the engine.
// A build failure on a supported platform is fatal, matching
// copy-cli.mjs: better to fail the build than to silently ship an app
// whose microVM engine can't be installed.

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vmRoot = path.resolve(__dirname, '..', '..', 'vm');

function main() {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    console.log(`build-vm: no microVM backend for ${process.platform} yet — skipping the engine build.`);
    return;
  }
  execFileSync('cargo', ['build', '--release'], { cwd: vmRoot, stdio: 'inherit' });
  if (process.platform === 'darwin') {
    execFileSync(path.join(vmRoot, 'scripts', 'sign-dev.sh'), ['--release'], { stdio: 'inherit' });
  }
}

main();
