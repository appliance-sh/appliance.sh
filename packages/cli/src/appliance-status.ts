// Alias: appliance status → appliance app status
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appCmd = path.join(__dirname, 'appliance-app.js');

try {
  execFileSync(process.execPath, [appCmd, 'status', ...process.argv.slice(2)], { stdio: 'inherit' });
} catch {
  process.exit(1);
}
