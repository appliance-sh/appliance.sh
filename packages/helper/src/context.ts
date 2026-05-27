import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Arch, Context, Platform } from './types.js';

/**
 * Directory the helper installs binaries into. Resolved once here so
 * every caller agrees on a single location:
 *
 *   POSIX:   ~/.appliance/bin
 *   Windows: %LOCALAPPDATA%\Appliance\bin (falls back to ~/.appliance/bin)
 *
 * `.appliance` matches the rest of the CLI's home-dir layout
 * (credentials.json, settings.json, …) so backups, sync tools, and
 * security policies can target one dir.
 */
export function helperBinDir(): string {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local) return path.join(local, 'Appliance', 'bin');
  }
  return path.join(os.homedir(), '.appliance', 'bin');
}

/** Detect the runtime platform in the discriminated form the providers use. */
export function detectPlatform(): Platform {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'linux') return 'linux';
  if (process.platform === 'win32') return 'win32';
  throw new Error(`Unsupported platform: ${process.platform}`);
}

/** Map Node's arch values onto the upstream release naming we use. */
export function detectArch(): Arch {
  if (process.arch === 'arm64') return 'arm64';
  if (process.arch === 'x64') return 'x64';
  throw new Error(`Unsupported arch: ${process.arch}`);
}

/** Build a Context with a freshly-created binDir. */
export function createContext(opts?: { onProgress?: Context['onProgress'] }): Context {
  const binDir = helperBinDir();
  fs.mkdirSync(binDir, { recursive: true });
  return {
    binDir,
    platform: detectPlatform(),
    arch: detectArch(),
    onProgress: opts?.onProgress,
  };
}

/**
 * Prepend the helper binDir to the current process's PATH so
 * subsequent spawns of `k3d`, `kubectl`, … resolve to helper-managed
 * binaries when the system PATH lacks them. Idempotent — safe to call
 * multiple times. The first call wins; later calls notice the dir is
 * already on PATH and no-op.
 *
 * Called at CLI startup and on demand from the desktop's Node
 * sidecar. The desktop's Rust side mirrors this via its own PATH
 * adjustment for `Command::new`.
 */
export function ensureHelperBinOnPath(): string {
  const dir = helperBinDir();
  const sep = path.delimiter;
  const current = process.env.PATH ?? '';
  const segments = current.split(sep);
  if (segments.includes(dir)) return dir;
  process.env.PATH = current.length === 0 ? dir : `${dir}${sep}${current}`;
  return dir;
}
