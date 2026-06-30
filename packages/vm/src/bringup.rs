//! Bring-up phase reporting for a microVM.
//!
//! Booting a microVM is a multi-stage affair and the slow stages —
//! first-boot package installs, image pulls, k3s electing itself — are
//! invisible from the host. Historically `up` printed bare dots while it
//! waited and, on timeout, dumped a raw host-log tail; a user had no way
//! to tell "still downloading" from "k3s is wedged".
//!
//! The resident host process now publishes the stage it is in to a small
//! JSON file (`bringup.json`) alongside the VM's other state. `up`
//! renders it as live progress and fails fast when a stage errors;
//! `status` exposes it so the desktop can distinguish *VM running* from
//! *cluster ready*.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// A stage in the boot → cluster-ready lifecycle, ordered by the
/// sequence a healthy boot passes through.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    /// Assembling boot media (kernel, initramfs, modloop, k3s). The first
    /// boot downloads these; later boots reuse the shared on-disk cache,
    /// so this stage is near-instant once primed.
    Media,
    /// VM launched; waiting for the guest to acquire a network address.
    Booting,
    /// Guest network is up and host port-forwards are wired. Waiting on k3s.
    Network,
    /// k3s is coming up — on first boot this installs packages and pulls
    /// the registry/traefik images, which is the slow part.
    Cluster,
    /// Agent-only VMs: preparing the agent runtime (the Node toolchain +
    /// the vsock shell). Replaces `Cluster` when the spec is agent-only —
    /// there is no k3s control plane to wait on, just the runtime an agent
    /// actually rides.
    Agent,
    /// kubeconfig fetched and the cluster answers. Terminal success.
    Ready,
    /// Bring-up failed; `detail` carries the reason. Terminal.
    Failed,
}

impl Phase {
    /// One-line, human-facing description for the `up` progress line.
    pub fn label(&self) -> &'static str {
        match self {
            Phase::Media => "preparing boot media",
            Phase::Booting => "booting guest",
            Phase::Network => "guest network up",
            Phase::Cluster => "starting k3s (first boot pulls images — can take a few minutes)",
            Phase::Agent => "preparing agent runtime (node + shell)",
            Phase::Ready => "cluster ready",
            Phase::Failed => "bring-up failed",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bringup {
    pub phase: Phase,
    /// Extra context for the current phase: the guest IP for `Network`,
    /// the error for `Failed`, etc.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Unix seconds when this phase was entered.
    pub since: u64,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn path(vm_dir: &Path) -> PathBuf {
    vm_dir.join("bringup.json")
}

/// Publish the current phase. Best-effort: a write failure must never
/// derail the boot it is only reporting on.
pub fn set(vm_dir: &Path, phase: Phase, detail: Option<String>) {
    let state = Bringup {
        phase,
        detail,
        since: now(),
    };
    if let Ok(json) = serde_json::to_string(&state) {
        let _ = std::fs::write(path(vm_dir), json);
    }
}

/// Read the last published phase, if any.
pub fn read(vm_dir: &Path) -> Option<Bringup> {
    let raw = std::fs::read_to_string(path(vm_dir)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Clear any prior bring-up state. Call before a fresh boot so the
/// poller never reads a stale phase from the previous run.
pub fn clear(vm_dir: &Path) {
    let _ = std::fs::remove_file(path(vm_dir));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_the_state_file() {
        let dir = std::env::temp_dir().join(format!("bringup-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        assert!(read(&dir).is_none(), "no file yet");

        set(&dir, Phase::Network, Some("10.0.0.5".into()));
        let b = read(&dir).expect("written");
        assert_eq!(b.phase, Phase::Network);
        assert_eq!(b.detail.as_deref(), Some("10.0.0.5"));

        // A later phase overwrites the earlier one.
        set(&dir, Phase::Ready, None);
        let b = read(&dir).expect("written");
        assert_eq!(b.phase, Phase::Ready);
        assert!(b.detail.is_none());

        clear(&dir);
        assert!(read(&dir).is_none(), "cleared");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn phase_serializes_kebab_case_for_the_ui() {
        // The desktop reads these strings off `status` — pin the wire form.
        assert_eq!(serde_json::to_string(&Phase::Cluster).unwrap(), "\"cluster\"");
        assert_eq!(serde_json::to_string(&Phase::Agent).unwrap(), "\"agent\"");
        assert_eq!(serde_json::to_string(&Phase::Ready).unwrap(), "\"ready\"");
        assert_eq!(serde_json::to_string(&Phase::Failed).unwrap(), "\"failed\"");
    }

    #[test]
    fn every_phase_has_a_nonempty_label() {
        for p in [
            Phase::Media,
            Phase::Booting,
            Phase::Network,
            Phase::Cluster,
            Phase::Agent,
            Phase::Ready,
            Phase::Failed,
        ] {
            assert!(!p.label().is_empty());
        }
    }
}
