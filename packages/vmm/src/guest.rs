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
    crate::store::vmm_root().join("images").join("guest-assets")
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

# --- persistent data disk (vda) -------------------------------------
# First boot: no filesystem signature -> mkfs. ext4 is built into the
# alpine virt kernel; e2fsprogs comes from the apkovl world file.
PERSIST=/persist
mkdir -p "$PERSIST"
if ! blkid /dev/vda >/dev/null 2>&1; then
  mkfs.ext4 -q -L appliance-data /dev/vda
fi
mount -t ext4 /dev/vda "$PERSIST" || true

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
fn build_apkovl() -> Result<Vec<u8>> {
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
            .as_bytes(),
    )?;

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
pub fn build_boot_media(vm_dir: &Path) -> Result<BootMedia> {
    let (modloop, k3s) = ensure_assets()?;
    let apkovl = build_apkovl()?;

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

    crate::net::spawn_proxy(spec.api_port, SocketAddr::new(guest_ip, 6443))?;
    crate::net::spawn_proxy(spec.host_port, SocketAddr::new(guest_ip, 80))?;
    eprintln!(
        "forwarding 127.0.0.1:{} → guest:6443, 127.0.0.1:{} → guest:80",
        spec.api_port, spec.host_port
    );

    // The guest serves its kubeconfig only after k3s has written it —
    // first boot includes apk installs + image pulls, so be generous.
    let handoff = format!("http://{guest_ip}:{KUBECONFIG_PORT}/k3s.yaml");
    crate::net::wait_http(&handoff, Duration::from_secs(600))?;
    let kubeconfig = crate::net::fetch_kubeconfig(guest_ip, KUBECONFIG_PORT, spec.api_port)?;
    fs::write(vm_dir.join("kubeconfig.yaml"), kubeconfig)?;
    eprintln!("kubeconfig written to {}", vm_dir.join("kubeconfig.yaml").display());
    Ok(())
}
