use std::fs;
use std::path::PathBuf;
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

// Keychain service is shared across all Appliance Desktop installs on
// the machine. Each cluster's API key lives at account
// `cluster:<uuid>`. The legacy single-cluster account (`api-key`) is
// migrated to the new layout on first launch and then removed.
const KEYCHAIN_SERVICE: &str = "sh.appliance.desktop";
const LEGACY_KEYCHAIN_ACCOUNT: &str = "api-key";
const CONFIG_FILE: &str = "config.json";

fn cluster_keychain_account(cluster_id: &str) -> String {
    format!("cluster:{cluster_id}")
}

#[derive(Debug, thiserror::Error)]
enum HostError {
    #[error("config I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("config serialize: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("keychain: {0}")]
    Keyring(#[from] keyring::Error),
    #[error("tauri: {0}")]
    Tauri(#[from] tauri::Error),
    #[error("cluster not found: {0}")]
    ClusterNotFound(String),
}

impl serde::Serialize for HostError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Serialize, Deserialize, Clone)]
struct ApiKey {
    id: String,
    secret: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Cluster {
    id: String,
    name: String,
    api_server_url: String,
    created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostConfig {
    clusters: Vec<Cluster>,
    selected_cluster_id: Option<String>,
    api_key: Option<ApiKey>,
}

// Persisted config supports both the new multi-cluster shape and the
// legacy `apiServerUrl`-only shape. Legacy reads are migrated on first
// `get_config` call (see `migrate_legacy`).
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistedConfig {
    #[serde(default)]
    clusters: Vec<Cluster>,
    #[serde(default)]
    selected_cluster_id: Option<String>,
    // Legacy single-cluster field. Kept (skipped when serialising
    // the new shape) only as a migration source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_server_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddClusterInput {
    name: String,
    api_server_url: String,
    api_key: ApiKey,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, HostError> {
    let dir = app.path().app_config_dir()?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join(CONFIG_FILE))
}

fn read_persisted_config(app: &AppHandle) -> Result<PersistedConfig, HostError> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(PersistedConfig::default());
    }
    let raw = fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

fn write_persisted_config(app: &AppHandle, cfg: &PersistedConfig) -> Result<(), HostError> {
    let path = config_path(app)?;
    let raw = serde_json::to_string_pretty(cfg)?;
    fs::write(path, raw)?;
    Ok(())
}

fn keychain_entry(account: &str) -> Result<keyring::Entry, HostError> {
    Ok(keyring::Entry::new(KEYCHAIN_SERVICE, account)?)
}

fn read_api_key(account: &str) -> Option<ApiKey> {
    keychain_entry(account)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .and_then(|raw| serde_json::from_str::<ApiKey>(&raw).ok())
}

fn write_api_key(account: &str, key: &ApiKey) -> Result<(), HostError> {
    let entry = keychain_entry(account)?;
    let payload = serde_json::to_string(key)?;
    entry.set_password(&payload)?;
    Ok(())
}

fn delete_api_key(account: &str) {
    if let Ok(entry) = keychain_entry(account) {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(_) => {
                // Best-effort: a stuck keychain entry shouldn't block the rest of the operation.
            }
        }
    }
}

// On read, fold any legacy single-cluster state into the new shape.
// Idempotent: once migrated, the legacy fields are gone and this is a
// no-op. Returns true if the persisted file was rewritten so the
// caller can persist + clean up the old keychain slot.
fn migrate_legacy(app: &AppHandle, cfg: &mut PersistedConfig) -> Result<bool, HostError> {
    if !cfg.clusters.is_empty() {
        // Already migrated. Drop the legacy field if it lingered.
        if cfg.api_server_url.take().is_some() {
            return Ok(true);
        }
        return Ok(false);
    }
    let Some(legacy_url) = cfg.api_server_url.take() else {
        return Ok(false);
    };
    let Some(legacy_key) = read_api_key(LEGACY_KEYCHAIN_ACCOUNT) else {
        // URL but no key — drop the orphan URL silently.
        return Ok(true);
    };

    let id = uuid::Uuid::new_v4().to_string();
    let cluster = Cluster {
        id: id.clone(),
        name: derive_name_from_url(&legacy_url),
        api_server_url: legacy_url,
        created_at: chrono::Utc::now().to_rfc3339(),
    };

    write_api_key(&cluster_keychain_account(&id), &legacy_key)?;
    delete_api_key(LEGACY_KEYCHAIN_ACCOUNT);
    cfg.clusters.push(cluster);
    cfg.selected_cluster_id = Some(id);
    write_persisted_config(app, cfg)?;
    Ok(true)
}

fn derive_name_from_url(url: &str) -> String {
    // Strip scheme + path so the cluster shows a recognisable hostname.
    let without_scheme = url.split("://").nth(1).unwrap_or(url);
    let host = without_scheme.split('/').next().unwrap_or(without_scheme);
    host.strip_prefix("api.").unwrap_or(host).to_string()
}

#[tauri::command]
fn get_config(app: AppHandle) -> Result<HostConfig, HostError> {
    let mut persisted = read_persisted_config(&app)?;
    migrate_legacy(&app, &mut persisted)?;

    let api_key = persisted
        .selected_cluster_id
        .as_deref()
        .and_then(|id| read_api_key(&cluster_keychain_account(id)));

    Ok(HostConfig {
        clusters: persisted.clusters,
        selected_cluster_id: persisted.selected_cluster_id,
        api_key,
    })
}

#[tauri::command]
fn add_cluster(app: AppHandle, input: AddClusterInput) -> Result<Cluster, HostError> {
    let mut persisted = read_persisted_config(&app)?;
    migrate_legacy(&app, &mut persisted)?;

    let cluster = Cluster {
        id: uuid::Uuid::new_v4().to_string(),
        name: input.name,
        api_server_url: input.api_server_url,
        created_at: chrono::Utc::now().to_rfc3339(),
    };

    write_api_key(&cluster_keychain_account(&cluster.id), &input.api_key)?;
    persisted.clusters.push(cluster.clone());
    persisted.selected_cluster_id = Some(cluster.id.clone());
    write_persisted_config(&app, &persisted)?;
    Ok(cluster)
}

#[tauri::command]
fn select_cluster(app: AppHandle, cluster_id: Option<String>) -> Result<(), HostError> {
    let mut persisted = read_persisted_config(&app)?;
    migrate_legacy(&app, &mut persisted)?;

    if let Some(ref id) = cluster_id {
        if !persisted.clusters.iter().any(|c| &c.id == id) {
            return Err(HostError::ClusterNotFound(id.clone()));
        }
    }
    persisted.selected_cluster_id = cluster_id;
    write_persisted_config(&app, &persisted)
}

#[tauri::command]
fn remove_cluster(app: AppHandle, cluster_id: String) -> Result<(), HostError> {
    let mut persisted = read_persisted_config(&app)?;
    migrate_legacy(&app, &mut persisted)?;

    let before = persisted.clusters.len();
    persisted.clusters.retain(|c| c.id != cluster_id);
    if persisted.clusters.len() == before {
        return Err(HostError::ClusterNotFound(cluster_id));
    }

    delete_api_key(&cluster_keychain_account(&cluster_id));

    // If we removed the selected cluster, fall back to the first
    // remaining one (or null when the list is now empty).
    if persisted.selected_cluster_id.as_deref() == Some(cluster_id.as_str()) {
        persisted.selected_cluster_id = persisted.clusters.first().map(|c| c.id.clone());
    }
    write_persisted_config(&app, &persisted)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AwsProfile {
    name: String,
    /// True when the profile is configured for SSO (sso_session = ...
    /// or legacy sso_start_url). Surfaced to the wizard so the UI can
    /// hint at `aws sso login` failures distinctly from access-key
    /// profiles.
    is_sso: bool,
    /// Source file the profile was discovered in — purely informational.
    source: AwsProfileSource,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum AwsProfileSource {
    Config,
    Credentials,
}

/// Enumerate AWS profiles from `~/.aws/config` and `~/.aws/credentials`.
/// Returns an empty list if neither file exists. Parses INI lazily —
/// any malformed section is skipped silently rather than aborting the
/// whole listing, so the wizard always has *something* to show.
#[tauri::command]
fn list_aws_profiles() -> Result<Vec<AwsProfile>, HostError> {
    let home = match std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        Some(h) => PathBuf::from(h),
        None => return Ok(Vec::new()),
    };
    let aws_dir = home.join(".aws");
    let mut out: Vec<AwsProfile> = Vec::new();

    let config_path = aws_dir.join("config");
    if config_path.exists() {
        if let Ok(text) = fs::read_to_string(&config_path) {
            for (name, body) in parse_ini_sections(&text) {
                // Strip the `profile ` prefix that ~/.aws/config uses
                // for everything except `[default]`. Skip sso-session
                // sections — they're not profiles, just shared config.
                let profile_name = if name == "default" {
                    Some("default".to_string())
                } else if let Some(rest) = name.strip_prefix("profile ") {
                    Some(rest.trim().to_string())
                } else {
                    None
                };
                if let Some(profile_name) = profile_name {
                    let is_sso = body.contains("sso_session") || body.contains("sso_start_url");
                    out.push(AwsProfile {
                        name: profile_name,
                        is_sso,
                        source: AwsProfileSource::Config,
                    });
                }
            }
        }
    }

    let creds_path = aws_dir.join("credentials");
    if creds_path.exists() {
        if let Ok(text) = fs::read_to_string(&creds_path) {
            for (name, _body) in parse_ini_sections(&text) {
                if out.iter().any(|p| p.name == name) {
                    continue;
                }
                out.push(AwsProfile {
                    name,
                    is_sso: false,
                    source: AwsProfileSource::Credentials,
                });
            }
        }
    }

    Ok(out)
}

/// Tiny INI section parser — yields (section_name, section_body) for
/// each `[section]` block. Good enough for `~/.aws/*`; doesn't try to
/// be a general-purpose INI reader.
fn parse_ini_sections(text: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut current_name: Option<String> = None;
    let mut current_body = String::new();
    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            if let Some(name) = current_name.take() {
                out.push((name, std::mem::take(&mut current_body)));
            }
            current_name = Some(line[1..line.len() - 1].trim().to_string());
            continue;
        }
        if current_name.is_some() {
            current_body.push_str(raw_line);
            current_body.push('\n');
        }
    }
    if let Some(name) = current_name {
        out.push((name, current_body));
    }
    out
}

// Resolve the path to the compiled bootstrap sidecar. Dev-only: uses
// CARGO_MANIFEST_DIR to find the sibling `sidecar/dist/main.cjs`.
// Production packaging (bundling the sidecar into the installer as a
// Tauri resource or externalBin) is tracked in RFC 0017 alongside the
// downloadable bootstrapper stack.
fn sidecar_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("sidecar")
        .join("dist")
        .join("main.cjs")
}

/// Spawn the bootstrap sidecar, pipe input JSON to stdin, stream
/// NDJSON events back to the frontend via a Tauri Channel, and
/// return the final BootstrapResult (or an error).
#[tauri::command]
async fn run_bootstrap(
    input: serde_json::Value,
    on_event: Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let script = sidecar_path();
    if !script.exists() {
        return Err(format!(
            "sidecar not built. Run `pnpm --filter @appliance.sh/desktop run sidecar:build` first. (expected at {})",
            script.display()
        ));
    }

    let mut child = Command::new("node")
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn node sidecar: {}", e))?;

    // Write the input JSON to stdin and close it so the sidecar's
    // `for await (const chunk of process.stdin)` loop terminates.
    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "sidecar stdin unavailable".to_string())?;
        let payload = serde_json::to_vec(&input).map_err(|e| e.to_string())?;
        stdin
            .write_all(&payload)
            .await
            .map_err(|e| format!("failed to write sidecar stdin: {}", e))?;
    }

    // Tee stderr into `log`-level events so Pulumi's warnings surface
    // in the UI instead of disappearing. Runs on a detached task so
    // it doesn't block the stdout reader.
    if let Some(stderr) = child.stderr.take() {
        let stderr_channel = on_event.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = stderr_channel.send(serde_json::json!({
                    "type": "log",
                    "level": "info",
                    "message": line,
                }));
            }
        });
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "sidecar stdout unavailable".to_string())?;
    let mut lines = BufReader::new(stdout).lines();

    let mut final_result: Option<serde_json::Value> = None;
    let mut error: Option<String> = None;

    while let Ok(Some(line)) = lines.next_line().await {
        let event: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => {
                // Not JSON — surface as a log event. Sidecar should
                // always emit NDJSON, but anything else (e.g. a node
                // crash trace) still reaches the user.
                let _ = on_event.send(serde_json::json!({
                    "type": "log",
                    "level": "warn",
                    "message": line,
                }));
                continue;
            }
        };

        match event.get("type").and_then(|v| v.as_str()) {
            Some("result") => final_result = event.get("result").cloned(),
            Some("error") => {
                error = event
                    .get("error")
                    .and_then(|v| v.as_str())
                    .map(String::from)
                    .or(Some("sidecar reported unspecified error".to_string()));
            }
            _ => {
                let _ = on_event.send(event);
            }
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("sidecar wait failed: {}", e))?;

    if let Some(e) = error {
        return Err(e);
    }
    if !status.success() {
        return Err(format!("sidecar exited with {}", status));
    }
    final_result.ok_or_else(|| "sidecar exited without producing a result".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            get_config,
            add_cluster,
            select_cluster,
            remove_cluster,
            list_aws_profiles,
            run_bootstrap
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
