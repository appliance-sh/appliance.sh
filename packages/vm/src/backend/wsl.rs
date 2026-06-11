use super::VmBackend;
use crate::spec::VmSpec;
use anyhow::{bail, Result};

/// Windows WSL2 backend — scaffold. WSL2 is itself a managed utility
/// VM, so this backend will not boot a kernel directly; it imports a
/// purpose-built distro tarball (`wsl --import`) and runs the same
/// guest payload (k3s + vsock-equivalent agent over stdio) inside it.
/// Same guest contract as vz/kvm, different mechanics.
pub struct WslBackend;

impl VmBackend for WslBackend {
    fn name(&self) -> &'static str {
        "wsl"
    }

    fn availability(&self) -> Result<()> {
        bail!("the WSL2 backend is not implemented yet");
    }

    fn run_foreground(&self, _spec: &VmSpec) -> Result<()> {
        self.availability()
    }
}
