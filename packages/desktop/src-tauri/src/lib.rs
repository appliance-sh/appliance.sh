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
    // Pulumi state backend URL (e.g. `s3://us-east-1-state-...`)
    // for clusters bootstrapped from this device. Persisted so the
    // Settings page can run state promotion (phase 3) on demand.
    // Absent on clusters added via the Connect page (manual entry)
    // or migrated from the legacy single-cluster shape.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    state_backend_url: Option<String>,
    // Original BootstrapInput the wizard collected, stored as an
    // opaque JSON value (the schema lives in @appliance.sh/bootstrap;
    // the Rust side just round-trips it). Reused by the Settings
    // page's "Update baseline" action so phase 1 re-runs with the
    // same dns.createZone / vpc / region choices and doesn't flip
    // declarative state on the operator. Absent for clusters added
    // before this field landed, and for clusters added via Connect.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_bootstrap_input: Option<serde_json::Value>,
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
    #[serde(default)]
    state_backend_url: Option<String>,
    #[serde(default)]
    last_bootstrap_input: Option<serde_json::Value>,
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
        state_backend_url: None,
        last_bootstrap_input: None,
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
        state_backend_url: input.state_backend_url,
        last_bootstrap_input: input.last_bootstrap_input,
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

/// Set (or clear, with `None`) the cached `stateBackendUrl` on a
/// cluster. Settings calls this after promotion (clear, since the
/// local state has been archived) and after demotion (set to the
/// URL we demoted from, so a future re-promotion can default the
/// input field). Idempotent.
#[tauri::command]
fn set_cluster_state_backend(
    app: AppHandle,
    cluster_id: String,
    url: Option<String>,
) -> Result<(), HostError> {
    let mut persisted = read_persisted_config(&app)?;
    migrate_legacy(&app, &mut persisted)?;

    let cluster = persisted
        .clusters
        .iter_mut()
        .find(|c| c.id == cluster_id)
        .ok_or_else(|| HostError::ClusterNotFound(cluster_id.clone()))?;
    cluster.state_backend_url = url;
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

/// Spawn the sidecar with the given JSON input, stream NDJSON events
/// back to the frontend via the Tauri Channel, and return whatever
/// the sidecar emits as its final `result` line.
///
/// Each sidecar invocation reads one JSON object from stdin and
/// terminates after emitting `{type: "result", ...}` or
/// `{type: "error", ...}` on stdout. The sidecar internally
/// dispatches on the input's `kind` field — see `sidecar/src/main.ts`.
async fn invoke_sidecar(
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

/// Drive a full bootstrap (phases 1–3) via the sidecar. The frontend
/// passes `{bootstrapInput, options?}`; this command tags the payload
/// with `kind: "bootstrap"` so the sidecar dispatches to runBootstrap.
#[tauri::command]
async fn run_bootstrap(
    input: serde_json::Value,
    on_event: Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut payload = match input {
        serde_json::Value::Object(map) => map,
        other => {
            return Err(format!(
                "run_bootstrap expected an object input, got: {}",
                other
            ))
        }
    };
    payload.insert(
        "kind".to_string(),
        serde_json::Value::String("bootstrap".to_string()),
    );
    invoke_sidecar(serde_json::Value::Object(payload), on_event).await
}

/// Run phase 3 (state promotion) standalone via the sidecar. Used by
/// the Settings page to detach a cluster's state from this device
/// after the fact.
#[tauri::command]
async fn promote_state(
    input: serde_json::Value,
    on_event: Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut payload = match input {
        serde_json::Value::Object(map) => map,
        other => {
            return Err(format!(
                "promote_state expected an object input, got: {}",
                other
            ))
        }
    };
    payload.insert(
        "kind".to_string(),
        serde_json::Value::String("promote-state".to_string()),
    );
    invoke_sidecar(serde_json::Value::Object(payload), on_event).await
}

/// Inverse of `promote_state`: pull installer Pulumi state out of S3
/// back into the local file backend on this device. Used by Settings
/// to reattach a cluster's installer state for offline / debugging
/// work.
#[tauri::command]
async fn demote_state(
    input: serde_json::Value,
    on_event: Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut payload = match input {
        serde_json::Value::Object(map) => map,
        other => {
            return Err(format!(
                "demote_state expected an object input, got: {}",
                other
            ))
        }
    };
    payload.insert(
        "kind".to_string(),
        serde_json::Value::String("demote-state".to_string()),
    );
    invoke_sidecar(serde_json::Value::Object(payload), on_event).await
}

/// Self-update the api-server + api-worker on the cluster to a new
/// image version. The sidecar runs the mirror-to-ECR step (needs
/// docker, which Lambda doesn't have) then drives the deploys via
/// the cluster's existing deployment API.
#[tauri::command]
async fn update_api_server(
    input: serde_json::Value,
    on_event: Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut payload = match input {
        serde_json::Value::Object(map) => map,
        other => {
            return Err(format!(
                "update_api_server expected an object input, got: {}",
                other
            ))
        }
    };
    payload.insert(
        "kind".to_string(),
        serde_json::Value::String("update-api-server".to_string()),
    );
    invoke_sidecar(serde_json::Value::Object(payload), on_event).await
}

/// Re-run phase 1 against the cluster's installer stack to update the
/// infra baseline (state bucket, ECR, CloudFront, edge router, system
/// roles, etc.) to whatever ships with this version of @appliance.sh/infra.
#[tauri::command]
async fn update_baseline(
    input: serde_json::Value,
    on_event: Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut payload = match input {
        serde_json::Value::Object(map) => map,
        other => {
            return Err(format!(
                "update_baseline expected an object input, got: {}",
                other
            ))
        }
    };
    payload.insert(
        "kind".to_string(),
        serde_json::Value::String("update-baseline".to_string()),
    );
    invoke_sidecar(serde_json::Value::Object(payload), on_event).await
}

/// Resolve the latest semver-shaped tag on a ghcr.io image. The
/// sidecar talks Docker Registry v2 directly (anonymous pull token).
/// No event stream — this is a single-shot lookup, but we route it
/// through the sidecar for consistency with the rest of the
/// bootstrap-pkg surface.
#[tauri::command]
async fn latest_api_server_version(
    input: serde_json::Value,
    on_event: Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut payload = match input {
        serde_json::Value::Object(map) => map,
        serde_json::Value::Null => serde_json::Map::new(),
        other => {
            return Err(format!(
                "latest_api_server_version expected an object or null input, got: {}",
                other
            ))
        }
    };
    payload.insert(
        "kind".to_string(),
        serde_json::Value::String("latest-version".to_string()),
    );
    invoke_sidecar(serde_json::Value::Object(payload), on_event).await
}

// Default k3d cluster name when the desktop manages the local
// `appliance-base-local` runtime. Must match
// DEFAULT_LOCAL_CLUSTER_NAME in
// `packages/infra/src/lib/local/LocalContainerDeploymentService.ts`.
const DEFAULT_LOCAL_CLUSTER_NAME: &str = "appliance-local";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalClusterStatus {
    /// True when `k3d` is on PATH and the named cluster shows up in
    /// `k3d cluster list -o json`. The frontend uses this to decide
    /// whether to expose Start vs. Stop vs. Create buttons.
    exists: bool,
    /// True when the cluster's nodes are reporting `running`. Stop
    /// flips this to false; the cluster still exists and can be
    /// restarted without recreating state.
    running: bool,
    cluster_name: String,
    /// Reason a status check couldn't be completed (k3d missing,
    /// docker not running, etc.). Surfaced verbatim to the UI.
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LocalClusterInput {
    #[serde(default)]
    cluster_name: Option<String>,
    /// Host port the cluster's LoadBalancer publishes (forwards onto
    /// the k3d serverlb container, which then hits NodePorts inside).
    /// Default 8081 — keeps clear of the desktop's 1420 dev server
    /// and common 8080.
    #[serde(default)]
    host_port: Option<u16>,
}

fn cluster_name_or_default(input: &LocalClusterInput) -> String {
    input
        .cluster_name
        .clone()
        .unwrap_or_else(|| DEFAULT_LOCAL_CLUSTER_NAME.to_string())
}

async fn run_status_command(args: &[&str]) -> Result<(bool, String, String), String> {
    let output = Command::new(args[0])
        .args(&args[1..])
        .output()
        .await
        .map_err(|e| format!("failed to spawn {}: {}", args[0], e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Ok((output.status.success(), stdout, stderr))
}

/// Probe k3d for a cluster by name. Returns existence + running
/// state; absent k3d / docker reports `exists: false, running: false`
/// with a populated `message` so the UI can render an actionable
/// install hint instead of a stack trace.
#[tauri::command]
async fn local_cluster_status(input: LocalClusterInput) -> Result<LocalClusterStatus, String> {
    let name = cluster_name_or_default(&input);
    let result = run_status_command(&["k3d", "cluster", "list", "-o", "json"]).await;
    let (ok, stdout, stderr) = match result {
        Ok(t) => t,
        Err(e) => {
            return Ok(LocalClusterStatus {
                exists: false,
                running: false,
                cluster_name: name,
                message: Some(e),
            });
        }
    };
    if !ok {
        return Ok(LocalClusterStatus {
            exists: false,
            running: false,
            cluster_name: name,
            message: Some(stderr),
        });
    }
    // Each entry in `k3d cluster list -o json` reports a name and a
    // list of nodes; a cluster is "running" iff every node is in
    // state `running`. We deliberately scan the raw JSON instead of
    // shelling out to `k3d cluster get <name>` because the latter
    // exits non-zero when the cluster is stopped, which would force
    // us to disambiguate "stopped" from "missing" via stderr parsing.
    let parsed: serde_json::Value = serde_json::from_str(&stdout).map_err(|e| e.to_string())?;
    let clusters = parsed.as_array().cloned().unwrap_or_default();
    for cluster in clusters {
        if cluster.get("name").and_then(|n| n.as_str()) == Some(name.as_str()) {
            let nodes = cluster
                .get("nodes")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let running = !nodes.is_empty()
                && nodes
                    .iter()
                    .all(|n| n.get("State").and_then(|s| s.get("Running")).and_then(|b| b.as_bool()).unwrap_or(false));
            return Ok(LocalClusterStatus {
                exists: true,
                running,
                cluster_name: name,
                message: None,
            });
        }
    }
    Ok(LocalClusterStatus {
        exists: false,
        running: false,
        cluster_name: name,
        message: None,
    })
}

/// Create-or-start the named k3d cluster. Idempotent: an existing
/// stopped cluster is started; an existing running cluster is left
/// alone. Maps the cluster LoadBalancer's :80 onto `host_port` so
/// services deployed by the api-server are reachable from the host.
#[tauri::command]
async fn start_local_cluster(input: LocalClusterInput) -> Result<LocalClusterStatus, String> {
    let name = cluster_name_or_default(&input);
    let status = local_cluster_status(LocalClusterInput {
        cluster_name: Some(name.clone()),
        host_port: input.host_port,
    })
    .await?;
    if status.exists {
        if status.running {
            return Ok(status);
        }
        // Stopped — start it back up.
        let (ok, _stdout, stderr) =
            run_status_command(&["k3d", "cluster", "start", &name]).await?;
        if !ok {
            return Err(format!("k3d cluster start failed: {}", stderr));
        }
    } else {
        // Fresh creation. NodePort range exposed so Service NodePorts
        // (30000-32767) are reachable from the host via the
        // k3d-managed serverlb container.
        let host_port = input.host_port.unwrap_or(8081);
        let port_arg = format!("{}:80@loadbalancer", host_port);
        let agents_arg = "1";
        let (ok, _stdout, stderr) = run_status_command(&[
            "k3d",
            "cluster",
            "create",
            &name,
            "--agents",
            agents_arg,
            "-p",
            &port_arg,
            "--wait",
        ])
        .await?;
        if !ok {
            return Err(format!("k3d cluster create failed: {}", stderr));
        }
    }
    local_cluster_status(LocalClusterInput {
        cluster_name: Some(name),
        host_port: input.host_port,
    })
    .await
}

/// Stop the cluster without deleting its state. `start_local_cluster`
/// brings it back; `delete_local_cluster` removes it entirely.
#[tauri::command]
async fn stop_local_cluster(input: LocalClusterInput) -> Result<LocalClusterStatus, String> {
    let name = cluster_name_or_default(&input);
    let (ok, _stdout, stderr) = run_status_command(&["k3d", "cluster", "stop", &name]).await?;
    if !ok && !stderr.contains("not found") {
        return Err(format!("k3d cluster stop failed: {}", stderr));
    }
    local_cluster_status(LocalClusterInput {
        cluster_name: Some(name),
        host_port: input.host_port,
    })
    .await
}

/// Permanently delete the named cluster and all of its state.
/// Separate from `stop_local_cluster` so the UI can offer a low-risk
/// "stop" alongside a confirm-gated "delete".
#[tauri::command]
async fn delete_local_cluster(input: LocalClusterInput) -> Result<LocalClusterStatus, String> {
    let name = cluster_name_or_default(&input);
    let (ok, _stdout, stderr) = run_status_command(&["k3d", "cluster", "delete", &name]).await?;
    if !ok && !stderr.contains("not found") {
        return Err(format!("k3d cluster delete failed: {}", stderr));
    }
    Ok(LocalClusterStatus {
        exists: false,
        running: false,
        cluster_name: name,
        message: None,
    })
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
            set_cluster_state_backend,
            list_aws_profiles,
            run_bootstrap,
            promote_state,
            demote_state,
            update_api_server,
            update_baseline,
            latest_api_server_version,
            local_cluster_status,
            start_local_cluster,
            stop_local_cluster,
            delete_local_cluster
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
