use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Persisted definition of one microVM. Lives at
/// `~/.appliance/vm/<name>/vm.json`; everything else in that
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
    /// Fixed MAC address — how the host finds the guest's DHCP lease.
    /// Generated once at create; locally administered unicast.
    pub mac: String,
    /// Host loopback port forwarded to the guest's ingress (:80).
    /// Matches the k3d runtime's default so `*.appliance.localhost:8081`
    /// behaves identically on either engine.
    pub host_port: u16,
    /// Host loopback port forwarded to the Kubernetes API (:6443).
    pub api_port: u16,
    /// Host loopback port forwarded to the in-VM image registry.
    /// 5052 by default — deliberately clear of the k3d runtime's 5050
    /// so both engines can coexist on one machine.
    #[serde(default = "default_registry_port")]
    pub registry_port: u16,
    /// Host port the egress proxy binds for this VM (default 5053).
    #[serde(default = "default_egress_port")]
    pub egress_port: u16,
    /// When set, this VM is provisioned as a development environment:
    /// the guest bootstrap installs a dev toolchain (cached on the data
    /// disk) and creates a persistent `/persist/workspace` + home you
    /// shell into. Toggled on by `appliance vm dev up`; a plain
    /// `vm up` leaves it false, and it is never silently turned back off.
    #[serde(default)]
    pub dev: bool,
    /// Absolute host path shared into the guest over VirtioFS and
    /// mounted at `/persist/workspace` — "edit on the host, run in the
    /// VM". `None` keeps the workspace on the persistent data disk.
    /// Set by `appliance vm dev up --mount <path>`; implies `dev`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dev_mount: Option<String>,
}

/// The default VM name. The default VM keeps the canonical host ports
/// (8081/6443/5052/5053) for backward compatibility and parity with
/// the k3d runtime; additional VMs get allocated distinct blocks.
pub const DEFAULT_VM_NAME: &str = "appliance";

/// Default virtual CPU count for a fresh VM.
pub const DEFAULT_CPUS: usize = 2;
/// Default guest memory (MiB) for a fresh VM. 4 GiB comfortably runs
/// k3s plus a couple of small workloads.
pub const DEFAULT_MEMORY_MIB: u64 = 4096;
/// Default data disk size (GiB) for a fresh VM.
pub const DEFAULT_DISK_GIB: u64 = 10;
/// Floor for guest memory. Virtualization.framework rejects anything
/// below 1 MiB, and k3s won't survive far above that floor — keep a
/// usable minimum so a typo can't produce a VM that never boots.
pub const MIN_MEMORY_MIB: u64 = 512;

impl VmSpec {
    pub fn defaults(name: &str) -> Self {
        Self {
            name: name.to_string(),
            cpus: DEFAULT_CPUS,
            memory_mib: DEFAULT_MEMORY_MIB,
            disk_gib: DEFAULT_DISK_GIB,
            image: crate::images::DEFAULT_IMAGE.to_string(),
            // hvc0 is the virtio console the vz/kvm backends attach the
            // log file to. `quiet` is deliberately absent — boot logs are
            // the primary debugging surface for a headless VM.
            cmdline: crate::guest::guest_cmdline(),
            mac: random_mac(),
            host_port: 8081,
            api_port: 6443,
            registry_port: 5052,
            egress_port: 5053,
            dev: false,
            dev_mount: None,
        }
    }

    /// Resolve the four host ports for `name` so multiple VMs can run
    /// concurrently without colliding. An existing VM keeps its ports;
    /// the default VM gets the canonical block; any other new VM gets
    /// the lowest free contiguous block of four from 8100 upward
    /// (ingress, api, registry, egress).
    pub fn allocate_ports(name: &str) -> (u16, u16, u16, u16) {
        if let Ok(Some(existing)) = crate::store::load_spec(name) {
            return (existing.host_port, existing.api_port, existing.registry_port, existing.egress_port);
        }
        if name == DEFAULT_VM_NAME {
            return (8081, 6443, 5052, 5053);
        }
        let mut used: std::collections::HashSet<u16> = [8081, 6443, 5052, 5053].into_iter().collect();
        for spec in crate::store::list_specs() {
            used.extend([spec.host_port, spec.api_port, spec.registry_port, spec.egress_port]);
        }
        let mut slot: u16 = 0;
        loop {
            let base = 8100 + slot * 4;
            let block = [base, base + 1, base + 2, base + 3];
            if block.iter().all(|p| !used.contains(p)) {
                return (block[0], block[1], block[2], block[3]);
            }
            slot += 1;
        }
    }

    /// Apply optional per-VM resource overrides in place, validating
    /// them so an absurd value fails fast instead of producing a VM
    /// that can't boot. `None` leaves the existing value untouched, so
    /// re-running `up` without the flags preserves a VM's prior sizing.
    /// Returns whether anything actually changed (the caller persists
    /// only on a change to avoid needless spec rewrites).
    pub fn apply_resource_overrides(
        &mut self,
        cpus: Option<usize>,
        memory_mib: Option<u64>,
    ) -> anyhow::Result<bool> {
        let mut changed = false;
        if let Some(cpus) = cpus {
            if cpus == 0 {
                anyhow::bail!("--cpus must be at least 1");
            }
            if cpus != self.cpus {
                self.cpus = cpus;
                changed = true;
            }
        }
        if let Some(memory_mib) = memory_mib {
            if memory_mib < MIN_MEMORY_MIB {
                anyhow::bail!("--memory must be at least {MIN_MEMORY_MIB} MiB");
            }
            if memory_mib != self.memory_mib {
                self.memory_mib = memory_mib;
                changed = true;
            }
        }
        Ok(changed)
    }
}

/// Locally administered, unicast MAC (x2:…): bit 1 of the first octet
/// set (local), bit 0 clear (unicast).
fn random_mac() -> String {
    let mut bytes = [0u8; 6];
    // No external RNG dependency: hash process entropy sources.
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
        ^ (std::process::id() as u128) << 64;
    for (i, slot) in bytes.iter_mut().enumerate() {
        *slot = ((seed >> (i * 8)) & 0xff) as u8;
    }
    bytes[0] = (bytes[0] & 0xfe) | 0x02;
    format!(
        "{:02x}:{:02x}:{:02x}:{:02x}:{:02x}:{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]
    )
}

/// Where a VM keeps its state on the host.
#[derive(Debug, Clone)]
pub struct VmPaths {
    pub dir: PathBuf,
}

impl VmPaths {
    pub fn for_name(name: &str) -> Self {
        Self {
            dir: crate::store::vm_root().join(name),
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
        self.dir.join("vm.pid")
    }
    pub fn kubeconfig(&self) -> PathBuf {
        self.dir.join("kubeconfig.yaml")
    }
    pub fn guest_ip(&self) -> PathBuf {
        self.dir.join("guest-ip")
    }
    pub fn host_log(&self) -> PathBuf {
        self.dir.join("host.log")
    }
    /// Per-VM Unix socket the resident host process serves: it bridges
    /// each connection to a fresh guest vsock shell. `appliance-vm
    /// shell` connects here.
    pub fn shell_sock(&self) -> PathBuf {
        self.dir.join("shell.sock")
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
    /// Forwarded host ports (present once the VM is defined).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registry_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub egress_port: Option<u16>,
    /// Whether this VM is provisioned as a development environment.
    pub dev: bool,
}

fn default_registry_port() -> u16 {
    5052
}

fn default_egress_port() -> u16 {
    5053
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_macs_are_locally_administered_unicast() {
        let mac = random_mac();
        let first = u8::from_str_radix(&mac[0..2], 16).unwrap();
        assert_eq!(first & 0x01, 0, "must be unicast");
        assert_eq!(first & 0x02, 0x02, "must be locally administered");
        assert_eq!(mac.split(':').count(), 6);
    }

    #[test]
    fn resource_overrides_apply_validate_and_preserve() {
        let mut spec = VmSpec::defaults("x");
        // None leaves both values untouched and reports no change.
        assert!(!spec.apply_resource_overrides(None, None).unwrap());
        assert_eq!(spec.cpus, DEFAULT_CPUS);
        assert_eq!(spec.memory_mib, DEFAULT_MEMORY_MIB);

        // A real override mutates the spec and reports the change.
        assert!(spec.apply_resource_overrides(Some(4), Some(8192)).unwrap());
        assert_eq!(spec.cpus, 4);
        assert_eq!(spec.memory_mib, 8192);

        // Re-applying the same values is a no-op (no needless rewrite).
        assert!(!spec.apply_resource_overrides(Some(4), Some(8192)).unwrap());

        // Out-of-range values fail fast and don't mutate the spec.
        assert!(spec.apply_resource_overrides(Some(0), None).is_err());
        assert!(spec.apply_resource_overrides(None, Some(0)).is_err());
        assert_eq!(spec.cpus, 4);
        assert_eq!(spec.memory_mib, 8192);
    }

    #[test]
    fn spec_round_trips_through_json_with_defaults() {
        // Old persisted specs lack registry_port — must still parse.
        let legacy = r#"{"name":"x","cpus":2,"memoryMib":4096,"diskGib":10,"image":"alpine-3.21.3","cmdline":"console=hvc0","mac":"02:00:00:00:00:01","hostPort":8081,"apiPort":6443}"#;
        let spec: VmSpec = serde_json::from_str(legacy).unwrap();
        assert_eq!(spec.registry_port, 5052);
        // Old specs predate the dev flag — it must default to off.
        assert!(!spec.dev);
    }
}
