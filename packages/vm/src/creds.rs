//! Credential capture + injection for intercepted egress.
//!
//! With TLS interception on, the proxy sees decrypted request headers.
//! Per host, the operator can opt into:
//!   * capture — when a workload sends a credential header, lift it
//!     into a host-side secret store (outside the VM) so it isn't only
//!     living inside the guest, and
//!   * inject — add/replace that header on outbound requests to the
//!     host, sourcing the value from the stored secret or from an
//!     `apiKeyHelper` command (Claude-Code style) the host configures.
//!
//! Config + secrets live under the VM state dir on the host — the
//! guest can't read them. Secrets are written 0600.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::egress::host_matches;
use crate::spec::VmPaths;

fn default_header() -> String {
    "authorization".to_string()
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CredentialRule {
    /// Host suffix this rule applies to (e.g. `api.openai.com`).
    pub host: String,
    /// Lift the credential header off requests into the secret store.
    #[serde(default)]
    pub capture: bool,
    /// Add/replace the credential header on outbound requests.
    #[serde(default)]
    pub inject: bool,
    /// Header to capture/inject (lowercased; default `authorization`).
    #[serde(default = "default_header")]
    pub header: String,
    /// Optional command whose stdout is the credential to inject
    /// (overrides the stored secret). Run via `sh -c`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct CredentialConfig {
    #[serde(default)]
    pub rules: Vec<CredentialRule>,
}

fn config_path(name: &str) -> PathBuf {
    VmPaths::for_name(name).dir.join("egress-credentials.json")
}

fn secrets_path(name: &str) -> PathBuf {
    VmPaths::for_name(name).dir.join("egress-secrets.json")
}

pub fn load_config(name: &str) -> CredentialConfig {
    std::fs::read_to_string(config_path(name))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save_config(name: &str, cfg: &CredentialConfig) -> anyhow::Result<()> {
    let path = config_path(name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(cfg)?)?;
    Ok(())
}

/// Add or update (by host) a rule.
pub fn upsert_rule(name: &str, rule: CredentialRule) -> anyhow::Result<()> {
    let mut cfg = load_config(name);
    match cfg.rules.iter_mut().find(|r| r.host == rule.host) {
        Some(existing) => *existing = rule,
        None => cfg.rules.push(rule),
    }
    save_config(name, &cfg)
}

pub fn remove_rule(name: &str, host: &str) -> anyhow::Result<bool> {
    let mut cfg = load_config(name);
    let before = cfg.rules.len();
    cfg.rules.retain(|r| r.host != host);
    let removed = cfg.rules.len() != before;
    save_config(name, &cfg)?;
    Ok(removed)
}

fn first_matching<'a>(cfg: &'a CredentialConfig, host: &str, want: impl Fn(&CredentialRule) -> bool) -> Option<&'a CredentialRule> {
    cfg.rules.iter().find(|r| want(r) && host_matches(host, &r.host))
}

// --- secret store (host-side, 0600) ---------------------------------

type SecretMap = std::collections::BTreeMap<String, String>;

fn secret_key(host: &str, header: &str) -> String {
    format!("{}\t{}", host.to_ascii_lowercase(), header.to_ascii_lowercase())
}

fn load_secrets(name: &str) -> SecretMap {
    std::fs::read_to_string(secrets_path(name))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_secrets(name: &str, map: &SecretMap) -> anyhow::Result<()> {
    let path = secrets_path(name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(map)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn store_secret(name: &str, host: &str, header: &str, value: &str) -> anyhow::Result<()> {
    let mut map = load_secrets(name);
    map.insert(secret_key(host, header), value.to_string());
    save_secrets(name, &map)
}

fn get_secret(name: &str, host: &str, header: &str) -> Option<String> {
    load_secrets(name).get(&secret_key(host, header)).cloned()
}

pub fn forget_secrets(name: &str) {
    let _ = std::fs::remove_file(secrets_path(name));
}

/// Mask a secret for display: keep a short tail, redact the rest.
fn mask(value: &str) -> String {
    let v = value.trim();
    if v.len() <= 4 {
        return "••••".to_string();
    }
    format!("••••{}", &v[v.len() - 4..])
}

/// A listing of stored secrets (masked) for the desktop/CLI.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSecret {
    pub host: String,
    pub header: String,
    pub masked: String,
}

pub fn list_secrets(name: &str) -> Vec<StoredSecret> {
    load_secrets(name)
        .iter()
        .filter_map(|(k, v)| {
            let (host, header) = k.split_once('\t')?;
            Some(StoredSecret {
                host: host.to_string(),
                header: header.to_string(),
                masked: mask(v),
            })
        })
        .collect()
}

// --- capture + inject (used by the MITM path) -----------------------

/// Pull a header value out of a raw HTTP head (case-insensitive name).
fn header_value(head: &str, name: &str) -> Option<String> {
    head.lines()
        .skip(1)
        .take_while(|l| !l.is_empty())
        .filter_map(|line| line.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case(name))
        .map(|(_, v)| v.trim().to_string())
}

/// If a capture rule matches, lift the credential header off the
/// request into the secret store. Best-effort; returns the header name
/// captured (for logging) when it stored something. Takes an
/// already-loaded config so the interceptor reads it once per request.
pub fn capture_from_head(cfg: &CredentialConfig, name: &str, host: &str, head: &str) -> Option<String> {
    let rule = first_matching(cfg, host, |r| r.capture)?;
    let value = header_value(head, &rule.header)?;
    if value.is_empty() {
        return None;
    }
    let _ = store_secret(name, host, &rule.header, &value);
    Some(rule.header.clone())
}

/// Does any credential rule (capture or inject) match this host? MITM is
/// scoped to such hosts (`egress.rs`) so the proxy only decrypts the
/// traffic it must broker — every other allowed HTTPS host stays a blind
/// tunnel, preserving keep-alive + streaming. (The interceptor forces
/// one request per CONNECT, which would otherwise break SSE/npm.)
pub fn has_cred_rule(name: &str, host: &str) -> bool {
    let cfg = load_config(name);
    cfg.rules.iter().any(|r| host_matches(host, &r.host))
}

/// The outcome of resolving an inject credential for a host, computed from
/// a SINGLE config load so the proxy's fail-closed decision is atomic —
/// no TOCTOU between "is there an inject rule?" and "can it be resolved?"
/// (the config could change, or be read inconsistently, between two
/// separate loads).
pub enum Injection {
    /// An inject rule matched and resolved to `(header, value)`.
    Resolved(String, String),
    /// An inject rule matched but its credential could not be resolved
    /// (helper failed / key not configured / Keychain locked). The caller
    /// MUST fail closed: never forward the in-guest placeholder upstream.
    RuleButUnresolved,
    /// No inject rule matches this host.
    NoRule,
}

/// Resolve the credential to inject for a host from an already-loaded
/// config: the helper's stdout (preferred) or the stored secret. A single
/// pass classifies the three fail-closed-relevant states (see `Injection`)
/// so the caller never has to re-read the config to disambiguate them.
pub fn resolve_injection(cfg: &CredentialConfig, name: &str, host: &str) -> Injection {
    let Some(rule) = first_matching(cfg, host, |r| r.inject) else {
        return Injection::NoRule;
    };
    let value = match &rule.helper {
        Some(cmd) => run_helper(cmd),
        None => get_secret(name, host, &rule.header),
    };
    match value {
        Some(v) if !v.trim().is_empty() => Injection::Resolved(rule.header.clone(), v.trim().to_string()),
        _ => Injection::RuleButUnresolved,
    }
}

/// Short TTL for the resolved-helper cache. The brokered key rotates
/// rarely; a few-second cache is invisible to correctness and removes a
/// per-request `sh -c` fork of the host helper (`appliance agent
/// print-key`) on streaming/keep-alive traffic where one CONNECT carries
/// many intercepted requests.
///
/// Staleness vs rotation (accepted): after the host key is rotated, a
/// previously-resolved value lingers for at most `HELPER_TTL` before the
/// next fork picks up the new key. The old key simply 401s upstream in
/// that window — no security exposure (the key never leaves the host) —
/// so the 15s window is an accepted trade for not forking per request.
const HELPER_TTL: Duration = Duration::from_secs(15);

/// `helper command -> (resolved_at, value)`. Process-global so it spans
/// the per-connection threads the proxy spawns. Never logged.
fn helper_cache() -> &'static Mutex<HashMap<String, (Instant, String)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, String)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Run an apiKeyHelper command; stdout (trimmed) is the credential. The
/// result is cached for `HELPER_TTL` keyed on the command string so we
/// don't fork `sh -c` per intercepted request. The value is a secret —
/// it is never logged here or by callers.
fn run_helper(cmd: &str) -> Option<String> {
    {
        let cache = helper_cache().lock().unwrap_or_else(|p| p.into_inner());
        if let Some((at, value)) = cache.get(cmd) {
            if at.elapsed() < HELPER_TTL {
                return Some(value.clone());
            }
        }
    }
    let out = std::process::Command::new("sh").arg("-c").arg(cmd).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if value.is_empty() {
        return None;
    }
    let mut cache = helper_cache().lock().unwrap_or_else(|p| p.into_inner());
    cache.insert(cmd.to_string(), (Instant::now(), value.clone()));
    Some(value)
}

/// Rewrite an HTTP head to set `header: value`, replacing any existing
/// occurrence (case-insensitive) and preserving the rest verbatim.
pub fn set_header(head: &str, header: &str, value: &str) -> String {
    let mut out = String::with_capacity(head.len() + header.len() + value.len() + 4);
    let mut lines = head.split("\r\n");
    if let Some(request_line) = lines.next() {
        out.push_str(request_line);
        out.push_str("\r\n");
    }
    for line in lines {
        if line.is_empty() {
            break;
        }
        let is_target = line.split_once(':').map(|(k, _)| k.trim().eq_ignore_ascii_case(header)).unwrap_or(false);
        if is_target {
            continue; // drop; we re-add canonically below
        }
        out.push_str(line);
        out.push_str("\r\n");
    }
    out.push_str(header);
    out.push_str(": ");
    out.push_str(value);
    out.push_str("\r\n\r\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_header_replaces_existing() {
        let head = "GET / HTTP/1.1\r\nHost: x\r\nAuthorization: old\r\nAccept: */*\r\n\r\n";
        let out = set_header(head, "authorization", "Bearer new");
        assert_eq!(out.matches("uthorization").count(), 1);
        assert!(out.contains("authorization: Bearer new\r\n"));
        assert!(!out.contains("old"));
        assert!(out.contains("Host: x\r\n"));
        assert!(out.ends_with("\r\n\r\n"));
    }

    #[test]
    fn set_header_adds_when_absent() {
        let head = "GET / HTTP/1.1\r\nHost: x\r\n\r\n";
        let out = set_header(head, "x-api-key", "k123");
        assert!(out.contains("x-api-key: k123\r\n"));
    }

    #[test]
    fn header_value_is_case_insensitive() {
        let head = "POST / HTTP/1.1\r\nHost: x\r\nAuthorization:  Bearer abc \r\n\r\n";
        assert_eq!(header_value(head, "authorization").as_deref(), Some("Bearer abc"));
        assert_eq!(header_value(head, "missing"), None);
    }

    #[test]
    fn capture_and_inject_round_trip() {
        let name = "creds-test-rt";
        forget_secrets(name);
        let _ = std::fs::create_dir_all(VmPaths::for_name(name).dir);
        upsert_rule(
            name,
            CredentialRule {
                host: "api.example.com".into(),
                capture: true,
                inject: true,
                header: "authorization".into(),
                helper: None,
            },
        )
        .unwrap();
        let head = "POST /v1 HTTP/1.1\r\nHost: api.example.com\r\nAuthorization: Bearer secret-xyz\r\n\r\n";
        let cfg = load_config(name);
        assert_eq!(
            capture_from_head(&cfg, name, "api.example.com", head).as_deref(),
            Some("authorization")
        );
        let cfg = load_config(name);
        let Injection::Resolved(header, value) = resolve_injection(&cfg, name, "api.example.com") else {
            panic!("expected a resolved injection");
        };
        assert_eq!(header, "authorization");
        assert_eq!(value, "Bearer secret-xyz");
        // A host with no matching rule resolves to NoRule.
        assert!(matches!(resolve_injection(&cfg, name, "other.test"), Injection::NoRule));
        // Masking keeps only a short tail.
        let listed = list_secrets(name);
        assert_eq!(listed.len(), 1);
        assert!(listed[0].masked.ends_with("-xyz") || listed[0].masked == "••••");
        forget_secrets(name);
        let _ = remove_rule(name, "api.example.com");
    }

    #[test]
    fn helper_overrides_stored_secret() {
        let name = "creds-test-helper";
        forget_secrets(name);
        let _ = std::fs::create_dir_all(VmPaths::for_name(name).dir);
        upsert_rule(
            name,
            CredentialRule {
                host: "h.test".into(),
                capture: false,
                inject: true,
                header: "authorization".into(),
                helper: Some("printf 'Bearer from-helper'".into()),
            },
        )
        .unwrap();
        let cfg = load_config(name);
        let Injection::Resolved(_, value) = resolve_injection(&cfg, name, "h.test") else {
            panic!("expected a resolved injection");
        };
        assert_eq!(value, "Bearer from-helper");
        let _ = remove_rule(name, "h.test");
    }

    #[test]
    fn inject_rule_present_but_helper_fails_yields_no_value() {
        // Fail-closed input: an inject rule whose helper exits non-zero
        // (or empty) must resolve to NO value — the proxy then refuses
        // rather than forward the in-guest placeholder upstream.
        let name = "creds-test-failclosed";
        forget_secrets(name);
        let _ = std::fs::create_dir_all(VmPaths::for_name(name).dir);
        upsert_rule(
            name,
            CredentialRule {
                host: "api.anthropic.com".into(),
                capture: false,
                inject: true,
                header: "x-api-key".into(),
                helper: Some("exit 7".into()),
            },
        )
        .unwrap();
        // A single config load classifies the fail-closed state: the host
        // HAS an inject rule but its credential can't be resolved, so the
        // caller refuses rather than forwarding the placeholder.
        let cfg = load_config(name);
        assert!(matches!(
            resolve_injection(&cfg, name, "api.anthropic.com"),
            Injection::RuleButUnresolved
        ));
        // ...and it also has *a* cred rule (so MITM is scoped to it)...
        assert!(has_cred_rule(name, "api.anthropic.com"));
        // A host with no rule is neither intercepted nor inject-gated.
        assert!(matches!(resolve_injection(&cfg, name, "example.com"), Injection::NoRule));
        assert!(!has_cred_rule(name, "example.com"));
        let _ = remove_rule(name, "api.anthropic.com");
    }

    #[test]
    fn capture_false_never_stores_the_placeholder() {
        // The Anthropic rule is capture:false, so an in-guest placeholder
        // x-api-key must never be lifted into egress-secrets.json.
        let name = "creds-test-no-capture";
        forget_secrets(name);
        let _ = std::fs::create_dir_all(VmPaths::for_name(name).dir);
        upsert_rule(
            name,
            CredentialRule {
                host: "api.anthropic.com".into(),
                capture: false,
                inject: true,
                header: "x-api-key".into(),
                helper: Some("printf real-key".into()),
            },
        )
        .unwrap();
        let head =
            "POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nX-Api-Key: sk-ant-appliance-proxy\r\n\r\n";
        let cfg = load_config(name);
        assert!(capture_from_head(&cfg, name, "api.anthropic.com", head).is_none());
        assert!(list_secrets(name).is_empty());
        let _ = remove_rule(name, "api.anthropic.com");
    }
}
