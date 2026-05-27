import { downloadBinary, firstLine, tryVersion } from '../download.js';
import type { CheckResult, Context, ManualInstall, Provider } from '../types.js';

// k3d publishes single-binary releases on GitHub at predictable URLs.
// Matrix per platform / arch:
//
//   darwin/x64      k3d-darwin-amd64
//   darwin/arm64    k3d-darwin-arm64
//   linux/x64       k3d-linux-amd64
//   linux/arm64     k3d-linux-arm64
//   win32/x64       k3d-windows-amd64.exe
//
// Version is pinned in code — bumping is one constant change.
const DEFAULT_K3D_VERSION = 'v5.8.3';

function assetName(ctx: Context): string {
  const archPart = ctx.arch === 'arm64' ? 'arm64' : 'amd64';
  if (ctx.platform === 'darwin') return `k3d-darwin-${archPart}`;
  if (ctx.platform === 'linux') return `k3d-linux-${archPart}`;
  if (ctx.platform === 'win32') return `k3d-windows-${archPart}.exe`;
  throw new Error(`Unsupported platform/arch for k3d: ${ctx.platform}/${ctx.arch}`);
}

function releaseUrl(version: string, ctx: Context): string {
  return `https://github.com/k3d-io/k3d/releases/download/${version}/${assetName(ctx)}`;
}

export const k3dProvider: Provider = {
  name: 'k3d',
  description: 'Lightweight Kubernetes-in-Docker cluster used as the local runtime.',
  required: true,
  autoInstallable: true,

  async check(): Promise<CheckResult> {
    const r = await tryVersion('k3d', ['--version']);
    if (!r) return { installed: false, error: 'not on PATH' };
    return { installed: true, version: firstLine(r.stdout) };
  },

  async install(ctx: Context, opts?: { version?: string }): Promise<void> {
    const version = opts?.version ?? DEFAULT_K3D_VERSION;
    ctx.onProgress?.({ type: 'start', tool: 'k3d', message: `Installing k3d ${version}` });
    await downloadBinary({
      ctx,
      name: 'k3d',
      url: releaseUrl(version, ctx),
      sanityCheck: ['--version'],
    });
    ctx.onProgress?.({ type: 'done', tool: 'k3d', message: `k3d ${version} installed` });
  },

  manualInstall(ctx: Context): ManualInstall {
    if (ctx.platform === 'darwin') {
      return {
        instructions: 'brew install k3d',
        url: 'https://k3d.io/stable/#installation',
      };
    }
    if (ctx.platform === 'linux') {
      return {
        instructions: 'curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash',
        url: 'https://k3d.io/stable/#installation',
      };
    }
    return {
      instructions: 'choco install k3d  # or: scoop install k3d',
      url: 'https://k3d.io/stable/#installation',
    };
  },
};
