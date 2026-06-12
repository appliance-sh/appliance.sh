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

/// Build the apkovl (Alpine "local backup" overlay tarball): openrc
/// runlevel wiring, networking config, the world file driving package
/// installs at boot, and the appliance.start bootstrap.
fn build_apkovl(registry_host_port: u16, egress_ca_pem: Option<&str>) -> Result<Vec<u8>> {
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
    file(
        "etc/apk/world",
        0o644,
        b"alpine-base\ne2fsprogs\nca-certificates\nbusybox-extras\n",
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
            .as_bytes(),
    )?;

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
pub fn build_boot_media(vm_dir: &Path, registry_host_port: u16) -> Result<BootMedia> {
    let (modloop, k3s) = ensure_assets()?;
    // Generate (once) and bake the per-VM egress CA into the overlay so
    // the guest's system trust store includes it. Best-effort: a CA
    // failure must not block boot media assembly.
    let egress_ca_pem: Option<String> = vm_dir
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|name| crate::mitm::ensure_ca(name).is_ok())
        .and_then(|name| fs::read_to_string(crate::mitm::ca_cert_path(name)).ok());
    let apkovl = build_apkovl(registry_host_port, egress_ca_pem.as_deref())?;

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

    #[test]
    fn apkovl_embeds_egress_ca_when_provided() {
        let pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
        let ovl = build_apkovl(5052, Some(pem)).unwrap();
        let paths = apkovl_paths(&ovl);
        assert!(paths.iter().any(|p| p == "usr/local/share/ca-certificates/appliance-egress.crt"));
        // And the bootstrap trusts it node-wide.
        assert!(APPLIANCE_START.contains("update-ca-certificates"));
        assert!(APPLIANCE_START.contains("appliance-egress.crt"));
    }

    #[test]
    fn apkovl_omits_egress_ca_when_absent() {
        let ovl = build_apkovl(5052, None).unwrap();
        let paths = apkovl_paths(&ovl);
        assert!(!paths.iter().any(|p| p.contains("appliance-egress.crt")));
    }

    #[test]
    fn apkovl_ca_pem_round_trips() {
        let pem = "-----BEGIN CERTIFICATE-----\nROUNDTRIP\n-----END CERTIFICATE-----\n";
        let ovl = build_apkovl(5052, Some(pem)).unwrap();
        let gz = flate2::read::GzDecoder::new(&ovl[..]);
        let mut ar = tar::Archive::new(gz);
        let mut got = None;
        for entry in ar.entries().unwrap() {
            let mut entry = entry.unwrap();
            if entry.path().unwrap().to_string_lossy() == "usr/local/share/ca-certificates/appliance-egress.crt" {
                let mut s = String::new();
                entry.read_to_string(&mut s).unwrap();
                got = Some(s);
            }
        }
        assert_eq!(got.as_deref(), Some(pem));
    }
}
