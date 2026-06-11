# Appliance microVMs

Design for the next step beyond k3d-on-docker: Appliance spins up its
own microVM that runs workloads safely and in isolation — no Docker
Desktop, no colima, no shared host daemon. Think of it as Appliance's
sandbox runtime: one purpose-built VM per machine (later: per project)
whose entire lifecycle belongs to Appliance.

## Why move past k3d-on-docker

The k3d local runtime works, but it rents someone else's VM. On macOS
the k3d nodes live inside whatever Docker provider the user installed
(colima, Docker Desktop, OrbStack), which means:

- **Trust + isolation**: workloads share a VM with everything else the
  user runs in docker. We can't make isolation promises about a VM we
  don't own.
- **Lifecycle fragility**: most local-runtime failure modes we've fixed
  to date (wedged kubelets after VM restarts, stopped colima VMs,
  registry mirrors lost across restarts, docker contexts pointing
  elsewhere) are symptoms of layering on a runtime we don't control.
- **Onboarding**: "install any container runtime first" is the worst
  step of `appliance local up`. A built-in VMM removes the only
  prerequisite we can't auto-install.

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│ appliance-vm (single Rust executable)                     │
│                                                           │
│  CLI: create / start / stop / delete / status / console   │
│                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │ vz backend   │  │ kvm backend  │  │ wsl backend  │    │
│  │ macOS        │  │ Linux        │  │ Windows      │    │
│  │ Virtualization│ │ /dev/kvm     │  │ wsl.exe      │    │
│  │ .framework   │  │ (rust-vmm)   │  │ managed distro│   │
│  └──────────────┘  └──────────────┘  └──────────────┘    │
│                                                           │
│  Guest contract (identical on every backend):             │
│   • direct kernel boot, virtio console → log file         │
│   • virtio-blk data disk (persistent, survives delete     │
│     of the VM definition only on explicit flag)           │
│   • virtio-net NAT with host port forwards                │
│   • k3s (containerd) as the workload runtime              │
└───────────────────────────────────────────────────────────┘
```

### The backend trait

`VmBackend` is the seam that keeps platform code contained:

- `availability()` — can this backend run here (hypervisor present,
  entitlements held, /dev/kvm accessible, WSL2 installed)?
- `create(spec)` — materialize disks/config for a named VM.
- `start(name)` / `stop(name)` / `delete(name)` — lifecycle.
- `state(name)` — exists / running, plus backend-specific detail.

The CLI, state store, guest provisioning, and host wiring are all
backend-agnostic. A backend's only job is "boot this kernel with these
devices and keep it running".

### Backend choices

- **macOS — Virtualization.framework, in-process.** The desktop shell
  is already Rust (Tauri); `objc2-virtualization` gives us VZ bindings
  without a Swift helper. This is the same foundation Docker Desktop
  and OrbStack build on, driven directly rather than through an
  external VM manager. Requires the `com.apple.security.virtualization`
  entitlement (ad-hoc signing is sufficient for local dev; the desktop
  app's signing pipeline adds it for distribution).
- **Linux — KVM.** Target shape: an embedded rust-vmm based VMM
  (mmio virtio devices, no device emulation beyond what the guest
  contract needs). Until that lands, the backend reports itself
  unavailable with a clear message; k3d remains the Linux path.
- **Windows — WSL2.** WSL2 _is_ a managed utility VM; the backend
  drives `wsl.exe` (import a purpose-built distro tarball, run k3s
  inside it) rather than booting a kernel ourselves. Same guest
  contract, different mechanics.

### Guest

A deliberately tiny, versioned guest — not a general-purpose distro:

- **Boot**: direct kernel boot (no firmware, no bootloader) of a
  pinned Alpine `virt` kernel + a custom initramfs. Sub-second kernel
  start; the image pair is a few tens of MB, downloaded once into
  `~/.appliance/vm/images/<version>/` (same managed-asset model as
  `appliance local install` uses for k3d/kubectl).
- **Init**: our own minimal init (busybox + a shell script baked into
  the initramfs): bring up virtio-net via DHCP, mount the virtio-blk
  data disk (mkfs on first boot), then exec **k3s server** with its
  data dir on the persistent disk.
- **Workload runtime**: k3s directly — not docker+k3d. k3d exists to
  wrap k3s in docker on machines where docker is the only common
  denominator; inside a VM we own end-to-end, that indirection buys
  nothing and costs boot time, memory, and a registry-mirror config
  layer. k3s's embedded containerd runs the containers. (If a concrete
  need for docker-in-VM appears — e.g. host-side `docker build`
  delegation — it can be added to the guest image without changing the
  host contract.)
- **Control channel**: virtio-vsock for host↔guest exec and readiness
  (no SSH keys, no TCP exposure). The guest init runs a tiny vsock
  agent; `appliance-vm exec` rides it.

### Host wiring — same DX, new engine

The existing `appliance-base-kubernetes` base is the integration
point; nothing above it changes:

1. `appliance vm up` boots the VM, waits for k3s readiness, reads the
   admin kubeconfig over vsock, and rewrites its server address to the
   forwarded port on `127.0.0.1`.
2. The in-cluster api-server bootstrap (`bootstrapInClusterApiServer`,
   already shared in `@appliance.sh/helper`) applies the same manifests
   against that kubeconfig — Traefik ingress at
   `api.appliance.localhost:<hostPort>` exactly as on k3d.
3. `appliance deploy` detects the kubernetes base via `/cluster-info`
   and follows the existing image pipeline. Image delivery uses the
   registry the VM exposes (or `ctr image import` over vsock as the
   mirror-less fallback, replacing `k3d image import`).
4. Ingress port forwards: host `:8081 → guest :80` (ingress) and the
   NodePort window, identical to the k3d port mappings, so
   `<project>-<env>.appliance.localhost:8081` keeps working verbatim.

Because `.localhost` names resolve to 127.0.0.1 everywhere, hostname
routing needs zero new machinery — only the port forward.

### Packaging — one executable

`appliance-vm` builds as a single static-ish binary per platform:

- The desktop bundles it the same way it bundles the Node sidecar
  today, and drives it in-process on macOS (library) or as a child
  process (CLI parity on all platforms).
- The npm CLI ships it per-platform via optionalDependencies (the
  standard esbuild/turbo pattern) so `appliance vm up` works without
  the desktop app.

### Phasing

1. **Crate + macOS boot** _(done)_: backend trait, CLI, state
   store, VZ backend booting the pinned guest kernel with console
   logging, NAT networking, persistent data disk. KVM/WSL backends
   present but report unavailable.
2. **Guest image + k3s** _(done)_: rather than a fully custom
   initramfs, the boot media is a host-built FAT volume (pure Rust:
   fatfs + tar) carrying the Alpine modloop, an apkovl overlay, and
   the pinned k3s binary; Alpine's own diskless init handles module
   loading and root assembly, then openrc runs our bootstrap which
   formats/mounts the data disk and starts k3s. Host↔guest
   connectivity needs no agent: the VZ NAT subnet is host-reachable,
   the guest's address is discovered from the macOS DHCP lease table
   via the VM's fixed MAC (the Lima approach), the kubeconfig is
   served once over a guest-local HTTP handoff, and the resident host
   process runs plain TCP forwards (`127.0.0.1:6443 → guest:6443`,
   `127.0.0.1:8081 → guest:80`). `appliance-vm up` returns a working
   kubeconfig; `kubectl get nodes` is Ready ~30s after a warm boot and
   Traefik serves `<name>.appliance.localhost:8081` exactly like the
   k3d runtime.
3. **DX integration** _(done)_: `appliance vm up` boots the VM,
   waits for the in-VM registry (registry:2 via k3s's auto-applying
   manifests dir, NodePort 30500, host forward on 5052 — clear of
   k3d's 5050 so both engines coexist), pushes the api-server image
   host-side (`docker save` + `crane push` — a plain `docker push`
   executes inside the docker provider's VM where the host's loopback
   registries don't exist), bootstraps the api-server in-VM by digest
   ref (reused tags don't roll deployments), and registers the
   `microvm` profile. `appliance deploy` then works verbatim: the
   pipeline reads the registry from `/cluster-info`, falls back to
   crane when `docker push` can't reach it, and the resulting app
   serves at `<project>-<env>.appliance.localhost:8081` exactly as on
   k3d. State persists across `vm stop`/`vm up` on the data disk
   (projects, credentials, images, running workloads all survive).
   Note: images must match the VM's architecture — there is no binfmt
   emulation in the guest (Lambda-targeted amd64 images need an arm64
   rebuild on Apple Silicon).
4. **KVM backend**, then **WSL backend**; desktop Local Runtime page
   grows a runtime-engine selector (k3d ⇄ microVM); guest exec
   channel (vsock) for logs/debugging without the console.
