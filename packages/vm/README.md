# appliance-vm

Appliance's microVM manager: one Rust executable that boots and
manages isolated Linux microVMs for running workloads — the engine
behind the next-generation local runtime. See `docs/microvm.md` at the
repo root for the architecture.

## Backends

| Platform | Backend                                      | Status                         |
| -------- | -------------------------------------------- | ------------------------------ |
| macOS    | Virtualization.framework (in-process, objc2) | boots                          |
| Linux    | KVM                                          | scaffold (reports unavailable) |
| Windows  | WSL2 (managed distro via `wsl.exe`)          | boots                          |

## Build & run (macOS)

Creating VMs is entitlement-gated; sign after building:

```bash
cargo build && ./scripts/sign-dev.sh
./target/debug/appliance-vm doctor      # backend availability
./target/debug/appliance-vm start       # create-on-demand + boot
./target/debug/appliance-vm console -f  # follow the boot log
./target/debug/appliance-vm status
./target/debug/appliance-vm stop
./target/debug/appliance-vm delete
```

State lives under `~/.appliance/vm/<name>/` (definition, sparse data
disk, console log, pidfile); guest kernel/initramfs pairs are cached
under `~/.appliance/vm/images/<image>/` and unwrapped from EFI zboot
packaging automatically.

## Build & run (Windows)

Requires WSL2 (`wsl --install` from an elevated prompt, then reboot —
`appliance-vm doctor` tells you when it's missing). No signing step:

```powershell
cargo build
.\target\debug\appliance-vm.exe doctor
.\target\debug\appliance-vm.exe up
```

Mechanics differ from macOS while the guest contract stays identical:
each VM is a registered WSL distro (`appliance-vm-<name>`) imported
from the hash-pinned Alpine minirootfs, with its VHDX stored under the
VM dir. The bootstrap (the WSL analogue of `appliance.start`) provisions
the same non-root `appliance` user, dev toolchain, optional dockerd, and
k3s + kubeconfig handoff. `/persist` is a plain directory (the VHDX is
the persistence), `--mount` is a drvfs bind mount instead of VirtioFS,
`vm shell` rides `wsl.exe`'s own ConPTY channel instead of vsock (tmux
sessions included), and `stop` is signalled through a per-VM
`stop.request` file (no SIGTERM on Windows) that terminates the distro.
`delete` also unregisters the distro. The egress proxy and credential
store are host-side and platform-neutral; the Netstack link (hard egress
boundary) is vz-only — WSL VMs police egress cooperatively via the
proxy, like a NAT VM.

## The full Appliance flow

`appliance vm up` (in the main CLI) wraps this binary and layers the
control plane on top: in-VM image registry, api-server bootstrap, and
the `microvm` credentials profile. After that:

```bash
appliance vm up
appliance deploy <project> <env> --profile microvm
# → http://<project>-<env>.appliance.localhost:8081, served from the VM
```

## Multiple VMs

Several VMs can run at once — e.g. one for interactive development and
another dedicated to traffic testing. Every command takes a name
(default `appliance`); each VM gets its own non-colliding block of host
ports (ingress / kubernetes / registry / egress) and its own
credentials profile (`microvm` for the default, `microvm-<name>` for
the rest).

```bash
appliance vm up --name traffic        # boots a second VM on its own ports
appliance vm list                     # all VMs with ports + running state
appliance deploy <project> <env> --profile microvm-traffic
```

The default `appliance` VM keeps the canonical 8081/6443/5052/5053;
additional VMs are allocated a contiguous block from 8100 upward.

## Connect & shell

```bash
appliance vm exec <pod> [cmd...]   # run in a workload pod (default: /bin/sh)
appliance vm shell [cmd...]        # root shell in the VM itself (kubectl debug node + chroot)
appliance vm kubeconfig            # path for `export KUBECONFIG=$(...)`
```

The desktop surfaces the same thing: a **Shell** button on running pods
in the Runtimes page opens an xterm terminal over a real PTY.

## Development environments

A microVM can run as an isolated **dev environment**: the VM host itself,
provisioned with a toolchain (bash, git, build-base, python3, node, …) and a
persistent `/persist/workspace` + home that survive `stop`/`up`. The same
egress controls confine it. Run several side by side with `--name`.

```bash
appliance vm dev up                 # boot the default VM as a dev environment
appliance vm dev up --name scratch  # a second, independent dev VM
appliance vm dev up --mount ./app   # share a host folder into the workspace
appliance vm dev shell              # interactive shell in /persist/workspace
appliance vm dev shell -- npm test  # or run one command
appliance vm dev status             # dev flag + workspace/toolchain readiness
```

The toolchain installs on first boot (from the network, then cached on the
data disk so later boots are fast/offline) in the background, so `dev up`
returns as soon as the cluster is ready. The desktop's Runtimes page mirrors
this: tick **dev environment** before Start to provision one (with an optional
**Share a folder…**), then **Open shell** opens an xterm into the workspace.

**Sharing a host folder** (`--mount <path>`) presents the folder to the guest
over VirtioFS and mounts it at `/persist/workspace` — edit on the host, run in
the VM. It implies `--dev`, is persisted (re-shared on every boot until
`appliance vm up --no-mount`), and applies on the next boot. Without it the
workspace lives on the VM's persistent data disk.

Mechanics: `dev` is persisted on the VM spec (`vm.json`, one-way — a later
plain `vm up` keeps it a dev VM). An interactive shell rides a **vsock**
channel: every VM runs a `socat` PTY agent on a fixed vsock port, the resident
host process bridges a per-VM Unix socket to it, and `appliance-vm shell`
drives that — no SSH, no TCP exposure, no k3s dependency, and no debugger pod
left behind. `appliance vm shell` / `vm dev shell` use it when the relay
socket is up and fall back to `kubectl debug node/` + chroot otherwise (older
VMs, or while the agent is still starting); one-shot `-- <cmd>` runs stay on
the kubectl path for clean output + an exit code.

## Egress control (outbound traffic)

The VM routes workload egress through a proxy Appliance runs and the
desktop controls (Docker-sandbox style). The proxy starts with the VM;
a peer guard keeps it reachable by the guest but never an open LAN
proxy. See `docs/microvm.md` for the architecture.

```bash
appliance vm egress policy          # show the current policy
appliance vm egress default deny    # default-deny; then allowlist:
appliance vm egress allow github.com
appliance vm egress deny  gist.github.com   # deny wins over allow
appliance vm egress mitm on         # intercept TLS (decrypt) on allowed HTTPS
appliance vm egress gateway         # HTTPS_PROXY + CA values for workloads
appliance vm egress log             # recent traffic as JSON (desktop feed)
appliance vm egress reset           # back to permissive default
```

With `mitm on`, workloads must trust the per-VM CA
(`~/.appliance/vm/<name>/egress-ca.pem`); the proxy then mints a leaf
per host on the fly and sees the decrypted request.

The desktop's Runtimes page shows a live **traffic feed** (every
request the proxy saw, allow/deny/mitm-tagged) with one-click per-host
Allow / Block — like Docker Desktop's network panel.

## Credential capture & injection (apiKeyHelper)

With interception on, the proxy can keep credentials out of workloads:
per host, **capture** a credential header off requests into a
host-side store (outside the VM, written 0600) and/or **inject** it
onto outbound requests — sourcing the value from the stored secret or
from an `apiKeyHelper` command (its stdout is the credential).

```bash
appliance vm creds add api.openai.com --capture --inject   # lift + re-inject Authorization
appliance vm creds add api.foo.com --inject --helper 'op read op://vault/foo/key'
appliance vm creds set api.bar.com 'Bearer sk-…'           # paste a secret by hand
appliance vm creds list                                    # rules + masked secrets (JSON)
appliance vm creds rm api.openai.com
appliance vm creds forget                                  # drop all stored secrets
```

Header defaults to `authorization`; override with `--header`. The
desktop's **Credentials** panel offers the same per-host rules,
apiKeyHelper field, and masked secret list.
