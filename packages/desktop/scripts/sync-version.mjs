#!/usr/bin/env node
// Sync the Rust-side bundle version from package.json.
//
// nx-release (see nx.json `release`) bumps every @appliance.sh/*
// package.json in lockstep, but it does NOT touch the Tauri shell's
// version sources — src-tauri/tauri.conf.json and src-tauri/Cargo.toml.
// Those drift behind (the repo shipped 1.48.0 while tauri.conf.json
// still read 1.27.3).
//
// That drift breaks auto-update: the updater compares the RUNNING app's
// version (baked in from tauri.conf.json at build time) against the
// feed's `latest.json`. If the bundle reports 1.27.3 but the feed
// advertises 1.48.0, every install thinks it's 21 minors behind and the
// "you're up to date" state is unreachable.
//
// The release workflow runs this right before `tauri build` so the
// produced bundle reports the same version the GitHub Release is tagged
// with. Idempotent — running it when already in sync rewrites nothing.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, '..');

function log(msg) {
  console.log(`[sync-version] ${msg}`);
}

const pkg = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'));
const version = pkg.version;
if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`[sync-version] package.json version "${version}" is not a semver — refusing to sync.`);
  process.exit(1);
}

let changed = 0;

// --- tauri.conf.json ----------------------------------------------------
const confPath = path.join(desktopRoot, 'src-tauri', 'tauri.conf.json');
const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
if (conf.version !== version) {
  log(`tauri.conf.json: ${conf.version} -> ${version}`);
  conf.version = version;
  // Preserve 2-space formatting + trailing newline to match the repo.
  fs.writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');
  changed++;
}

// --- Cargo.toml ---------------------------------------------------------
// Surgical line edit (don't pull in a TOML parser): replace only the
// FIRST `version = "..."` under [package]. The build-deps versions
// (tauri = "2", etc.) live under other tables and use bare majors, so a
// first-match-after-[package] replace is safe.
const cargoPath = path.join(desktopRoot, 'src-tauri', 'Cargo.toml');
const cargoSrc = fs.readFileSync(cargoPath, 'utf8');
const lines = cargoSrc.split('\n');
let inPackage = false;
let cargoChanged = false;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (/^\[package\]\s*$/.test(line)) {
    inPackage = true;
    continue;
  }
  // Leaving the [package] table.
  if (inPackage && /^\[/.test(line)) break;
  if (inPackage) {
    const m = line.match(/^version\s*=\s*"([^"]*)"/);
    if (m) {
      if (m[1] !== version) {
        log(`Cargo.toml: ${m[1]} -> ${version}`);
        lines[i] = line.replace(/"[^"]*"/, `"${version}"`);
        cargoChanged = true;
      }
      break;
    }
  }
}
if (cargoChanged) {
  fs.writeFileSync(cargoPath, lines.join('\n'));
  changed++;
}

if (changed === 0) {
  log(`already in sync at ${version}.`);
} else {
  log(`synced ${changed} file(s) to ${version}.`);
}
