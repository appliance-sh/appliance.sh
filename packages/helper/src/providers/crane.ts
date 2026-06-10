import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { firstLine, tryVersion } from '../download.js';
import type { CheckResult, Context, ManualInstall, Provider } from '../types.js';

const execFileAsync = promisify(execFile);

// Pinned go-containerregistry release. crane pushes images (including
// `docker save` tarballs) straight to a registry over HTTP from the
// host process — no docker daemon in the path. That matters because
// the daemon often runs inside a VM (colima/Docker Desktop) where the
// host's 127.0.0.1 is unreachable: pushes to host-loopback registries
// (the microVM engine's image delivery) must originate host-side.
const CRANE_VERSION = 'v0.20.3';

function releaseUrl(ctx: Context): string | null {
  const osName = ctx.platform === 'darwin' ? 'Darwin' : ctx.platform === 'linux' ? 'Linux' : 'Windows';
  const arch = ctx.arch === 'arm64' ? 'arm64' : 'x86_64';
  return `https://github.com/google/go-containerregistry/releases/download/${CRANE_VERSION}/go-containerregistry_${osName}_${arch}.tar.gz`;
}

export const craneProvider: Provider = {
  name: 'crane',
  description: 'Pushes container images to registries without a docker daemon (used for microVM image delivery).',
  // Only required by the microVM engine; the k3d runtime works
  // without it, so don't block `appliance local install` on it.
  required: false,
  autoInstallable: true,

  async check(ctx: Context): Promise<CheckResult> {
    const managed = path.join(ctx.binDir, process.platform === 'win32' ? 'crane.exe' : 'crane');
    const target = fs.existsSync(managed) ? managed : 'crane';
    const r = await tryVersion(target, ['version']);
    if (!r) return { installed: false, error: 'not on PATH' };
    return { installed: true, version: firstLine(r.stdout), path: target };
  },

  async install(ctx: Context): Promise<void> {
    const url = releaseUrl(ctx);
    if (!url) throw new Error('unsupported platform for crane');
    ctx.onProgress?.({ type: 'progress', tool: 'crane', message: `Downloading ${url}` });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crane-'));
    try {
      const archive = path.join(tmpDir, 'crane.tar.gz');
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`crane download failed: HTTP ${res.status}`);
      fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
      // The release is a tar.gz with `crane` at its root. System tar
      // handles it on every platform we ship (bsdtar on macOS/Windows,
      // GNU tar on Linux).
      await execFileAsync('tar', ['-xzf', archive, '-C', tmpDir, 'crane']);
      const extracted = path.join(tmpDir, 'crane');
      if (!fs.existsSync(extracted)) throw new Error('crane missing from release archive');
      fs.chmodSync(extracted, 0o755);
      const dest = path.join(ctx.binDir, process.platform === 'win32' ? 'crane.exe' : 'crane');
      fs.mkdirSync(ctx.binDir, { recursive: true });
      fs.copyFileSync(extracted, dest);
      fs.chmodSync(dest, 0o755);
      ctx.onProgress?.({ type: 'done', tool: 'crane', message: `Installed to ${dest}` });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  },

  manualInstall(_ctx: Context): ManualInstall {
    return {
      instructions: 'brew install crane  # or download from https://github.com/google/go-containerregistry/releases',
      url: 'https://github.com/google/go-containerregistry',
    };
  },
};
