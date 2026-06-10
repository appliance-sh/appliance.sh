use crate::spec::{VmPaths, VmSpec};
use anyhow::{Context, Result};
use std::fs;
use std::path::PathBuf;

/// Root for all VMM state: VM definitions, disks, cached guest images.
/// Sits under the same `~/.appliance` umbrella as credentials and the
/// helper-managed binaries so `rm -rf ~/.appliance` remains the one
/// true uninstall.
pub fn vmm_root() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".appliance").join("vmm")
}

pub fn save_spec(spec: &VmSpec) -> Result<()> {
    let paths = VmPaths::for_name(&spec.name);
    fs::create_dir_all(&paths.dir).with_context(|| format!("create {}", paths.dir.display()))?;
    let json = serde_json::to_string_pretty(spec)?;
    fs::write(paths.spec(), json).with_context(|| format!("write {}", paths.spec().display()))?;
    Ok(())
}

pub fn load_spec(name: &str) -> Result<Option<VmSpec>> {
    let paths = VmPaths::for_name(name);
    let path = paths.spec();
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let spec = serde_json::from_str(&raw).with_context(|| format!("parse {}", path.display()))?;
    Ok(Some(spec))
}

pub fn delete_vm_dir(name: &str) -> Result<()> {
    let paths = VmPaths::for_name(name);
    if paths.dir.exists() {
        fs::remove_dir_all(&paths.dir).with_context(|| format!("remove {}", paths.dir.display()))?;
    }
    Ok(())
}

/// Create the sparse raw data disk if it doesn't exist yet. Sparse so a
/// 10 GiB disk costs nothing until the guest writes to it.
pub fn ensure_disk(spec: &VmSpec) -> Result<PathBuf> {
    let paths = VmPaths::for_name(&spec.name);
    let disk = paths.disk();
    if !disk.exists() {
        fs::create_dir_all(&paths.dir)?;
        let file = fs::File::create(&disk).with_context(|| format!("create {}", disk.display()))?;
        file.set_len(spec.disk_gib * 1024 * 1024 * 1024)
            .context("size data disk")?;
    }
    Ok(disk)
}

/// Read a pidfile and check whether that process is still alive.
pub fn read_live_pid(name: &str) -> Option<i32> {
    let paths = VmPaths::for_name(name);
    let raw = fs::read_to_string(paths.pidfile()).ok()?;
    let pid: i32 = raw.trim().parse().ok()?;
    // kill(pid, 0) probes liveness without sending a signal.
    let alive = unsafe { libc::kill(pid, 0) } == 0;
    if alive {
        Some(pid)
    } else {
        None
    }
}

pub fn write_pidfile(name: &str) -> Result<()> {
    let paths = VmPaths::for_name(name);
    fs::create_dir_all(&paths.dir)?;
    fs::write(paths.pidfile(), std::process::id().to_string())?;
    Ok(())
}

pub fn clear_pidfile(name: &str) {
    let paths = VmPaths::for_name(name);
    let _ = fs::remove_file(paths.pidfile());
}
