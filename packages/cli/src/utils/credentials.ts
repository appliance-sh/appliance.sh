import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface Credentials {
  apiUrl: string;
  keyId: string;
  secret: string;
}

const CREDENTIALS_DIR = path.join(os.homedir(), '.appliance');
const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, 'credentials.json');

export function saveCredentials(credentials: Credentials): void {
  if (!fs.existsSync(CREDENTIALS_DIR)) {
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2), { mode: 0o600 });
}

export function loadCredentials(): Credentials | null {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) {
      return null;
    }
    const data = fs.readFileSync(CREDENTIALS_FILE, 'utf-8');
    return JSON.parse(data) as Credentials;
  } catch {
    return null;
  }
}

export function clearCredentials(): void {
  try {
    if (fs.existsSync(CREDENTIALS_FILE)) {
      fs.unlinkSync(CREDENTIALS_FILE);
    }
  } catch {
    // ignore errors
  }
}
