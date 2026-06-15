#!/usr/bin/env node
// Re-sign the bundled macOS .app with a STABLE local code-signing
// identity, as the final step of `pnpm --filter @appliance.sh/desktop
// tauri:build`.
//
// Why this exists:
//   The desktop stores each cluster's API key in the macOS Keychain
//   (keyring crate, service `sh.appliance.desktop`). macOS gates
//   Keychain access on the requesting app's *designated requirement*.
//   A plain `tauri build` ad-hoc-signs the app, whose requirement is
//   the raw binary cdhash — which changes on EVERY rebuild. So each new
//   dev build looks like a different app to the Keychain and triggers a
//   fresh "allow access" password prompt (which, at startup, blocks the
//   webview from painting → blank window, and starves the API key →
//   "Load failed" on every screen).
//
//   Signing with a stable certificate instead makes the requirement
//   `identifier "sh.appliance.desktop" and certificate leaf = H"…"`,
//   which is identical across rebuilds. Click "Always Allow" once and
//   the Keychain trusts every future build signed with the same cert.
//
// Safe to commit: this is a no-op unless a matching code-signing cert
// is actually present in the local keychain, so CI and contributors
// without the cert get the normal ad-hoc build untouched.
//
// One-time local setup (per dev machine) is documented in the desktop
// README; the cert defaults to "Appliance Dev" and can be overridden
// with APPLIANCE_MACOS_SIGN_IDENTITY.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, '..');

const IDENTITY = process.env.APPLIANCE_MACOS_SIGN_IDENTITY || 'Appliance Dev';

function log(msg) {
  console.log(`[sign-macos] ${msg}`);
}

// Only relevant on macOS — every other platform skips silently.
if (process.platform !== 'darwin') {
  process.exit(0);
}

// No-op unless the signing cert exists locally. `find-certificate`
// lists certs regardless of trust settings, so this matches our
// self-signed dev cert (which is intentionally not a trusted root).
function identityPresent(name) {
  try {
    execFileSync('security', ['find-certificate', '-c', name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (!identityPresent(IDENTITY)) {
  log(`no "${IDENTITY}" certificate in the keychain — leaving the ad-hoc signature as-is.`);
  process.exit(0);
}

// Resolve the freshly bundled .app. Tauri writes it under the release
// bundle dir; glob for *.app so a productName change doesn't break us.
const macosBundleDir = path.join(desktopRoot, 'src-tauri', 'target', 'release', 'bundle', 'macos');
let appPath;
try {
  const app = fs.readdirSync(macosBundleDir).find((e) => e.endsWith('.app'));
  if (app) appPath = path.join(macosBundleDir, app);
} catch {
  // bundle dir absent — nothing to sign
}

if (!appPath) {
  log(`no .app found in ${macosBundleDir} — nothing to re-sign.`);
  process.exit(0);
}

log(`re-signing ${path.basename(appPath)} with "${IDENTITY}"…`);
try {
  // --deep so the embedded sidecars (appliance, appliance-vm) are
  // sealed under the same identity and the bundle verifies as a whole.
  execFileSync('codesign', ['--force', '--deep', '-s', IDENTITY, appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  log(
    `done — bundle signed with "${IDENTITY}". (The .dmg still wraps the ad-hoc app; run the .app from the bundle dir for local dev.)`
  );
} catch (err) {
  log(`signing failed: ${err.message}`);
  process.exit(1);
}
