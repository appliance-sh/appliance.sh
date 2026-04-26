import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// User-global CLI settings, kept alongside ~/.appliance/credentials.json.
// `trustedProjects` is auto-managed: the manifest loader appends to
// it after a TTY prompt, and reads it on every code-manifest load.
// Other keys are reserved for future settings (theme, default
// region, etc.) — the loader tolerates unknown keys by preserving
// them on read-modify-write.
export interface Settings {
  trustedProjects?: string[];
}

const SETTINGS_DIR = path.join(os.homedir(), '.appliance');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');

export function loadSettings(): Settings {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return {};
    const data = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === 'object') return parsed as Settings;
    return {};
  } catch {
    // Corrupt file shouldn't brick the CLI. Treat as empty; the
    // next save rewrites it cleanly.
    return {};
  }
}

export function saveSettings(settings: Settings): void {
  if (!fs.existsSync(SETTINGS_DIR)) {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), { mode: 0o600 });
}

export function isTrustedProject(absoluteDir: string): boolean {
  const normalized = path.resolve(absoluteDir);
  const list = loadSettings().trustedProjects ?? [];
  return list.some((entry) => path.resolve(entry) === normalized);
}

export function addTrustedProject(absoluteDir: string): void {
  const normalized = path.resolve(absoluteDir);
  const settings = loadSettings();
  const existing = settings.trustedProjects ?? [];
  if (existing.some((entry) => path.resolve(entry) === normalized)) return;
  settings.trustedProjects = [...existing, normalized];
  saveSettings(settings);
}

export function settingsFilePath(): string {
  return SETTINGS_FILE;
}
