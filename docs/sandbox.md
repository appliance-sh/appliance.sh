# In-guest Docker engine architecture

**Status:** Decided (spike). **Engine:** Docker Engine (`dockerd`) in-guest, alongside k3s/containerd. This doc decides the _how_.

## Context

The microVM is diskless Alpine: a netboot initramfs mounts the FAT boot media, applies our apkovl, and `etc/local.d/appliance.start` formats/mounts the ext4 data disk at `/persist` (`guest.rs:113-125`), then launches k3s with `--data-dir /persist/k3s` (`guest.rs:224`). Dev VMs add a backgrounded apk toolchain install cached on `/persist/apk-cache` via a symlink at `/etc/apk/cache` (`guest.rs:255-288`). The host reaches the guest only over the vz NAT subnet (`net.rs:6-11`) plus a single vsock device (`backend/vz/mod.rs:224`) that the shell relay rides (`backend/vz/shell.rs`). All egress is meant to flow through the per-VM forward proxy bound on the gateway `:5053` (`egress.rs:404-417`, `main.rs:518`), which trusts a per-VM CA baked into the guest store (`guest.rs:109-111`, `393-395`).

## 1. Packaging

**Recommendation:** `apk add docker docker-cli-compose` from the Alpine community repo, installed by a backgrounded block mirroring `DEV_PROVISION`, with the download cached on `/persist/apk-cache`.

Alpine ships a maintained `docker` aplet (dockerd + containerd + runc + CNI plugins) on `v3.21/community`, which is already a configured repo (`guest.rs:364`). Because the apk cache symlink already points at `/persist/apk-cache` (`guest.rs:261`), first boot pulls from the network; later boots reinstall into the tmpfs root from the on-disk cache — fast and offline, identical to the dev toolchain. Run it in a `( … ) &` subshell so it never delays k3s readiness or the kubeconfig handoff (the gate `vm up` waits on, `guest.rs:275-287`), writing a `/persist/.docker-ready` marker for status.

**Rejected:** pinned static binaries from download.docker.com — gives version control but reintroduces a bespoke download/verify path (we'd duplicate `images::download_to`), bypasses the apk cache pattern, and bloats the boot media. Stay with apk; pin via `=<version>` if reproducibility bites.

## 2. Coexistence with k3s/containerd

**Recommendation:** Fully separate dockerd instance. Distinct `--data-root /persist/docker`, distinct `containerd` (dockerd's own bundled containerd, _not_ k3s's), distinct socket `/persist/docker/docker.sock`. k3s keeps its embedded containerd at `/persist/k3s` untouched — they never share a containerd namespace. `rc.conf` already sets `rc_cgroup_mode="unified"` (cgroups v2, `guest.rs:370-373`); dockerd uses the systemd-less cgroupfs driver, sharing the unified hierarchy with kubelet without conflict.

**Startup ordering:** dockerd starts _after_ `/persist` is mounted but is **lazy / decoupled from the bring-up phases**. The Media→Booting→Network→Cluster→Ready ladder (`bringup.rs:23-39`) gates on k3s + kubeconfig only; docker readiness must not block `Ready`. Launch dockerd backgrounded right after the provision block (alongside the toolchain install) so it warms in parallel and is ready by the time anyone shells in. Resource pressure is real on the 2-CPU/4-GiB default (`spec.rs:59-62`); document bumping `--memory` for heavy builds.

## 3. Host→guest socket exposure

**Recommendation:** Reuse the vsock channel, exactly like the shell. Add a second guest-side `socat VSOCK-LISTEN:<port>,fork UNIX-CONNECT:/persist/docker/docker.sock` (a sibling of the shell agent, `guest.rs:131-138`), pick a fixed `DOCKER_VSOCK_PORT` constant, and add a second relay analogous to `shell::spawn_relay` that bridges a per-VM `docker.sock` (new `VmPaths` entry next to `shell_sock`, `spec.rs:206-211`) to fresh vsock connections. The host then exports `DOCKER_HOST=unix://~/.appliance/vm/<name>/docker.sock`.

**Rejected:** a TCP forward (`net.rs:spawn_proxy`) to a dockerd TCP port. A docker socket is a root-equivalent control plane; exposing it on `127.0.0.1` makes it reachable by any local process and any container that can reach the host. vsock keeps it off the network entirely, and the relay socket is already created `0600` owner-only (`backend/vz/shell.rs:43`) — same trust model as the shell.

## 4. Image storage / persistence

**Recommendation:** `/persist/docker` (data-root) on the ext4 data disk — images, layers, volumes, and dockerd's containerd state all survive `vm stop`/`vm up` exactly as k3s state does. Keep it a sibling of `/persist/k3s` and `/persist/registry`. Default disk is 10 GiB sparse (`spec.rs:63-64`); image layers grow fast, so surface a `--disk` bump and document it.

## 5. Published-port forwarding

**Recommendation:** Extend the existing host TCP forward logic (`net.rs:spawn_proxy`, wired in `guest.rs:host_services:528-543`), not the docker proxy. When a container publishes a port, dockerd's userland proxy binds it on the _guest's_ `0.0.0.0:<p>`; the host already reaches the guest IP directly over the NAT subnet. So forwarding is one `spawn_proxy(host_p, SocketAddr::new(guest_ip, container_p))` call. To preserve the `*.appliance.localhost:8081` surface and the one-engine-per-host-port invariant, published ports must come from each VM's allocated block, never the canonical `8081/6443/5052/5053` reserved for ingress/api/registry/egress (`spec.rs:97-117`). Concretely: add a small per-VM published-port map (persisted like the spec) that `host_services` reads and forwards on bring-up, and a `vm docker publish` command that registers `(hostPort, guestPort)` and spawns the forward live — reusing the `bind_hint` collision message (`guest.rs:523`) verbatim so a clash names the fix.

## 6. Security posture

**Recommendation:** **root dockerd** in the guest. The VM _is_ the sandbox; rootless dockerd on diskless Alpine needs subuid/subgid + fuse-overlayfs plumbing that buys little when the blast radius is already a throwaway microVM, and it would complicate cgroup/overlay setup. Keep the socket off the network (vsock, §3) as the actual isolation boundary.

**Egress:** dockerd and its containers must honor the existing policy. The egress CA is already trusted node-wide via `update-ca-certificates` (`guest.rs:109-111`), so MITM'd TLS (`mitm.rs`) validates for `docker pull` and builds out of the box. Inject `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY = guest_proxy_url(...)` (`egress.rs:408-417`, `default_no_proxy:451`) into **dockerd's own environment** (so registry pulls are policed) and into **build/run defaults** (so `docker build` and containers inherit it) — mirroring the ConfigMap injection k3s workloads get (`egress.rs:render_configmap:469`). Credential capture/injection (`creds.rs`) then works for registry auth and in-container API calls flowing through the proxy, with secrets staying host-side.

## 7. Task breakdown (downstream)

**Task A — Provision dockerd**

- [ ] Add a `DOCKER_PROVISION` block (gated like `DEV_PROVISION`, `guest.rs:382`) that `apk add docker docker-cli-compose`, backgrounded, cache on `/persist/apk-cache`.
- [ ] Launch `dockerd --data-root /persist/docker -H unix:///persist/docker/docker.sock` after `/persist` mounts; do not gate any bring-up phase on it.
- [ ] Inject `HTTP(S)_PROXY`/`NO_PROXY` into dockerd's env; write `/persist/.docker-ready`.
- **Accept:** `vm shell` → `docker run hello-world` succeeds on a warm boot; works offline after first boot; k3s still reaches `Ready`; `docker pull` is blocked when egress default=deny and allowed via the proxy when permitted.

**Task B — In-guest build from a host context**

- [ ] Make the host context reachable in-guest — reuse the VirtioFS share (`WORKSPACE_VIRTIOFS_TAG`, `guest.rs:43`) or stream a tar over the docker socket.
- [ ] `vm docker build` (or plain `docker build` via `DOCKER_HOST`) builds against `/persist/workspace`.
- **Accept:** a Dockerfile + a docker-compose project in the shared workspace build and run; the resulting image persists across `vm stop`/`vm up`.

**Task C — Host↔guest socket + published-port plumbing**

- [ ] Add `DOCKER_VSOCK_PORT` + guest socat bridge; add a `docker.sock` relay (clone `shell::spawn_relay`, `0600`) and a `VmPaths::docker_sock()`.
- [ ] Add a per-VM published-port registry + `vm docker publish`; have `host_services` forward registered ports via `spawn_proxy`, drawing host ports from the allocated block and refusing the reserved four.
- **Accept:** `DOCKER_HOST=unix://…/docker.sock docker ps` works from the host; a published container port is reachable at `127.0.0.1:<allocatedPort>` while `8081/6443/5052/5053` stay owned by ingress/api/registry/egress; a clash prints the `appliance local stop` hint.
