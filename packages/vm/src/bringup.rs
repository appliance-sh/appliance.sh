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
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

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
    /// the registry/traefik images, which is the slow part. The honest
    /// sub-phases below slice this window open; `Cluster` itself is still
    /// published first so older UIs (which ignore unknown phases) keep
    /// advancing their ladder.
    Cluster,
    /// Guest base system is up: persistent disk mounted, packages
    /// installed, the bring-up progress handoff answering.
    ClusterNode,
    /// Platform images staged for k3s's airgap import (the alternative
    /// to pulling ~300 MB from docker.io on first boot).
    ClusterImages,
    /// k3s API up — the kubeconfig is written and served.
    ClusterApi,
    /// Wiring the last mile: the in-VM registry and the api-server's
    /// traefik route must answer before `Ready` is honest.
    Ingress,
    /// Agent-only VMs: preparing the agent runtime (the Node toolchain +
    /// the vsock shell). Replaces `Cluster` when the spec is agent-only —
    /// there is no k3s control plane to wait on, just the runtime an agent
    /// actually rides.
    Agent,
    /// The platform actually answers: kubeconfig fetched, registry and
    /// (when staged) api-server ingress reachable. Terminal success.
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
            Phase::ClusterNode => "guest base system up, starting k3s",
            Phase::ClusterImages => "platform images staged for import",
            Phase::ClusterApi => "kubernetes api up",
            Phase::Ingress => "waiting for the registry + ingress routes",
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

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn path(vm_dir: &Path) -> PathBuf {
    vm_dir.join("bringup.json")
}

fn history_path(vm_dir: &Path) -> PathBuf {
    vm_dir.join("bringup-history.jsonl")
}

/// One bring-up transition, appended to `bringup-history.jsonl` on every
/// `set`. `bringup.json` keeps only the CURRENT phase (its consumers —
/// `up`, `status`, the desktop — want the live state); the history file
/// is what makes a finished boot measurable after the fact
/// (`appliance-vm timings`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub phase: Phase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Unix milliseconds when this phase was entered. Millis, not the
    /// seconds `Bringup.since` uses — sub-second phases (media on a warm
    /// cache, booting) would all read 0s otherwise.
    pub at: u64,
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
    let entry = HistoryEntry {
        phase: state.phase,
        detail: state.detail,
        at: now_millis(),
    };
    if let Ok(line) = serde_json::to_string(&entry) {
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(history_path(vm_dir))
        {
            let _ = writeln!(f, "{line}");
        }
    }
}

/// Read the boot's transition history, oldest first. Empty when the VM
/// has never booted under a history-writing engine (or was cleared).
/// Unparseable lines are skipped, not fatal — the file is best-effort
/// telemetry, never load-bearing state.
pub fn read_history(vm_dir: &Path) -> Vec<HistoryEntry> {
    let Ok(raw) = std::fs::read_to_string(history_path(vm_dir)) else {
        return Vec::new();
    };
    raw.lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/// Render per-phase deltas (time spent IN each phase, i.e. until the
/// next transition) plus the boot total. Pure so `timings` is testable
/// without a live boot.
pub fn render_timings(entries: &[HistoryEntry]) -> String {
    fn secs(ms: u64) -> String {
        format!("{:.1}s", ms as f64 / 1000.0)
    }
    let mut out = String::new();
    for (i, e) in entries.iter().enumerate() {
        let wire = serde_json::to_string(&e.phase)
            .map(|s| s.trim_matches('"').to_string())
            .unwrap_or_default();
        let delta = entries
            .get(i + 1)
            .map(|next| secs(next.at.saturating_sub(e.at)))
            .unwrap_or_else(|| "—".to_string());
        let detail = e.detail.as_deref().map(|d| format!("  ({d})")).unwrap_or_default();
        out.push_str(&format!("{wire:<16} {delta:>8}  {}{detail}\n", e.phase.label()));
    }
    if let (Some(first), Some(last)) = (entries.first(), entries.last()) {
        out.push_str(&format!(
            "{:<16} {:>8}\n",
            "total",
            secs(last.at.saturating_sub(first.at))
        ));
    }
    out
}

// --- timestamped host-side logging -----------------------------------
// host.log is created fresh per boot, so an elapsed-since-start prefix
// is exactly the delta a "where did the time go" read cares about (and
// needs no date formatting the crate doesn't otherwise carry).

static HOST_CLOCK: OnceLock<Instant> = OnceLock::new();

/// Pin the process-wide bring-up clock. Called at the top of the
/// resident host process (`run`) so every `hostlog` line shares one
/// epoch; a missed init just makes the first log line the epoch.
pub fn init_host_clock() {
    let _ = HOST_CLOCK.get_or_init(Instant::now);
}

fn fmt_elapsed(secs: f64) -> String {
    format!("[+{secs:.1}s]")
}

/// A host-side bring-up log line, prefixed with seconds since the host
/// process started.
pub fn hostlog(msg: &str) {
    let elapsed = HOST_CLOCK.get_or_init(Instant::now).elapsed().as_secs_f64();
    eprintln!("{} {msg}", fmt_elapsed(elapsed));
}

/// Read the last published phase, if any.
pub fn read(vm_dir: &Path) -> Option<Bringup> {
    let raw = std::fs::read_to_string(path(vm_dir)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Clear any prior bring-up state. Call before a fresh boot so the
/// poller never reads a stale phase from the previous run — and so the
/// history (and therefore `timings`) always describes ONE boot.
pub fn clear(vm_dir: &Path) {
    let _ = std::fs::remove_file(path(vm_dir));
    let _ = std::fs::remove_file(history_path(vm_dir));
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
    fn history_appends_every_transition() {
        let dir = std::env::temp_dir().join(format!("bringup-history-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        clear(&dir);

        assert!(read_history(&dir).is_empty(), "no history before the first set");

        set(&dir, Phase::Media, None);
        set(&dir, Phase::Booting, None);
        set(&dir, Phase::Network, Some("10.0.0.5".into()));
        set(&dir, Phase::Ready, None);

        // bringup.json still holds ONLY the current phase (compat).
        assert_eq!(read(&dir).unwrap().phase, Phase::Ready);

        // The history holds every transition, in order, timestamped.
        let history = read_history(&dir);
        assert_eq!(history.len(), 4);
        assert_eq!(history[0].phase, Phase::Media);
        assert_eq!(history[2].phase, Phase::Network);
        assert_eq!(history[2].detail.as_deref(), Some("10.0.0.5"));
        assert_eq!(history[3].phase, Phase::Ready);
        assert!(
            history.windows(2).all(|w| w[0].at <= w[1].at),
            "timestamps must be monotonic"
        );

        // clear removes the history too — timings always describe one boot.
        clear(&dir);
        assert!(read_history(&dir).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn timings_render_per_phase_deltas_and_a_total() {
        let entries = vec![
            HistoryEntry { phase: Phase::Media, detail: None, at: 1_000 },
            HistoryEntry { phase: Phase::Booting, detail: None, at: 3_500 },
            HistoryEntry { phase: Phase::Network, detail: Some("192.168.64.7".into()), at: 4_000 },
            HistoryEntry { phase: Phase::Cluster, detail: None, at: 4_200 },
            HistoryEntry { phase: Phase::Ready, detail: None, at: 64_200 },
        ];
        let out = render_timings(&entries);
        // Per-phase deltas: time spent IN each phase until the next.
        assert!(out.contains("media") && out.contains("2.5s"), "{out}");
        assert!(out.contains("booting") && out.contains("0.5s"), "{out}");
        assert!(out.contains("cluster") && out.contains("60.0s"), "{out}");
        // The terminal phase has no successor — rendered as a dash.
        assert!(out.contains('—'), "{out}");
        // The detail rides along.
        assert!(out.contains("(192.168.64.7)"), "{out}");
        // And the boot total closes the report.
        assert!(out.contains("total") && out.contains("63.2s"), "{out}");
    }

    #[test]
    fn timings_render_is_empty_for_no_history() {
        assert_eq!(render_timings(&[]), "");
    }

    #[test]
    fn elapsed_prefix_is_stable() {
        assert_eq!(fmt_elapsed(0.0), "[+0.0s]");
        assert_eq!(fmt_elapsed(12.34), "[+12.3s]");
        assert_eq!(fmt_elapsed(365.06), "[+365.1s]");
    }

    #[test]
    fn phase_serializes_kebab_case_for_the_ui() {
        // The desktop reads these strings off `status` — pin the wire form.
        assert_eq!(serde_json::to_string(&Phase::Cluster).unwrap(), "\"cluster\"");
        assert_eq!(serde_json::to_string(&Phase::ClusterNode).unwrap(), "\"cluster-node\"");
        assert_eq!(serde_json::to_string(&Phase::ClusterImages).unwrap(), "\"cluster-images\"");
        assert_eq!(serde_json::to_string(&Phase::ClusterApi).unwrap(), "\"cluster-api\"");
        assert_eq!(serde_json::to_string(&Phase::Ingress).unwrap(), "\"ingress\"");
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
            Phase::ClusterNode,
            Phase::ClusterImages,
            Phase::ClusterApi,
            Phase::Ingress,
            Phase::Agent,
            Phase::Ready,
            Phase::Failed,
        ] {
            assert!(!p.label().is_empty());
        }
    }
}
