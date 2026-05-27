import { firstLine, tryVersion } from '../download.js';
import type { CheckResult, Context, ManualInstall, Provider } from '../types.js';

// Docker provider is *detect-only*. A working "docker engine" on a
// user's machine is a combination of:
//
//   * macOS:   Docker Desktop GUI install, OR Colima + lima + qemu
//   * Linux:   dockerd + containerd + iptables + cgroups (root needed)
//   * Windows: Docker Desktop with WSL2 (kernel feature flags)
//
// None of these are responsibly automatable from an unprivileged
// userland binary without forking system trust decisions. We probe
// the `docker` CLI to confirm reachability and surface canonical
// install URLs when missing. The user follows the link; we re-check
// on every status call so progress is visible.
//
// `appliance local install docker` deliberately returns guidance
// rather than attempting an install — paired with `manualInstall`
// instructions the orchestrator surfaces in the CLI / UI.

export const dockerProvider: Provider = {
  name: 'docker',
  description: 'Container engine k3d runs Kubernetes nodes inside.',
  required: true,
  autoInstallable: false,

  async check(): Promise<CheckResult> {
    const r = await tryVersion('docker', ['--version']);
    if (!r) return { installed: false, error: 'not on PATH' };
    return { installed: true, version: firstLine(r.stdout) };
  },

  manualInstall(ctx: Context): ManualInstall {
    if (ctx.platform === 'darwin') {
      return {
        instructions:
          'Install Colima (recommended, open-source): https://github.com/abiosoft/colima\n' +
          'Or Docker Desktop: https://www.docker.com/products/docker-desktop/',
        url: 'https://github.com/abiosoft/colima#installation',
      };
    }
    if (ctx.platform === 'linux') {
      return {
        instructions: 'curl -fsSL https://get.docker.com | sh',
        url: 'https://docs.docker.com/engine/install/',
      };
    }
    return {
      instructions: 'Install Docker Desktop: https://www.docker.com/products/docker-desktop/',
      url: 'https://docs.docker.com/desktop/install/windows-install/',
    };
  },
};
