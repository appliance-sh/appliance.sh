//! Egress traffic recording.
//!
//! The proxy appends one JSON line per request decision to a bounded
//! log under the VM's state dir. The desktop reads the tail to show a
//! live traffic view — like Docker Desktop's network panel — where
//! each host can be allowed or blocked. Recording is best-effort: a
//! logging failure must never affect proxying.

use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::spec::VmPaths;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrafficEvent {
    /// Unix epoch milliseconds.
    pub ts: u64,
    pub host: String,
    pub port: u16,
    /// HTTP method (CONNECT for the tunnel open, or the real verb when
    /// the request is intercepted / plain HTTP).
    pub method: String,
    /// Request path — present for intercepted (decrypted) HTTPS and
    /// plain HTTP; absent for blind CONNECT tunnels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// `allow` (blind tunnel / forwarded), `deny` (refused by policy),
    /// or `mitm` (allowed + TLS-intercepted).
    pub decision: String,
}

fn events_path(name: &str) -> PathBuf {
    VmPaths::for_name(name).dir.join("egress-events.jsonl")
}

/// Keep the log bounded: when it grows past this, the oldest half is
/// dropped on the next write. Generous enough for an interactive
/// session's worth of traffic.
const MAX_EVENTS_BYTES: u64 = 512 * 1024;

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Append a decision to the VM's traffic log (best-effort).
pub fn record(name: &str, host: &str, port: u16, method: &str, path: Option<&str>, decision: &str) {
    let ev = TrafficEvent {
        ts: now_millis(),
        host: host.to_string(),
        port,
        method: method.to_string(),
        path: path.map(|p| p.to_string()),
        decision: decision.to_string(),
    };
    let path_buf = events_path(name);
    if let Ok(meta) = std::fs::metadata(&path_buf) {
        if meta.len() > MAX_EVENTS_BYTES {
            trim(&path_buf);
        }
    }
    let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path_buf) else {
        return;
    };
    if let Ok(line) = serde_json::to_string(&ev) {
        let _ = writeln!(file, "{line}");
    }
}

/// Drop the oldest half of the log, keeping the most recent lines.
fn trim(path: &std::path::Path) {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return;
    };
    let lines: Vec<&str> = raw.lines().collect();
    let keep = &lines[lines.len() / 2..];
    let _ = std::fs::write(path, format!("{}\n", keep.join("\n")));
}

/// Return the most recent `limit` events, oldest-first.
pub fn tail(name: &str, limit: usize) -> Vec<TrafficEvent> {
    let Ok(raw) = std::fs::read_to_string(events_path(name)) else {
        return Vec::new();
    };
    let mut events: Vec<TrafficEvent> = raw
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    if events.len() > limit {
        events.drain(0..events.len() - limit);
    }
    events
}

/// Forget all recorded traffic for a VM.
pub fn clear(name: &str) {
    let _ = std::fs::remove_file(events_path(name));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_limits_and_parses() {
        let name = "traffic-test-unit";
        clear(name);
        // Ensure the dir exists.
        let _ = std::fs::create_dir_all(VmPaths::for_name(name).dir);
        for i in 0..5 {
            record(name, &format!("h{i}.test"), 443, "CONNECT", None, "allow");
        }
        let last3 = tail(name, 3);
        assert_eq!(last3.len(), 3);
        assert_eq!(last3[0].host, "h2.test");
        assert_eq!(last3[2].host, "h4.test");
        assert_eq!(last3[2].decision, "allow");
        clear(name);
    }

    #[test]
    fn records_path_for_intercepted() {
        let name = "traffic-test-path";
        clear(name);
        let _ = std::fs::create_dir_all(VmPaths::for_name(name).dir);
        record(name, "api.example.com", 443, "GET", Some("/v1/models"), "mitm");
        let evs = tail(name, 10);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].path.as_deref(), Some("/v1/models"));
        assert_eq!(evs[0].decision, "mitm");
        clear(name);
    }
}
