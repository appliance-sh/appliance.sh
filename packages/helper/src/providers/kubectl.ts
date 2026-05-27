import { downloadBinary, firstLine, tryVersion } from '../download.js';
import type { CheckResult, Context, ManualInstall, Provider } from '../types.js';

// kubectl publishes per-version single-binary downloads from the
// Kubernetes release CDN. Matrix:
//
//   darwin/x64       darwin/amd64/kubectl
//   darwin/arm64     darwin/arm64/kubectl
//   linux/x64        linux/amd64/kubectl
//   linux/arm64      linux/arm64/kubectl
//   win32/x64        windows/amd64/kubectl.exe
//
// We pin a stable version rather than chasing `latest` so the helper
// can be reproducible across machines.
const DEFAULT_KUBECTL_VERSION = 'v1.31.4';

function releaseUrl(version: string, ctx: Context): string {
  const archPart = ctx.arch === 'arm64' ? 'arm64' : 'amd64';
  if (ctx.platform === 'darwin') {
    return `https://dl.k8s.io/release/${version}/bin/darwin/${archPart}/kubectl`;
  }
  if (ctx.platform === 'linux') {
    return `https://dl.k8s.io/release/${version}/bin/linux/${archPart}/kubectl`;
  }
  if (ctx.platform === 'win32') {
    return `https://dl.k8s.io/release/${version}/bin/windows/${archPart}/kubectl.exe`;
  }
  throw new Error(`Unsupported platform/arch for kubectl: ${ctx.platform}/${ctx.arch}`);
}

export const kubectlProvider: Provider = {
  name: 'kubectl',
  description: 'Used to apply Deployments / Services onto the local cluster.',
  required: true,
  autoInstallable: true,

  async check(): Promise<CheckResult> {
    // kubectl predates `--version`; `version --client` is the
    // back-compatible incantation.
    const r = await tryVersion('kubectl', ['version', '--client']);
    if (!r) return { installed: false, error: 'not on PATH' };
    return { installed: true, version: firstLine(r.stdout) };
  },

  async install(ctx: Context, opts?: { version?: string }): Promise<void> {
    const version = opts?.version ?? DEFAULT_KUBECTL_VERSION;
    ctx.onProgress?.({ type: 'start', tool: 'kubectl', message: `Installing kubectl ${version}` });
    await downloadBinary({
      ctx,
      name: 'kubectl',
      url: releaseUrl(version, ctx),
      sanityCheck: ['version', '--client'],
    });
    ctx.onProgress?.({ type: 'done', tool: 'kubectl', message: `kubectl ${version} installed` });
  },

  manualInstall(ctx: Context): ManualInstall {
    if (ctx.platform === 'darwin') {
      return { instructions: 'brew install kubectl', url: 'https://kubernetes.io/docs/tasks/tools/' };
    }
    if (ctx.platform === 'linux') {
      return {
        instructions:
          'curl -LO https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl && sudo install -m 0755 kubectl /usr/local/bin/kubectl',
        url: 'https://kubernetes.io/docs/tasks/tools/',
      };
    }
    return {
      instructions: 'winget install Kubernetes.kubectl',
      url: 'https://kubernetes.io/docs/tasks/tools/',
    };
  },
};
