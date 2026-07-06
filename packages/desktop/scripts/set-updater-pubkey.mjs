#!/usr/bin/env node
// Inject the updater signing PUBLIC key into tauri.conf.json from the
// TAURI_UPDATER_PUBKEY env var (CI sets it from a repo secret alongside
// TAURI_SIGNING_PRIVATE_KEY). The committed config carries a placeholder
// so update checks fail-safe (signature verification rejects everything)
// on builds without the real key — see README -> Auto-update.
//
// Generate a keypair once with:
//   pnpm exec tauri signer generate -w ~/.tauri/appliance.key
// then store the private key + password as the TAURI_SIGNING_PRIVATE_KEY /
// TAURI_SIGNING_PRIVATE_KEY_PASSWORD secrets and the printed public key
// as TAURI_UPDATER_PUBKEY.
//
// No-op (with a note) when the env var is absent, so local builds and
// forks keep working unchanged.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const confPath = path.resolve(__dirname, '..', 'src-tauri', 'tauri.conf.json');

const pubkey = process.env.TAURI_UPDATER_PUBKEY?.trim();
if (!pubkey) {
  console.log('set-updater-pubkey: TAURI_UPDATER_PUBKEY not set — leaving the placeholder (updates stay disabled).');
  process.exit(0);
}

const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
if (!conf.plugins?.updater) {
  console.error(`set-updater-pubkey: ${confPath} has no plugins.updater section`);
  process.exit(1);
}
conf.plugins.updater.pubkey = pubkey;
fs.writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');
console.log('set-updater-pubkey: injected the updater public key into tauri.conf.json.');
