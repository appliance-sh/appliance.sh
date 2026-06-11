use anyhow::{bail, Context, Result};
use std::fs;
use std::path::{Path, PathBuf};

/// Pinned guest image sets. An image set is a (kernel, initramfs) pair
/// booted directly — no firmware, no bootloader, no disk image to
/// download. Pinning by exact version keeps guest behavior reproducible;
/// bumping the pin is a deliberate code change, not a moving `latest`.
///
/// Phase 1 boots the stock Alpine `virt` netboot artifacts, which is
/// enough to prove the VMM end-to-end (kernel boot → init → console).
/// Phase 2 replaces the initramfs with our own (busybox + appliance
/// init: DHCP, mount data disk, exec k3s, vsock agent).
pub const DEFAULT_IMAGE: &str = "alpine-3.21.3";

struct ImageDef {
    name: &'static str,
    kernel_url_aarch64: &'static str,
    initramfs_url_aarch64: &'static str,
    kernel_url_x86_64: &'static str,
    initramfs_url_x86_64: &'static str,
}

const IMAGES: &[ImageDef] = &[ImageDef {
    name: "alpine-3.21.3",
    kernel_url_aarch64:
        "https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/aarch64/netboot-3.21.3/vmlinuz-virt",
    initramfs_url_aarch64:
        "https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/aarch64/netboot-3.21.3/initramfs-virt",
    kernel_url_x86_64:
        "https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/x86_64/netboot-3.21.3/vmlinuz-virt",
    initramfs_url_x86_64:
        "https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/x86_64/netboot-3.21.3/initramfs-virt",
}];

pub struct GuestImage {
    pub kernel: PathBuf,
    pub initramfs: PathBuf,
}

fn cache_dir(image: &str) -> PathBuf {
    crate::store::vm_root().join("images").join(image)
}

/// Resolve (downloading on first use) the kernel + initramfs for an
/// image set. Downloads are atomic: stream to `.partial`, rename into
/// place — a killed download never leaves a truncated file at the
/// canonical name.
pub fn ensure_image(image: &str) -> Result<GuestImage> {
    let def = IMAGES
        .iter()
        .find(|d| d.name == image)
        .with_context(|| format!("unknown guest image '{image}' (known: {DEFAULT_IMAGE})"))?;

    let (kernel_url, initramfs_url) = match std::env::consts::ARCH {
        "aarch64" => (def.kernel_url_aarch64, def.initramfs_url_aarch64),
        "x86_64" => (def.kernel_url_x86_64, def.initramfs_url_x86_64),
        other => bail!("unsupported host architecture: {other}"),
    };

    let dir = cache_dir(image);
    fs::create_dir_all(&dir)?;
    let kernel = dir.join("kernel");
    let initramfs = dir.join("initramfs");
    download_once(kernel_url, &kernel)?;
    download_once(initramfs_url, &initramfs)?;
    normalize_kernel(&kernel)?;
    Ok(GuestImage { kernel, initramfs })
}

/// Unwrap distro kernel packaging into the raw image the hypervisor
/// boot loaders expect. Two cases:
///
///   * EFI zboot (arm64, kernel ≥ 6.x distros): a PE stub whose
///     header is `MZ..zimg` with a gzip payload at a header-declared
///     offset. Virtualization.framework's VZLinuxBootLoader (and a
///     direct-boot KVM VMM) need the *decompressed* arm64 `Image`
///     inside.
///   * Plain gzip (`1f 8b`): decompress in place (arm64 direct boot
///     takes uncompressed images; x86 bzImage is not gzip at the file
///     level and passes through untouched).
///
/// Idempotent — a normalized image matches neither signature.
fn normalize_kernel(path: &PathBuf) -> Result<()> {
    let data = fs::read(path)?;

    let gzip_payload: Option<Vec<u8>> = if data.len() > 0x1c && &data[4..8] == b"zimg" {
        let off = u32::from_le_bytes(data[8..12].try_into().unwrap()) as usize;
        let len = u32::from_le_bytes(data[12..16].try_into().unwrap()) as usize;
        if &data[0x18..0x1c] != b"gzip" {
            bail!("zboot kernel uses unsupported compression (only gzip handled)");
        }
        if off + len > data.len() {
            bail!("zboot payload out of bounds (corrupt kernel download?)");
        }
        Some(data[off..off + len].to_vec())
    } else if data.len() > 2 && data[0] == 0x1f && data[1] == 0x8b {
        Some(data)
    } else {
        None
    };

    let Some(compressed) = gzip_payload else {
        return Ok(());
    };

    eprintln!("unwrapping compressed kernel image");
    let mut decoder = flate2::read::GzDecoder::new(&compressed[..]);
    let mut out: Vec<u8> = Vec::new();
    std::io::Read::read_to_end(&mut decoder, &mut out).context("decompress kernel")?;
    let partial = path.with_extension("partial");
    fs::write(&partial, &out)?;
    fs::rename(&partial, path)?;
    Ok(())
}

fn download_once(url: &str, dest: &Path) -> Result<()> {
    download_to(url, dest)
}

/// Download a URL to a path, once (no-op when the file already
/// exists). Atomic: stream to `.partial`, rename into place.
pub fn download_to(url: &str, dest: &Path) -> Result<()> {
    if dest.exists() {
        return Ok(());
    }
    eprintln!("downloading {url}");
    let partial = dest.with_extension("partial");
    let response = ureq::get(url).call().with_context(|| format!("GET {url}"))?;
    let mut reader = response.into_reader();
    let mut file = fs::File::create(&partial)?;
    std::io::copy(&mut reader, &mut file).with_context(|| format!("download {url}"))?;
    let len = file.metadata()?.len();
    if len == 0 {
        let _ = fs::remove_file(&partial);
        bail!("downloaded 0 bytes from {url}");
    }
    fs::rename(&partial, dest)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn gz(data: &[u8]) -> Vec<u8> {
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(data).unwrap();
        enc.finish().unwrap()
    }

    fn write_temp(name: &str, data: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!("vmm-kernel-test-{}-{name}", std::process::id()));
        fs::write(&path, data).unwrap();
        path
    }

    #[test]
    fn unwraps_zboot_kernels() {
        // Synthetic zboot: MZ + zimg magic, payload offset/len header,
        // gzip method, padding, then the gzip payload.
        let payload = b"raw arm64 Image bytes".to_vec();
        let compressed = gz(&payload);
        let off: u32 = 0x40;
        let mut file = Vec::new();
        file.extend_from_slice(b"MZ\0\0zimg");
        file.extend_from_slice(&off.to_le_bytes());
        file.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        file.extend_from_slice(&[0u8; 8]); // reserved
        file.extend_from_slice(b"gzip\0\0\0\0");
        while file.len() < off as usize {
            file.push(0);
        }
        file.extend_from_slice(&compressed);

        let path = write_temp("zboot", &file);
        normalize_kernel(&path).unwrap();
        assert_eq!(fs::read(&path).unwrap(), payload);
        fs::remove_file(&path).ok();
    }

    #[test]
    fn unwraps_plain_gzip_kernels() {
        let payload = b"plain image".to_vec();
        let path = write_temp("gzip", &gz(&payload));
        normalize_kernel(&path).unwrap();
        assert_eq!(fs::read(&path).unwrap(), payload);
        fs::remove_file(&path).ok();
    }

    #[test]
    fn passes_raw_kernels_through() {
        let payload = b"\x4d\x5a__not_zimg_raw_kernel".to_vec();
        let path = write_temp("raw", &payload);
        normalize_kernel(&path).unwrap();
        assert_eq!(fs::read(&path).unwrap(), payload);
        fs::remove_file(&path).ok();
    }
}
