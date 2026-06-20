//! Guest payload assembly: everything the microVM needs beyond the
//! kernel/initramfs pair, packed into a FAT32 boot-media disk that
//! Alpine's own diskless init consumes:
//!
//!   /boot/modloop-virt          full kernel module tree (squashfs)
//!   /appliance.apkovl.tar.gz    our config overlay (openrc wiring +
//!                               the appliance.start bootstrap script)
//!   /k3s                        pinned k3s binary (arm64/amd64)
//!
//! Boot flow: the netboot initramfs (ip=dhcp) finds the FAT volume on
//! the second virtio-blk disk, mounts the modloop from it, applies the
//! apkovl, installs the apkovl's /etc/apk/world packages from the
//! network repo, then pivots to the real root where openrc runs
//! /etc/local.d/appliance.start — which formats/mounts the persistent
//! data disk (vda) on first boot and starts k3s with its state there.
//!
//! Everything here is plain-Rust file generation: fatfs writes the
//! FAT image, tar+flate2 write the overlay. No host-side mount
//! privileges, no docker, no external tools.

use anyhow::{bail, Context, Result};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const K3S_VERSION: &str = "v1.31.4+k3s1";
const ALPINE_BRANCH: &str = "v3.21";
const ALPINE_NETBOOT: &str = "netboot-3.21.3";

/// Kubeconfig HTTP handoff port served by busybox httpd inside the
/// guest (bound to the shared-network interface; the host fetches
/// http://<guest-ip>:9991/k3s.yaml once k3s is up).
pub const KUBECONFIG_PORT: u16 = 9991;

/// NodePort the in-VM registry service binds (inside the NodePort
/// range k3s allows by default).
pub const REGISTRY_NODEPORT: u16 = 30500;

/// VirtioFS tag the host-folder share is presented under. The VZ
/// backend tags the device with this; the guest bootstrap mounts the
/// same tag at /persist/workspace. Keep both sides in sync (a guest
/// test asserts the bootstrap references this exact value).
pub const WORKSPACE_VIRTIOFS_TAG: &str = "workspace";

/// Guest vsock port the shell agent listens on. The host's resident
/// process connects to it via the VM's VZVirtioSocketDevice and bridges
/// it to a per-VM Unix socket that `appliance-vm shell` drives.
pub const SHELL_VSOCK_PORT: u32 = 1024;

pub struct BootMedia {
    pub image: PathBuf,
}

fn arch_tuple() -> Result<(&'static str, &'static str)> {
    // (alpine arch, k3s release-asset suffix)
    match std::env::consts::ARCH {
        "aarch64" => Ok(("aarch64", "k3s-arm64")),
        "x86_64" => Ok(("x86_64", "k3s")),
        other => bail!("unsupported host architecture: {other}"),
    }
}

fn assets_dir() -> PathBuf {
    crate::store::vm_root().join("images").join("guest-assets")
}

/// Download (once) the module loop + k3s binary the boot media embeds.
fn ensure_assets() -> Result<(PathBuf, PathBuf)> {
    let (alpine_arch, k3s_asset) = arch_tuple()?;
    let dir = assets_dir();
    fs::create_dir_all(&dir)?;

    let modloop = dir.join("modloop-virt");
    crate::images::download_to(
        &format!(
            "https://dl-cdn.alpinelinux.org/alpine/{ALPINE_BRANCH}/releases/{alpine_arch}/{ALPINE_NETBOOT}/modloop-virt"
        ),
        &modloop,
    )?;

    let k3s = dir.join(format!("k3s-{K3S_VERSION}"));
    crate::images::download_to(
        &format!(
            "https://github.com/k3s-io/k3s/releases/download/{}/{}",
            K3S_VERSION.replace('+', "%2B"),
            k3s_asset
        ),
        &k3s,
    )?;

    Ok((modloop, k3s))
}

/// The guest bootstrap that openrc's `local` service runs once the
/// diskless root is up. Owns: persistent disk, k3s launch, kubeconfig
/// handoff.
const APPLIANCE_START: &str = r#"#!/bin/sh
# appliance.start — guest bootstrap (runs from /etc/local.d at boot).
# Output goes to the virtio console so the host's console.log captures
# it — there's no exec channel into the guest yet, so the console is
# the only debugging surface.
exec >/dev/console 2>&1
set -x

# --- egress CA trust (node-side) ------------------------------------
# Trust the per-VM Appliance egress CA the apkovl placed, so node-side
# tooling (containerd, host curl) validates the interception proxy.
# No-op when the file is absent (CA not generated / older media).
if [ -f /usr/local/share/ca-certificates/appliance-egress.crt ]; then
  update-ca-certificates 2>/dev/null || true
fi

# --- persistent data disk (vda) -------------------------------------
# First boot: no filesystem signature -> mkfs. ext4 is built into the
# alpine virt kernel; e2fsprogs comes from the apkovl world file.
PERSIST=/persist
mkdir -p "$PERSIST"
# busybox blkid exits 0 even when it finds no signature — gate on its
# *output* instead of its status.
if [ -z "$(blkid /dev/vda 2>/dev/null)" ]; then
  mkfs.ext4 -q -L appliance-data /dev/vda
fi
if ! mount -t ext4 /dev/vda "$PERSIST"; then
  echo "WARNING: data disk mount failed — falling back to tmpfs (no persistence, limited space)"
fi

# --- vsock shell agent (appliance-vm shell) -------------------------
# A PTY login shell served per connection on a fixed vsock port. The
# host's resident process bridges a local Unix socket to this; no SSH,
# no TCP exposure, and it works before k3s is up. Runs on every VM.
if command -v socat >/dev/null 2>&1; then
  socat VSOCK-LISTEN:__SHELL_VSOCK_PORT__,reuseaddr,fork \
    EXEC:/usr/local/bin/appliance-shell-agent,pty,setsid,ctty,stderr \
    >/var/log/appliance-shell.log 2>&1 &
  echo "appliance-shell: vsock shell agent listening on port __SHELL_VSOCK_PORT__"
else
  echo "appliance-shell: socat not installed — vsock shell unavailable"
fi

# --- dev environment (appliance vm dev) ------------------------------
# Substituted with the provisioning block below for dev VMs, empty
# otherwise. Runs after /persist is mounted so the workspace, home, and
# apk cache all land on the persistent disk.
__DEV_PROVISION__
# --- k3s -------------------------------------------------------------
# The binary lives on the FAT boot media; copy to the root tmpfs so it
# runs without noexec/permission concerns.
MEDIA=$(dirname "$(find /media -maxdepth 2 -name k3s 2>/dev/null | head -1)")
if [ -z "$MEDIA" ]; then
  echo "FATAL: k3s binary not found on boot media"
  exit 1
fi
cp "$MEDIA/k3s" /usr/local/bin/k3s
chmod +x /usr/local/bin/k3s

mkdir -p "$PERSIST/k3s" /etc/rancher/k3s

# containerd pull-through: image refs pushed from the host as
# localhost:__REGISTRY_HOST_PORT__/<name> resolve to the in-VM registry's
# NodePort. Read by k3s at startup.
cat > /etc/rancher/k3s/registries.yaml <<RYAML
mirrors:
  "localhost:__REGISTRY_HOST_PORT__":
    endpoint:
      - "http://127.0.0.1:__REGISTRY_NODEPORT__"
RYAML

# In-VM image registry, installed via k3s's auto-applying manifests
# dir. Plain registry:2 on a NodePort; the host forwards
# 127.0.0.1:__REGISTRY_HOST_PORT__ here so `docker push` from the host
# lands inside the VM.
mkdir -p "$PERSIST/k3s/server/manifests"
cat > "$PERSIST/k3s/server/manifests/appliance-registry.yaml" <<RMANIFEST
apiVersion: apps/v1
kind: Deployment
metadata:
  name: appliance-registry
  namespace: kube-system
  labels:
    app.kubernetes.io/name: appliance-registry
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: appliance-registry
  template:
    metadata:
      labels:
        app.kubernetes.io/name: appliance-registry
    spec:
      containers:
      - name: registry
        image: registry:2
        ports:
        - containerPort: 5000
        volumeMounts:
        - name: data
          mountPath: /var/lib/registry
      volumes:
      - name: data
        hostPath:
          path: /persist/registry
          type: DirectoryOrCreate
---
apiVersion: v1
kind: Service
metadata:
  name: appliance-registry
  namespace: kube-system
spec:
  type: NodePort
  selector:
    app.kubernetes.io/name: appliance-registry
  ports:
  - port: 5000
    targetPort: 5000
    nodePort: __REGISTRY_NODEPORT__
RMANIFEST

# Single-node dev cluster. Traefik (bundled) terminates ingress on
# node port 80 via servicelb — the host forwards 127.0.0.1:<hostPort>
# here. The kubeconfig is world-readable on purpose: it never leaves
# the VM except over the host handoff below.
/usr/local/bin/k3s server \
  --data-dir "$PERSIST/k3s" \
  --write-kubeconfig-mode 644 \
  >/var/log/k3s.log 2>&1 &

# --- kubeconfig handoff ----------------------------------------------
# Serve the admin kubeconfig on the shared (host-only reachable) NAT
# network once k3s writes it. The host rewrites the server address to
# its forwarded localhost port.
mkdir -p /srv/handoff
(
  while [ ! -s /etc/rancher/k3s/k3s.yaml ]; do sleep 1; done
  cp /etc/rancher/k3s/k3s.yaml /srv/handoff/k3s.yaml
  httpd -f -p __KUBECONFIG_PORT__ -h /srv/handoff &
) &
"#;

/// Dev-environment provisioning, substituted into `APPLIANCE_START`
/// (the `__DEV_PROVISION__` marker) only for VMs created with
/// `appliance vm dev`. Two halves:
///
///   • synchronous + fast — persistent `/persist/workspace` + home, an
///     apk cache symlinked onto the data disk, and a login profile that
///     gives every shell a stable HOME. Ready the instant the VM boots,
///     so `vm dev shell` always lands somewhere sane.
///   • backgrounded + slow — the apk toolchain install. Diskless Alpine
///     reinstalls these into the tmpfs root every boot, but the cache on
///     /persist makes the second boot onward fast and offline. Run in
///     the background so it never delays k3s readiness (what `vm up`
///     waits on); a `.dev-ready` marker records completion for
///     `vm dev status`.
const DEV_PROVISION: &str = r#"
echo "appliance-dev: provisioning development environment"
mkdir -p /persist/workspace /persist/home /persist/apk-cache
# Persist apk's download cache on the data disk so reprovisioning each
# boot is fast and works offline once primed (the network repo is only
# hit the first time, or for packages added later).
ln -sfn /persist/apk-cache /etc/apk/cache
__DEV_MOUNT__
# Every login shell gets a stable HOME on the persistent disk; the
# `dev shell` entry cd's into the workspace itself.
mkdir -p /etc/profile.d
cat > /etc/profile.d/appliance-dev.sh <<'PROFILE'
export APPLIANCE_DEV=1
export HOME=/persist/home
export PATH="$HOME/.local/bin:$PATH"
PROFILE
# Install the toolchain in the background: first boot pulls from the
# network (slow), later boots hit the persistent cache (fast/offline).
# Backgrounded so the kubeconfig handoff — and `vm dev up` — never wait
# on apk.
(
  rm -f /persist/.dev-ready
  apk update --no-progress >/dev/null 2>&1 || true
  if apk add --no-progress \
      bash bash-completion git git-lfs curl wget vim nano less tmux htop \
      jq ripgrep tar gzip coreutils findutils grep sed gawk procps \
      openssh-client ca-certificates build-base python3 py3-pip nodejs npm; then
    echo "appliance-dev: toolchain ready"
    : > /persist/.dev-ready
  else
    echo "appliance-dev: toolchain install failed (will retry on next boot)"
  fi
) &
"#;

/// Substituted into the dev provisioning block (`__DEV_MOUNT__`) when a
/// host folder is shared in (`appliance vm dev up --mount`). Mounts the
/// VirtioFS `workspace` tag (declared by the VZ backend) over
/// /persist/workspace so host edits and in-VM work share one tree. The
/// tag literal must match `WORKSPACE_VIRTIOFS_TAG`.
const DEV_MOUNT: &str = r#"# Host folder shared in over virtiofs (appliance vm dev up --mount),
# mounted as the workspace so edits flow both ways. The data-disk
# workspace dir created above stays underneath, shadowed by the mount.
modprobe virtiofs 2>/dev/null || true
if mount -t virtiofs workspace /persist/workspace; then
  echo "appliance-dev: mounted shared host folder at /persist/workspace"
else
  echo "appliance-dev: WARNING virtiofs mount of the host folder failed"
fi"#;

/// Per-connection shell run by the vsock agent (socat EXEC target). The
/// host `appliance-vm shell` client sends an initial "rows R cols C"
/// line; we apply it as the PTY size (echo off so it isn't painted into
/// the session), then exec a login shell — landing in the dev workspace
/// when there is one. bash if the dev toolchain installed it, else sh.
const SHELL_AGENT: &str = r#"#!/bin/sh
# appliance-vm shell agent — one login shell per vsock connection.
stty -echo 2>/dev/null
IFS= read -r __SZ
[ -n "$__SZ" ] && stty $__SZ 2>/dev/null
stty echo 2>/dev/null
[ -d /persist/home ] && export HOME=/persist/home
cd /persist/workspace 2>/dev/null || cd "$HOME" 2>/dev/null || cd / || true
if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi
"#;

/// Build the apkovl (Alpine "local backup" overlay tarball): openrc
/// runlevel wiring, networking config, the world file driving package
/// installs at boot, and the appliance.start bootstrap.
fn build_apkovl(
    registry_host_port: u16,
    egress_ca_pem: Option<&str>,
    dev: bool,
    mount: bool,
) -> Result<Vec<u8>> {
    let gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut tar = tar::Builder::new(gz);

    let mut file = |path: &str, mode: u32, data: &[u8]| -> Result<()> {
        let mut header = tar::Header::new_gnu();
        header.set_size(data.len() as u64);
        header.set_mode(mode);
        header.set_mtime(0);
        header.set_cksum();
        tar.append_data(&mut header, path, data)?;
        Ok(())
    };

    file("etc/hostname", 0o644, b"appliance\n")?;
    file(
        "etc/network/interfaces",
        0o644,
        b"auto lo\niface lo inet loopback\n\nauto eth0\niface eth0 inet dhcp\n",
    )?;
    // Packages the diskless init installs from the network repo while
    // building the root. alpine-base brings openrc + busybox userland;
    // e2fsprogs provides mkfs.ext4 for the data disk; ca-certificates
    // lets containerd pull from TLS registries.
    // socat backs the vsock shell agent (appliance-vm shell); it's tiny
    // and gives every VM a k3s-independent host shell.
    file(
        "etc/apk/world",
        0o644,
        b"alpine-base\ne2fsprogs\nca-certificates\nbusybox-extras\nsocat\n",
    )?;
    file(
        "etc/apk/repositories",
        0o644,
        format!(
            "https://dl-cdn.alpinelinux.org/alpine/{ALPINE_BRANCH}/main\nhttps://dl-cdn.alpinelinux.org/alpine/{ALPINE_BRANCH}/community\n"
        )
        .as_bytes(),
    )?;
    // cgroups v2 unified hierarchy — kubelet requires it.
    file(
        "etc/rc.conf",
        0o644,
        b"rc_cgroup_mode=\"unified\"\nrc_logger=\"YES\"\n",
    )?;
    file(
        "etc/local.d/appliance.start",
        0o755,
        APPLIANCE_START
            .replace("__KUBECONFIG_PORT__", &KUBECONFIG_PORT.to_string())
            .replace("__REGISTRY_NODEPORT__", &REGISTRY_NODEPORT.to_string())
            .replace("__REGISTRY_HOST_PORT__", &registry_host_port.to_string())
            .replace("__SHELL_VSOCK_PORT__", &SHELL_VSOCK_PORT.to_string())
            .replace("__DEV_PROVISION__", if dev { DEV_PROVISION } else { "" })
            .replace("__DEV_MOUNT__", if dev && mount { DEV_MOUNT } else { "" })
            .as_bytes(),
    )?;
    // The vsock shell agent (socat EXEC target). Always present — every
    // VM gets a k3s-independent host shell.
    file("usr/local/bin/appliance-shell-agent", 0o755, SHELL_AGENT.as_bytes())?;

    // The per-VM egress CA, trusted node-wide by appliance.start's
    // update-ca-certificates step. Placed even when interception is
    // off — harmless until the proxy actually intercepts.
    if let Some(pem) = egress_ca_pem {
        file("usr/local/share/ca-certificates/appliance-egress.crt", 0o644, pem.as_bytes())?;
    }

    // openrc runlevels. Normally `lbu` captures these from a
    // setup-alpine'd system; we declare the minimal diskless set by
    // hand. Symlink targets resolve once the packages are installed.
    let mut links: Vec<(String, &str)> = Vec::new();
    for svc in ["devfs", "dmesg", "mdev", "hwdrivers", "modloop", "cgroups"] {
        links.push((format!("etc/runlevels/sysinit/{svc}"), "/etc/init.d/"));
    }
    for svc in ["modules", "sysctl", "hostname", "bootmisc", "syslog"] {
        links.push((format!("etc/runlevels/boot/{svc}"), "/etc/init.d/"));
    }
    for svc in ["networking", "local"] {
        links.push((format!("etc/runlevels/default/{svc}"), "/etc/init.d/"));
    }
    for svc in ["mount-ro", "killprocs", "savecache"] {
        links.push((format!("etc/runlevels/shutdown/{svc}"), "/etc/init.d/"));
    }
    for (path, target_dir) in links {
        let svc = path.rsplit('/').next().unwrap().to_string();
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        header.set_mode(0o777);
        header.set_mtime(0);
        header.set_cksum();
        tar.append_link(&mut header, path, format!("{target_dir}{svc}"))?;
    }

    let gz = tar.into_inner()?;
    Ok(gz.finish()?)
}

/// Assemble the FAT32 boot-media image. Rebuilt whenever inputs
/// change is overkill for now — we rebuild on every `up`/`run`; it
/// takes well under a second and guarantees the media matches the
/// code that produced it.
pub fn build_boot_media(
    vm_dir: &Path,
    registry_host_port: u16,
    dev: bool,
    mount: bool,
) -> Result<BootMedia> {
    let (modloop, k3s) = ensure_assets()?;
    // Generate (once) and bake the per-VM egress CA into the overlay so
    // the guest's system trust store includes it. Best-effort: a CA
    // failure must not block boot media assembly.
    let egress_ca_pem: Option<String> = vm_dir
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|name| crate::mitm::ensure_ca(name).is_ok())
        .and_then(|name| fs::read_to_string(crate::mitm::ca_cert_path(name)).ok());
    let apkovl = build_apkovl(registry_host_port, egress_ca_pem.as_deref(), dev, mount)?;

    let modloop_data = fs::read(&modloop)?;
    let k3s_data = fs::read(&k3s)?;

    // Size the volume to fit contents + FAT overhead, rounded up.
    let content = modloop_data.len() + k3s_data.len() + apkovl.len();
    let volume_bytes = ((content as u64 + 64 * 1024 * 1024) / (16 * 1024 * 1024) + 1) * (16 * 1024 * 1024);

    let image_path = vm_dir.join("boot-media.img");
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(&image_path)
        .with_context(|| format!("create {}", image_path.display()))?;
    file.set_len(volume_bytes)?;

    let buf = fscommon::BufStream::new(&file);
    fatfs::format_volume(
        buf,
        fatfs::FormatVolumeOptions::new().volume_label(*b"APPLIANCE  "),
    )
    .context("format FAT volume")?;

    let buf = fscommon::BufStream::new(&file);
    let fs = fatfs::FileSystem::new(buf, fatfs::FsOptions::new()).context("open FAT volume")?;
    {
        let root = fs.root_dir();
        let boot = root.create_dir("boot")?;
        let mut f = boot.create_file("modloop-virt")?;
        f.write_all(&modloop_data)?;
        let mut f = root.create_file("appliance.apkovl.tar.gz")?;
        f.write_all(&apkovl)?;
        let mut f = root.create_file("k3s")?;
        f.write_all(&k3s_data)?;
    }
    fs.unmount().context("unmount FAT volume")?;

    Ok(BootMedia { image: image_path })
}

/// Kernel command line for the k3s guest. The netboot initramfs
/// handles ip=dhcp itself (before openrc exists), pulls the base
/// system from alpine_repo, and finds modloop + apkovl on the FAT
/// media automatically once it can mount it.
pub fn guest_cmdline() -> String {
    format!(
        "console=hvc0 ip=dhcp alpine_repo=https://dl-cdn.alpinelinux.org/alpine/{ALPINE_BRANCH}/main modloop=/media/vdb/boot/modloop-virt"
    )
}

/// Guest-facing host services, run inside the resident VM host
/// process for the lifetime of the VM:
///
///   1. discover the guest's address from its DHCP lease
///   2. forward 127.0.0.1:<apiPort> → guest:6443 and
///      127.0.0.1:<hostPort> → guest:80
///   3. fetch the admin kubeconfig over the guest's handoff endpoint,
///      rewrite it to the forwarded port, persist it next to the VM
///
/// Files written (guest-ip, kubeconfig.yaml) are the contract `up`
/// polls on from the calling process.
pub fn host_services(spec: &crate::spec::VmSpec, vm_dir: &Path) -> Result<()> {
    use std::net::SocketAddr;
    use std::time::Duration;

    let guest_ip = crate::net::discover_guest_ip(&spec.mac, Duration::from_secs(120))?;
    eprintln!("guest address: {guest_ip}");
    fs::write(vm_dir.join("guest-ip"), guest_ip.to_string())?;

    // Bind failures here are almost always the other engine (k3d's
    // serverlb publishes the same 8081) — name the fix, don't let it
    // surface as a generic timeout.
    let bind_hint = |port: u16, what: &str| {
        format!(
            "cannot forward 127.0.0.1:{port} ({what}) — the port is taken. If the k3d runtime is running, stop it first (`appliance local stop`)."
        )
    };
    crate::net::spawn_proxy(spec.api_port, SocketAddr::new(guest_ip, 6443))
        .map_err(|e| anyhow::anyhow!("{}\n{e:#}", bind_hint(spec.api_port, "kubernetes api")))?;
    crate::net::spawn_proxy(spec.host_port, SocketAddr::new(guest_ip, 80))
        .map_err(|e| anyhow::anyhow!("{}\n{e:#}", bind_hint(spec.host_port, "ingress")))?;
    crate::net::spawn_proxy(spec.registry_port, SocketAddr::new(guest_ip, REGISTRY_NODEPORT))
        .map_err(|e| anyhow::anyhow!("{}\n{e:#}", bind_hint(spec.registry_port, "registry")))?;
    eprintln!(
        "forwarding 127.0.0.1:{} → guest:6443, 127.0.0.1:{} → guest:80, 127.0.0.1:{} → guest:{} (registry)",
        spec.api_port, spec.host_port, spec.registry_port, REGISTRY_NODEPORT
    );
    // The deterministic-NodePort window KubernetesDeploymentService
    // assigns from — forwarded so the "direct" URLs in deploy results
    // work exactly as they do on k3d.
    for port in 30000..=30050u16 {
        let _ = crate::net::spawn_proxy(port, SocketAddr::new(guest_ip, port));
    }

    // The guest serves its kubeconfig only after k3s has written it —
    // first boot includes apk installs + image pulls, so be generous.
    let handoff = format!("http://{guest_ip}:{KUBECONFIG_PORT}/k3s.yaml");
    crate::net::wait_http(&handoff, Duration::from_secs(600))?;
    let kubeconfig = crate::net::fetch_kubeconfig(guest_ip, KUBECONFIG_PORT, spec.api_port)?;
    fs::write(vm_dir.join("kubeconfig.yaml"), kubeconfig)?;
    eprintln!("kubeconfig written to {}", vm_dir.join("kubeconfig.yaml").display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn apkovl_paths(ovl: &[u8]) -> Vec<String> {
        let gz = flate2::read::GzDecoder::new(ovl);
        let mut ar = tar::Archive::new(gz);
        let mut paths = Vec::new();
        for entry in ar.entries().unwrap() {
            let entry = entry.unwrap();
            paths.push(entry.path().unwrap().to_string_lossy().into_owned());
        }
        paths
    }

    /// Read one file's contents out of an apkovl tarball.
    fn apkovl_file(ovl: &[u8], want: &str) -> Option<String> {
        let gz = flate2::read::GzDecoder::new(ovl);
        let mut ar = tar::Archive::new(gz);
        for entry in ar.entries().unwrap() {
            let mut entry = entry.unwrap();
            if entry.path().unwrap().to_string_lossy() == want {
                let mut s = String::new();
                entry.read_to_string(&mut s).unwrap();
                return Some(s);
            }
        }
        None
    }

    #[test]
    fn apkovl_embeds_egress_ca_when_provided() {
        let pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
        let ovl = build_apkovl(5052, Some(pem), false, false).unwrap();
        let paths = apkovl_paths(&ovl);
        assert!(paths.iter().any(|p| p == "usr/local/share/ca-certificates/appliance-egress.crt"));
        // And the bootstrap trusts it node-wide.
        assert!(APPLIANCE_START.contains("update-ca-certificates"));
        assert!(APPLIANCE_START.contains("appliance-egress.crt"));
    }

    #[test]
    fn apkovl_omits_egress_ca_when_absent() {
        let ovl = build_apkovl(5052, None, false, false).unwrap();
        let paths = apkovl_paths(&ovl);
        assert!(!paths.iter().any(|p| p.contains("appliance-egress.crt")));
    }

    #[test]
    fn apkovl_ca_pem_round_trips() {
        let pem = "-----BEGIN CERTIFICATE-----\nROUNDTRIP\n-----END CERTIFICATE-----\n";
        let ovl = build_apkovl(5052, Some(pem), false, false).unwrap();
        assert_eq!(
            apkovl_file(&ovl, "usr/local/share/ca-certificates/appliance-egress.crt").as_deref(),
            Some(pem)
        );
    }

    #[test]
    fn dev_provisioning_present_only_for_dev_vms() {
        // Non-dev: the marker is substituted to empty and no dev wiring
        // leaks into the bootstrap.
        let plain = build_apkovl(5052, None, false, false).unwrap();
        let start = apkovl_file(&plain, "etc/local.d/appliance.start").unwrap();
        assert!(!start.contains("__DEV_PROVISION__"), "marker must be substituted");
        assert!(!start.contains("/persist/workspace"));
        assert!(!start.contains("apk add"));

        // Dev: the workspace, persistent apk cache, login profile, and
        // backgrounded toolchain install are all present.
        let dev = build_apkovl(5052, None, true, false).unwrap();
        let start = apkovl_file(&dev, "etc/local.d/appliance.start").unwrap();
        assert!(!start.contains("__DEV_PROVISION__"));
        assert!(start.contains("mkdir -p /persist/workspace"));
        assert!(start.contains("ln -sfn /persist/apk-cache /etc/apk/cache"));
        assert!(start.contains("/etc/profile.d/appliance-dev.sh"));
        assert!(start.contains("apk add"));
        assert!(start.contains("/persist/.dev-ready"));
    }

    #[test]
    fn vsock_shell_agent_is_baked_into_every_vm() {
        let ovl = build_apkovl(5052, None, false, false).unwrap();
        // socat backs the agent and is in the base package set.
        let world = apkovl_file(&ovl, "etc/apk/world").unwrap();
        assert!(world.lines().any(|l| l == "socat"));
        // The bootstrap starts the agent on the shared vsock port.
        let start = apkovl_file(&ovl, "etc/local.d/appliance.start").unwrap();
        assert!(!start.contains("__SHELL_VSOCK_PORT__"), "port marker must be substituted");
        assert!(start.contains(&format!("VSOCK-LISTEN:{SHELL_VSOCK_PORT}")));
        assert!(start.contains("/usr/local/bin/appliance-shell-agent"));
        // The agent script is present and execs a login shell.
        let agent = apkovl_file(&ovl, "usr/local/bin/appliance-shell-agent").unwrap();
        assert!(agent.contains("read"));
        assert!(agent.contains("exec bash -l") || agent.contains("exec sh -l"));
    }

    #[test]
    fn virtiofs_mount_present_only_with_a_share() {
        // Both markers must always be substituted away.
        for (dev, mount) in [(false, false), (true, false), (true, true)] {
            let start =
                apkovl_file(&build_apkovl(5052, None, dev, mount).unwrap(), "etc/local.d/appliance.start").unwrap();
            assert!(!start.contains("__DEV_MOUNT__"), "marker must be substituted (dev={dev} mount={mount})");
        }

        // Dev without a share: no virtiofs mount.
        let dev_only = apkovl_file(&build_apkovl(5052, None, true, false).unwrap(), "etc/local.d/appliance.start").unwrap();
        assert!(!dev_only.contains("mount -t virtiofs"));

        // Dev + share: the bootstrap mounts the workspace tag, and the
        // tag literal matches the constant the VZ backend tags with.
        let shared = apkovl_file(&build_apkovl(5052, None, true, true).unwrap(), "etc/local.d/appliance.start").unwrap();
        assert!(shared.contains(&format!("mount -t virtiofs {WORKSPACE_VIRTIOFS_TAG} /persist/workspace")));
        assert!(DEV_MOUNT.contains(WORKSPACE_VIRTIOFS_TAG));
    }
}
