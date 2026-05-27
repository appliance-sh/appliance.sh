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
  description: 'Container runtime Appliance shells out to for `docker build` / `docker save`.',
  required: true,
  autoInstallable: false,

  async check(): Promise<CheckResult> {
    const r = await tryVersion('docker', ['--version']);
    if (!r) return { installed: false, error: 'not on PATH' };
    return { installed: true, version: firstLine(r.stdout) };
  },

  manualInstall(ctx: Context): ManualInstall {
    // All major container runtimes provide a Docker-compatible `docker`
    // CLI on PATH, so we don't prescribe one. The UI lists a few common
    // options and lets the user pick.
    if (ctx.platform === 'darwin') {
      return {
        instructions:
          'Install any container runtime — Docker Desktop, OrbStack, Colima, or Rancher Desktop all work.\n' +
          '  Docker Desktop:   https://www.docker.com/products/docker-desktop/\n' +
          '  OrbStack:         https://orbstack.dev\n' +
          '  Colima:           https://github.com/abiosoft/colima  (also: brew install docker)\n' +
          '  Rancher Desktop:  https://rancherdesktop.io',
        url: 'https://docs.docker.com/engine/install/',
      };
    }
    if (ctx.platform === 'linux') {
      return {
        instructions:
          'Install any container runtime — Docker Engine, Podman, or Rancher Desktop all work.\n' +
          '  Docker Engine:    curl -fsSL https://get.docker.com | sh\n' +
          '  Podman:           https://podman.io/docs/installation\n' +
          '  Rancher Desktop:  https://rancherdesktop.io',
        url: 'https://docs.docker.com/engine/install/',
      };
    }
    return {
      instructions:
        'Install any container runtime — Docker Desktop, Rancher Desktop, or Podman Desktop all work.\n' +
        '  Docker Desktop:   https://www.docker.com/products/docker-desktop/\n' +
        '  Rancher Desktop:  https://rancherdesktop.io\n' +
        '  Podman Desktop:   https://podman-desktop.io',
      url: 'https://docs.docker.com/desktop/install/windows-install/',
    };
  },
};
