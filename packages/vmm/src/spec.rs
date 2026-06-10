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
}

impl VmSpec {
    pub fn defaults(name: &str) -> Self {
        Self {
            name: name.to_string(),
            cpus: 2,
            memory_mib: 4096,
            disk_gib: 10,
            image: crate::images::DEFAULT_IMAGE.to_string(),
            // hvc0 is the virtio console the vz/kvm backends attach the
            // log file to. `quiet` is deliberately absent — boot logs are
            // the primary debugging surface for a headless VM.
            cmdline: crate::guest::guest_cmdline(),
            mac: random_mac(),
            host_port: 8081,
            api_port: 6443,
            registry_port: 5052,
        }
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
    pub fn kubeconfig(&self) -> PathBuf {
        self.dir.join("kubeconfig.yaml")
    }
    pub fn guest_ip(&self) -> PathBuf {
        self.dir.join("guest-ip")
    }
    pub fn host_log(&self) -> PathBuf {
        self.dir.join("host.log")
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

fn default_registry_port() -> u16 {
    5052
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
    fn spec_round_trips_through_json_with_defaults() {
        // Old persisted specs lack registry_port — must still parse.
        let legacy = r#"{"name":"x","cpus":2,"memoryMib":4096,"diskGib":10,"image":"alpine-3.21.3","cmdline":"console=hvc0","mac":"02:00:00:00:00:01","hostPort":8081,"apiPort":6443}"#;
        let spec: VmSpec = serde_json::from_str(legacy).unwrap();
        assert_eq!(spec.registry_port, 5052);
    }
}
