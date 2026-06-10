use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Persisted definition of one microVM. Lives at
/// `~/.appliance/vmm/<name>/vm.json`; everything else in that
/// directory (disk image, console log, pidfile) is derived state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VmSpec {
    pub name: String,
    /// Virtual CPUs.
    pub cpus: usize,
    /// Memory in MiB.
    pub memory_mib: u64,
    /// Data disk size in GiB (sparse raw image, created on `create`).
    pub disk_gib: u64,
    /// Guest image set (pinned kernel + initramfs pair) this VM boots.
    pub image: String,
    /// Kernel command line.
    pub cmdline: String,
}

impl VmSpec {
    pub fn defaults(name: &str) -> Self {
        Self {
            name: name.to_string(),
            cpus: 2,
            memory_mib: 2048,
            disk_gib: 10,
            image: crate::images::DEFAULT_IMAGE.to_string(),
            // hvc0 is the virtio console the vz/kvm backends attach the
            // log file to. `quiet` is deliberately absent — boot logs are
            // the primary debugging surface for a headless VM.
            cmdline: "console=hvc0".to_string(),
        }
    }
}

/// Where a VM keeps its state on the host.
#[derive(Debug, Clone)]
pub struct VmPaths {
    pub dir: PathBuf,
}

impl VmPaths {
    pub fn for_name(name: &str) -> Self {
        Self {
            dir: crate::store::vmm_root().join(name),
        }
    }
    pub fn spec(&self) -> PathBuf {
        self.dir.join("vm.json")
    }
    pub fn disk(&self) -> PathBuf {
        self.dir.join("data.img")
    }
    pub fn console_log(&self) -> PathBuf {
        self.dir.join("console.log")
    }
    pub fn pidfile(&self) -> PathBuf {
        self.dir.join("vmm.pid")
    }
}

/// Runtime status reported by `status`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VmStatus {
    pub name: String,
    pub exists: bool,
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<i32>,
    pub backend: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}
