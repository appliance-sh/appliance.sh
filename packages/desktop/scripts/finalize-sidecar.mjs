#!/usr/bin/env node
// Rename the sidecar's compiled entry to .cjs (tsc emits main.js; the
// desktop spawns it as CommonJS under a "type": "module" tree). A node
// script instead of `mv` so the build works on Windows runners, where
// pnpm scripts run under cmd.exe.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(__dirname, '..', 'sidecar', 'dist');

fs.renameSync(path.join(dist, 'main.js'), path.join(dist, 'main.cjs'));
try {
  fs.renameSync(path.join(dist, 'main.js.map'), path.join(dist, 'main.cjs.map'));
} catch {
  // source map is optional
}
console.log('finalize-sidecar: sidecar/dist/main.js → main.cjs');
