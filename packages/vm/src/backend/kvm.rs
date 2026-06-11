use super::VmBackend;
use crate::spec::VmSpec;
use anyhow::{bail, Result};

/// Linux KVM backend — scaffold. Target shape is an embedded
/// rust-vmm based VMM (virtio-mmio devices matching the guest
/// contract: console, net, blk, vsock) speaking directly to /dev/kvm.
/// Until that lands the backend reports itself unavailable with a
/// pointer at the k3d path, so the CLI surface is already stable on
/// Linux.
pub struct KvmBackend;

impl VmBackend for KvmBackend {
    fn name(&self) -> &'static str {
        "kvm"
    }

    fn availability(&self) -> Result<()> {
        if !std::path::Path::new("/dev/kvm").exists() {
            bail!("/dev/kvm not present — KVM is unavailable on this machine");
        }
        bail!("the KVM backend is not implemented yet — use `appliance local up` (k3d) on Linux for now");
    }

    fn run_foreground(&self, _spec: &VmSpec) -> Result<()> {
        self.availability()
    }
}
