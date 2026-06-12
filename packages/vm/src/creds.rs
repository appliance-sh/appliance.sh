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

use std::path::PathBuf;

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
/// captured (for logging) when it stored something.
pub fn capture_from_head(name: &str, host: &str, head: &str) -> Option<String> {
    let cfg = load_config(name);
    let rule = first_matching(&cfg, host, |r| r.capture)?;
    let value = header_value(head, &rule.header)?;
    if value.is_empty() {
        return None;
    }
    let _ = store_secret(name, host, &rule.header, &value);
    Some(rule.header.clone())
}

/// Resolve the credential to inject for a host, if an inject rule
/// matches: the helper's stdout (preferred) or the stored secret.
/// Returns `(header, value)`.
pub fn injection_for(name: &str, host: &str) -> Option<(String, String)> {
    let cfg = load_config(name);
    let rule = first_matching(&cfg, host, |r| r.inject)?;
    let value = match &rule.helper {
        Some(cmd) => run_helper(cmd)?,
        None => get_secret(name, host, &rule.header)?,
    };
    (!value.trim().is_empty()).then(|| (rule.header.clone(), value.trim().to_string()))
}

/// Run an apiKeyHelper command; stdout (trimmed) is the credential.
fn run_helper(cmd: &str) -> Option<String> {
    let out = std::process::Command::new("sh").arg("-c").arg(cmd).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
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
        assert_eq!(capture_from_head(name, "api.example.com", head).as_deref(), Some("authorization"));
        let inj = injection_for(name, "api.example.com").unwrap();
        assert_eq!(inj.0, "authorization");
        assert_eq!(inj.1, "Bearer secret-xyz");
        // Subdomain still matches the suffix rule.
        assert!(injection_for(name, "other.test").is_none());
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
        let inj = injection_for(name, "h.test").unwrap();
        assert_eq!(inj.1, "Bearer from-helper");
        let _ = remove_rule(name, "h.test");
    }
}
