import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { firstLine, tryVersion } from '../download.js';
import type { CheckResult, Context, ManualInstall, Provider } from '../types.js';

const execFileAsync = promisify(execFile);

// Pinned moby/buildkit release. buildctl is the BuildKit client: it
// streams a local build context (with .dockerignore handling and
// content-addressed incremental transfer) to a buildkitd over gRPC and
// drives the build. The appliance microVM runs buildkitd in-guest and
// forwards it to a host loopback port, so `buildctl` + that forward is
// the docker-free image build path — no docker daemon anywhere.
const BUILDKIT_VERSION = 'v0.31.1';

export function buildctlReleaseUrl(ctx: Context): string | null {
  const osName = ctx.platform === 'darwin' ? 'darwin' : ctx.platform === 'linux' ? 'linux' : 'windows';
  const arch = ctx.arch === 'arm64' ? 'arm64' : 'amd64';
  return `https://github.com/moby/buildkit/releases/download/${BUILDKIT_VERSION}/buildkit-${BUILDKIT_VERSION}.${osName}-${arch}.tar.gz`;
}

export const buildctlProvider: Provider = {
  name: 'buildctl',
  description: 'BuildKit client for docker-free image builds against the microVM’s in-guest buildkitd.',
  // Only needed by the VM-runtime build path; deploys fall back to
  // docker build when it is absent, so never block installs on it.
  required: false,
  autoInstallable: true,

  async check(ctx: Context): Promise<CheckResult> {
    const managed = path.join(ctx.binDir, process.platform === 'win32' ? 'buildctl.exe' : 'buildctl');
    const target = fs.existsSync(managed) ? managed : 'buildctl';
    const r = await tryVersion(target, ['--version']);
    if (!r) return { installed: false, error: 'not on PATH' };
    return { installed: true, version: firstLine(r.stdout), path: target };
  },

  async install(ctx: Context): Promise<void> {
    const url = buildctlReleaseUrl(ctx);
    if (!url) throw new Error('unsupported platform for buildctl');
    ctx.onProgress?.({ type: 'progress', tool: 'buildctl', message: `Downloading ${url}` });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildctl-'));
    try {
      const archive = path.join(tmpDir, 'buildkit.tar.gz');
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`buildctl download failed: HTTP ${res.status}`);
      fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
      // The release tarball nests binaries under `bin/`; we only need
      // the client. Same System32-bsdtar pinning as the crane provider:
      // a Git-Bash GNU tar first on PATH parses `C:\…` as a remote
      // host spec.
      const member = process.platform === 'win32' ? 'bin/buildctl.exe' : 'bin/buildctl';
      const tar =
        process.platform === 'win32'
          ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
          : 'tar';
      await execFileAsync(tar, ['-xzf', archive, '-C', tmpDir, member]);
      const extracted = path.join(tmpDir, ...member.split('/'));
      if (!fs.existsSync(extracted)) throw new Error(`${member} missing from release archive`);
      fs.chmodSync(extracted, 0o755);
      const dest = path.join(ctx.binDir, path.basename(extracted));
      fs.mkdirSync(ctx.binDir, { recursive: true });
      fs.copyFileSync(extracted, dest);
      fs.chmodSync(dest, 0o755);
      ctx.onProgress?.({ type: 'done', tool: 'buildctl', message: `Installed to ${dest}` });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  },

  manualInstall(_ctx: Context): ManualInstall {
    return {
      instructions: 'brew install buildkit  # or download from https://github.com/moby/buildkit/releases',
      url: 'https://github.com/moby/buildkit',
    };
  },
};
