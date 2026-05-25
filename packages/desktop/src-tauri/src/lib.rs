use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

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

// ============================================================
// Shared profile store: ~/.appliance/profiles.json
//
// The desktop runs in DUAL-MODE persistence:
//   1. The OS keychain holds each cluster's API key secret (account
//      `cluster:<id>`). This is the more-secure store and stays the
//      primary source for secrets on the desktop side.
//   2. The legacy <app-config>/config.json holds cluster metadata
//      (name, URL, createdAt, etc.) — kept as a mirror so a downgrade
//      to the previous desktop binary remains non-destructive.
//   3. ~/.appliance/profiles.json mirrors BOTH metadata and secrets in
//      a format the CLI reads directly. Updated on every persisted
//      write so the CLI sees the same clusters the desktop sees.
//
// Reads prefer the legacy file when it has clusters; otherwise the
// shared file is ingested into the legacy stores so the rest of the
// code path is unchanged.
// ============================================================

const SHARED_PROFILES_DIR: &str = ".appliance";
const SHARED_PROFILES_FILE: &str = "profiles.json";

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct SharedProfileEntry {
    api_url: String,
    key_id: String,
    secret: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    state_backend_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_bootstrap_input: Option<serde_json::Value>,
    /// Which surface created the profile ("desktop" | "cli"). Used by
    /// the desktop's mirror step to only rewrite its own entries and
    /// leave CLI-managed profiles alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    managed: Option<String>,
    /// Human label for the profile; the map key is the slug/id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SharedProfilesFile {
    #[serde(default = "shared_profiles_version")]
    version: u32,
    #[serde(default)]
    active_profile: Option<String>,
    #[serde(default)]
    profiles: BTreeMap<String, SharedProfileEntry>,
}

fn shared_profiles_version() -> u32 {
    1
}

impl Default for SharedProfilesFile {
    fn default() -> Self {
        Self {
            version: 1,
            active_profile: None,
            profiles: BTreeMap::new(),
        }
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn shared_profiles_path() -> Option<PathBuf> {
    home_dir().map(|h| h.join(SHARED_PROFILES_DIR).join(SHARED_PROFILES_FILE))
}

fn read_shared_profiles() -> Option<SharedProfilesFile> {
    let path = shared_profiles_path()?;
    if !path.exists() {
        return None;
    }
    let raw = fs::read_to_string(&path).ok()?;
    serde_json::from_str::<SharedProfilesFile>(&raw).ok()
}

fn write_shared_profiles(file: &SharedProfilesFile) -> Result<(), HostError> {
    let Some(path) = shared_profiles_path() else {
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    // Atomic write so a crash during serialization doesn't leave a
    // half-truncated file (which would brick both the desktop and the
    // CLI on next read).
    let tmp = path.with_extension("json.tmp");
    let raw = serde_json::to_string_pretty(file)?;
    fs::write(&tmp, raw)?;
    fs::rename(&tmp, &path)?;
    // 0600 on unix so the secrets aren't world-readable. Best-effort
    // on Windows where there's no equivalent simple permission bit.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Reflect the current desktop-side state into the shared file. Reads
/// each cluster's secret out of the keychain; clusters without a
/// keychain secret get the entry left as-is from any prior write
/// (defensive — partial state is more useful than a missing entry).
/// CLI-managed entries (managed != "desktop") are preserved untouched.
fn mirror_to_shared_profiles(cfg: &PersistedConfig) -> Result<(), HostError> {
    let mut file = read_shared_profiles().unwrap_or_default();
    file.profiles.retain(|_, entry| entry.managed.as_deref() != Some("desktop"));
    for cluster in &cfg.clusters {
        let secret = read_api_key(&cluster_keychain_account(&cluster.id));
        let (key_id, secret_value) = match secret {
            Some(k) => (k.id, k.secret),
            None => {
                // No key on the keychain yet — keep whatever the
                // shared file already had for this id, or write a
                // placeholder if absent so the metadata survives.
                let existing = file.profiles.get(&cluster.id).cloned();
                let prev = existing.unwrap_or_default();
                (prev.key_id, prev.secret)
            }
        };
        file.profiles.insert(
            cluster.id.clone(),
            SharedProfileEntry {
                api_url: cluster.api_server_url.clone(),
                key_id,
                secret: secret_value,
                created_at: Some(cluster.created_at.clone()),
                state_backend_url: cluster.state_backend_url.clone(),
                last_bootstrap_input: cluster.last_bootstrap_input.clone(),
                managed: Some("desktop".to_string()),
                name: Some(cluster.name.clone()),
            },
        );
    }
    file.active_profile = cfg.selected_cluster_id.clone();
    write_shared_profiles(&file)
}

/// Convert a SharedProfilesFile into a PersistedConfig (the desktop's
/// in-memory shape) and write the secrets back into the OS keychain so
/// subsequent calls see them through the existing keychain path.
/// Also writes the legacy config.json so the next read short-circuits.
fn ingest_shared_into_legacy(
    app: &AppHandle,
    shared: SharedProfilesFile,
) -> Result<PersistedConfig, HostError> {
    let mut cfg = PersistedConfig::default();
    for (id, entry) in &shared.profiles {
        let cluster = Cluster {
            id: id.clone(),
            name: entry.name.clone().unwrap_or_else(|| id.clone()),
            api_server_url: entry.api_url.clone(),
            created_at: entry
                .created_at
                .clone()
                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
            state_backend_url: entry.state_backend_url.clone(),
            last_bootstrap_input: entry.last_bootstrap_input.clone(),
        };
        let _ = write_api_key(
            &cluster_keychain_account(id),
            &ApiKey {
                id: entry.key_id.clone(),
                secret: entry.secret.clone(),
            },
        );
        cfg.clusters.push(cluster);
    }
    cfg.selected_cluster_id = shared.active_profile.clone();

    // Persist to the legacy file so this code path doesn't re-ingest
    // on every read.
    let legacy_path = config_path(app)?;
    let raw = serde_json::to_string_pretty(&cfg)?;
    fs::write(legacy_path, raw)?;
    Ok(cfg)
}

fn read_persisted_config(app: &AppHandle) -> Result<PersistedConfig, HostError> {
    let path = config_path(app)?;
    let legacy = if path.exists() {
        let raw = fs::read_to_string(&path)?;
        serde_json::from_str::<PersistedConfig>(&raw).unwrap_or_default()
    } else {
        PersistedConfig::default()
    };

    // Legacy file already has clusters — use it as the source of truth.
    // The shared file is updated as a mirror on every subsequent write.
    if !legacy.clusters.is_empty() {
        return Ok(legacy);
    }

    // Legacy file is empty/missing. Pull from the shared store if the
    // CLI (or a previous version of this desktop) populated it.
    if let Some(shared) = read_shared_profiles() {
        if !shared.profiles.is_empty() {
            return ingest_shared_into_legacy(app, shared);
        }
    }
    Ok(legacy)
}

fn write_persisted_config(app: &AppHandle, cfg: &PersistedConfig) -> Result<(), HostError> {
    let path = config_path(app)?;
    let raw = serde_json::to_string_pretty(cfg)?;
    fs::write(path, raw)?;
    // Best-effort mirror — if writing the shared file fails (e.g.
    // unwritable home dir), the desktop's own state is still
    // consistent; the CLI just won't see the latest set.
    if let Err(e) = mirror_to_shared_profiles(cfg) {
        eprintln!("warn: shared-profile mirror failed: {e}");
    }
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
const DEFAULT_LOCAL_NAMESPACE: &str = "appliance";
const DEFAULT_LOCAL_HOST_PORT: u16 = 8081;
// NodePort sub-range published from the k3d agent onto the host.
// Kept small (51 ports) because publishing the full 30000-32767 window
// crashes colima/docker on macOS at the docker-proxy layer.
// LocalContainerDeploymentService.deterministicNodePort() picks within
// the same range so each deployment's NodePort is reachable here.
const DEFAULT_LOCAL_NODEPORT_MIN: u16 = 30000;
const DEFAULT_LOCAL_NODEPORT_MAX: u16 = 30050;
const DEFAULT_LOCAL_API_PORT: u16 = 3030;
const LOCAL_RUNTIME_CLUSTER_NAME: &str = "Local Runtime";
// Stable cluster id == profile name used by the CLI's `--profile`
// flag and the shared profiles.json key.
const LOCAL_RUNTIME_CLUSTER_ID: &str = "local-runtime";

#[derive(Serialize, Clone)]
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
        // Fresh creation. We publish two port ranges:
        //   1. host_port -> serverlb:80 for the in-cluster ingress/LB
        //      path (api-server, ingress-managed apps).
        //   2. A small NodePort window -> agent:0 so the executor's
        //      Service NodePorts are directly reachable on the host.
        //      `LocalContainerDeploymentService.deterministicNodePort`
        //      hashes inside the same window — must stay in sync.
        let host_port = input.host_port.unwrap_or(DEFAULT_LOCAL_HOST_PORT);
        let port_arg = format!("{}:80@loadbalancer", host_port);
        let nodeport_arg = format!(
            "{}-{}:{}-{}@agent:0",
            DEFAULT_LOCAL_NODEPORT_MIN,
            DEFAULT_LOCAL_NODEPORT_MAX,
            DEFAULT_LOCAL_NODEPORT_MIN,
            DEFAULT_LOCAL_NODEPORT_MAX,
        );
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
            "-p",
            &nodeport_arg,
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

// ============================================================
// Local runtime orchestration
//
// The "local runtime" is a Docker Desktop-style end-to-end stack:
//   1. A k3d cluster (lifecycle from local_cluster_*).
//   2. A node `@appliance.sh/api-server` process pointed at an
//      `appliance-base-local` config + the user's data dir.
//   3. An auto-registered Cluster entry in the desktop's persisted
//      config so every existing Console page (Projects, Environments,
//      Deployments) lights up against the local api-server with zero
//      additional wiring.
// ============================================================

/// Runtime input shared by status / start / stop / delete. All fields
/// are optional and fall back to baked-in defaults.
#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
struct LocalRuntimeInput {
    cluster_name: Option<String>,
    namespace: Option<String>,
    host_port: Option<u16>,
    api_port: Option<u16>,
    data_dir: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ResolvedRuntimeConfig {
    cluster_name: String,
    namespace: String,
    host_port: u16,
    api_port: u16,
    data_dir: String,
    api_server_url: String,
    node_port_min: u16,
    node_port_max: u16,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct ApiServerStatus {
    running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    log_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LocalRuntimeStatus {
    cluster: LocalClusterStatus,
    api_server: ApiServerStatus,
    config: ResolvedRuntimeConfig,
    /// Cluster id under which the runtime is registered in the
    /// desktop's persisted config (so the Console can talk to it via
    /// the normal cluster-selection flow). None until the runtime has
    /// been started at least once.
    #[serde(skip_serializing_if = "Option::is_none")]
    cluster_id: Option<String>,
}

/// Held in Tauri's managed state. Wraps the spawned api-server
/// child + metadata; `None` means no live api-server.
struct ApiServerHandle {
    child: Child,
    port: u16,
    log_path: PathBuf,
    started_at: String,
}

#[derive(Default)]
struct LocalRuntimeState {
    api_server: Mutex<Option<ApiServerHandle>>,
}

fn resolve_runtime_config(
    app: &AppHandle,
    input: &LocalRuntimeInput,
) -> Result<ResolvedRuntimeConfig, String> {
    let cluster_name = input
        .cluster_name
        .clone()
        .unwrap_or_else(|| DEFAULT_LOCAL_CLUSTER_NAME.to_string());
    let namespace = input
        .namespace
        .clone()
        .unwrap_or_else(|| DEFAULT_LOCAL_NAMESPACE.to_string());
    let host_port = input.host_port.unwrap_or(DEFAULT_LOCAL_HOST_PORT);
    let api_port = input.api_port.unwrap_or(DEFAULT_LOCAL_API_PORT);
    let data_dir = match &input.data_dir {
        Some(p) => PathBuf::from(p),
        None => app
            .path()
            .app_data_dir()
            .map_err(|e| format!("resolve app data dir: {e}"))?
            .join("local-runtime"),
    };
    Ok(ResolvedRuntimeConfig {
        cluster_name,
        namespace,
        host_port,
        api_port,
        data_dir: data_dir.to_string_lossy().to_string(),
        api_server_url: format!("http://localhost:{}", api_port),
        node_port_min: DEFAULT_LOCAL_NODEPORT_MIN,
        node_port_max: DEFAULT_LOCAL_NODEPORT_MAX,
    })
}

/// Probe TCP + a known endpoint to decide whether a previously-spawned
/// (or externally-running) api-server is alive on `port`. Used both
/// for the live-handle case and to detect leftovers after a desktop
/// restart with no managed handle.
/// Best-effort: which PID is listening on `port`? Used when we see an
/// api-server we didn't spawn (e.g. the user started it from the CLI
/// during a demo) so the desktop can still display + stop it. Shells
/// out to `lsof` because that's already on every macOS/Linux box that
/// can run k3d; returns None on Windows or when lsof is absent.
async fn find_pid_listening_on_port(port: u16) -> Option<u32> {
    let (ok, stdout, _stderr) = run_status_command(&[
        "lsof",
        "-ti",
        &format!("tcp:{}", port),
        "-sTCP:LISTEN",
    ])
    .await
    .ok()?;
    if !ok {
        return None;
    }
    stdout.lines().next()?.trim().parse::<u32>().ok()
}

async fn probe_api_server(port: u16) -> bool {
    // Off the tokio runtime so we don't need the `net` feature; a 200ms
    // connect_timeout is plenty against loopback.
    tokio::task::spawn_blocking(move || {
        let addr = format!("127.0.0.1:{}", port);
        let sock_addr: std::net::SocketAddr = match addr.parse() {
            Ok(s) => s,
            Err(_) => return false,
        };
        std::net::TcpStream::connect_timeout(&sock_addr, Duration::from_millis(200)).is_ok()
    })
    .await
    .unwrap_or(false)
}

fn api_server_entry() -> Result<(PathBuf, Vec<String>), String> {
    // Prefer the compiled dist; fall back to `tsx src/main.ts` for dev
    // builds where the user runs `pnpm tauri dev` without first
    // running `pnpm --filter @appliance.sh/api-server build`.
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("api-server");
    let dist = base.join("dist").join("src").join("main.js");
    if dist.exists() {
        return Ok((PathBuf::from("node"), vec![dist.to_string_lossy().to_string()]));
    }
    let src = base.join("src").join("main.ts");
    if !src.exists() {
        return Err(format!(
            "api-server entry point not found (looked at {} and {})",
            dist.display(),
            src.display()
        ));
    }
    let tsx = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("node_modules")
        .join(".bin")
        .join("tsx");
    if !tsx.exists() {
        return Err(format!(
            "api-server dist not built and tsx fallback missing at {}",
            tsx.display()
        ));
    }
    Ok((tsx, vec![src.to_string_lossy().to_string()]))
}

/// Build the JSON `APPLIANCE_BASE_CONFIG` env value the api-server
/// expects. The local-base schema is defined in
/// packages/sdk/src/models/appliance-base.ts.
fn build_base_config(cfg: &ResolvedRuntimeConfig) -> String {
    serde_json::json!({
        "type": "appliance-base-local",
        "name": "local-runtime",
        "local": {
            "dataDir": cfg.data_dir,
            "cluster": {
                "clusterName": cfg.cluster_name,
                "namespace": cfg.namespace,
                "hostPort": cfg.host_port,
            }
        }
    })
    .to_string()
}

/// Generate a short opaque token used as BOOTSTRAP_TOKEN for the
/// spawned api-server. It's only valid for the lifetime of this
/// process — once we mint an api key, the token is forgotten.
fn random_bootstrap_token() -> String {
    uuid::Uuid::new_v4().to_string().replace('-', "")
}

/// Mint an initial api key via the api-server's bootstrap route.
/// Idempotent at the SERVER level (`/bootstrap/status` reports whether
/// any key already exists), but creates a fresh "Local Runtime" named
/// key each time it's called.
async fn mint_api_key(api_port: u16, token: &str) -> Result<ApiKey, String> {
    let url = format!("http://localhost:{}/bootstrap/create-key", api_port);
    let body = serde_json::json!({"name": "Local Runtime"}).to_string();
    let (ok, stdout, stderr) = run_status_command(&[
        "curl",
        "-fsS",
        "-X",
        "POST",
        &url,
        "-H",
        &format!("X-Bootstrap-Token: {}", token),
        "-H",
        "content-type: application/json",
        "-d",
        &body,
    ])
    .await?;
    if !ok {
        return Err(format!("mint api key failed: {}", stderr));
    }
    serde_json::from_str::<ApiKey>(&stdout).map_err(|e| format!("parse api key: {e}"))
}

async fn wait_for_api_server(port: u16, max_wait: Duration) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + max_wait;
    loop {
        if probe_api_server(port).await {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!("api-server did not come up on :{} in time", port));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Find the persisted "Local Runtime" cluster (if any). Identified by
/// its loopback api-server URL — name is user-visible and may have
/// been renamed.
fn find_local_runtime_cluster<'a>(
    persisted: &'a PersistedConfig,
    api_server_url: &str,
) -> Option<&'a Cluster> {
    persisted
        .clusters
        .iter()
        .find(|c| c.api_server_url == api_server_url)
}

/// Register (or refresh) the Local Runtime cluster + key in persisted
/// config. Returns the cluster id, whether newly created or refreshed.
fn register_local_runtime_cluster(
    app: &AppHandle,
    cfg: &ResolvedRuntimeConfig,
    api_key: &ApiKey,
) -> Result<String, HostError> {
    let mut persisted = read_persisted_config(app)?;
    migrate_legacy(app, &mut persisted)?;

    let existing_id = persisted
        .clusters
        .iter()
        .find(|c| c.api_server_url == cfg.api_server_url)
        .map(|c| c.id.clone());

    let cluster_id = match existing_id {
        Some(id) => {
            write_api_key(&cluster_keychain_account(&id), api_key)?;
            id
        }
        None => {
            // Stable, human-friendly id so the CLI can reference the
            // profile as `appliance --profile local-runtime` instead
            // of a churning UUID. Safe because we already short-
            // circuited the existing-cluster case above; if another
            // cluster happens to use this same id (highly unlikely),
            // both rows would point at the same NodePort window and
            // the second's keychain write would simply replace the
            // first's.
            let cluster = Cluster {
                id: LOCAL_RUNTIME_CLUSTER_ID.to_string(),
                name: LOCAL_RUNTIME_CLUSTER_NAME.to_string(),
                api_server_url: cfg.api_server_url.clone(),
                created_at: chrono::Utc::now().to_rfc3339(),
                state_backend_url: None,
                last_bootstrap_input: None,
            };
            write_api_key(&cluster_keychain_account(&cluster.id), api_key)?;
            let id = cluster.id.clone();
            persisted.clusters.push(cluster);
            // Auto-select the local cluster on first start. Users can
            // switch away in Settings; subsequent starts of the same
            // runtime won't override an explicit selection.
            if persisted.selected_cluster_id.is_none() {
                persisted.selected_cluster_id = Some(id.clone());
            }
            id
        }
    };

    write_persisted_config(app, &persisted)?;
    Ok(cluster_id)
}

/// Remove the persisted cluster entry pointing at a given
/// api-server URL. Best-effort — silently no-ops if not present.
fn unregister_local_runtime_cluster(app: &AppHandle, api_server_url: &str) -> Result<(), HostError> {
    let mut persisted = read_persisted_config(app)?;
    migrate_legacy(app, &mut persisted)?;

    let before = persisted.clusters.len();
    let removed_ids: Vec<String> = persisted
        .clusters
        .iter()
        .filter(|c| c.api_server_url == api_server_url)
        .map(|c| c.id.clone())
        .collect();
    persisted.clusters.retain(|c| c.api_server_url != api_server_url);
    if persisted.clusters.len() == before {
        return Ok(());
    }
    for id in &removed_ids {
        delete_api_key(&cluster_keychain_account(id));
    }
    if let Some(sel) = persisted.selected_cluster_id.as_deref() {
        if removed_ids.iter().any(|id| id == sel) {
            persisted.selected_cluster_id = persisted.clusters.first().map(|c| c.id.clone());
        }
    }
    write_persisted_config(app, &persisted)
}

fn tail_log(path: &Path, lines: usize) -> String {
    let Ok(raw) = fs::read_to_string(path) else {
        return String::new();
    };
    let collected: Vec<&str> = raw.lines().rev().take(lines).collect();
    collected.into_iter().rev().collect::<Vec<_>>().join("\n")
}

async fn current_api_server_status(state: &LocalRuntimeState, cfg: &ResolvedRuntimeConfig) -> ApiServerStatus {
    let mut guard = state.api_server.lock().await;
    if let Some(handle) = guard.as_mut() {
        // try_wait drains the exit status without blocking. If the
        // child has exited, drop the handle so subsequent calls see
        // a clean Stopped state.
        match handle.child.try_wait() {
            Ok(Some(_status)) => {
                let stale = guard.take().expect("guard checked above");
                let msg = format!(
                    "api-server exited unexpectedly. Tail of {}:\n{}",
                    stale.log_path.display(),
                    tail_log(&stale.log_path, 40)
                );
                return ApiServerStatus {
                    running: false,
                    message: Some(msg),
                    ..Default::default()
                };
            }
            Ok(None) => {
                return ApiServerStatus {
                    running: true,
                    pid: handle.child.id(),
                    port: Some(handle.port),
                    started_at: Some(handle.started_at.clone()),
                    log_path: Some(handle.log_path.to_string_lossy().to_string()),
                    message: None,
                };
            }
            Err(e) => {
                return ApiServerStatus {
                    running: false,
                    message: Some(format!("try_wait: {e}")),
                    ..Default::default()
                };
            }
        }
    }
    drop(guard);

    // No managed handle — check for an externally-launched api-server
    // (e.g. the CLI demo started it, or a previous desktop session
    // exited without stopping the sidecar). Adopt it: look up the PID
    // via lsof so Stop still works, and report a clean Running state
    // rather than a scary "not managed by this desktop" warning.
    if probe_api_server(cfg.api_port).await {
        let pid = find_pid_listening_on_port(cfg.api_port).await;
        return ApiServerStatus {
            running: true,
            port: Some(cfg.api_port),
            pid,
            started_at: None,
            log_path: None,
            message: None,
        };
    }
    ApiServerStatus::default()
}

#[tauri::command]
async fn local_runtime_status(
    app: AppHandle,
    state: tauri::State<'_, Arc<LocalRuntimeState>>,
    input: Option<LocalRuntimeInput>,
) -> Result<LocalRuntimeStatus, String> {
    let input = input.unwrap_or_default();
    let cfg = resolve_runtime_config(&app, &input)?;
    let cluster = local_cluster_status(LocalClusterInput {
        cluster_name: Some(cfg.cluster_name.clone()),
        host_port: Some(cfg.host_port),
    })
    .await?;
    let api_server = current_api_server_status(state.inner(), &cfg).await;
    let persisted = read_persisted_config(&app).map_err(|e| e.to_string())?;
    let cluster_id = find_local_runtime_cluster(&persisted, &cfg.api_server_url).map(|c| c.id.clone());
    Ok(LocalRuntimeStatus {
        cluster,
        api_server,
        config: cfg,
        cluster_id,
    })
}

#[tauri::command]
async fn start_local_runtime(
    app: AppHandle,
    state: tauri::State<'_, Arc<LocalRuntimeState>>,
    input: Option<LocalRuntimeInput>,
) -> Result<LocalRuntimeStatus, String> {
    let input = input.unwrap_or_default();
    let cfg = resolve_runtime_config(&app, &input)?;

    // Phase 1: cluster
    let _ = start_local_cluster(LocalClusterInput {
        cluster_name: Some(cfg.cluster_name.clone()),
        host_port: Some(cfg.host_port),
    })
    .await?;

    // Phase 2: api-server. Skip if a managed handle is already alive,
    // OR if an externally-launched one (CLI demo, previous desktop
    // session) is already serving on the port — adopting beats double-
    // spawning + EADDRINUSE.
    let managed_alive = {
        let mut guard = state.api_server.lock().await;
        if let Some(handle) = guard.as_mut() {
            matches!(handle.child.try_wait(), Ok(None))
        } else {
            false
        }
    };
    let already_alive = managed_alive || probe_api_server(cfg.api_port).await;

    if !already_alive {
        // Drop any stale exited handle before spawning.
        {
            let mut guard = state.api_server.lock().await;
            *guard = None;
        }
        let token = random_bootstrap_token();
        let (program, base_args) = api_server_entry()?;
        let data_dir = PathBuf::from(&cfg.data_dir);
        fs::create_dir_all(&data_dir).map_err(|e| format!("create data dir: {e}"))?;
        let log_dir = app
            .path()
            .app_log_dir()
            .map_err(|e| format!("resolve log dir: {e}"))?;
        fs::create_dir_all(&log_dir).map_err(|e| format!("create log dir: {e}"))?;
        let log_path = log_dir.join("local-api-server.log");
        // Truncate on each start so the log shows only the current
        // run — keeps the "tail of log" error path useful instead of
        // showing stale failures from a prior session.
        let log_file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&log_path)
            .map_err(|e| format!("open log file: {e}"))?;
        let log_file_err = log_file.try_clone().map_err(|e| format!("clone log fd: {e}"))?;

        let mut cmd = Command::new(&program);
        cmd.args(&base_args)
            .env("APPLIANCE_MODE", "server")
            .env("APPLIANCE_BASE_CONFIG", build_base_config(&cfg))
            .env("BOOTSTRAP_TOKEN", &token)
            .env("PORT", cfg.api_port.to_string())
            .env("HOST", "127.0.0.1")
            .stdin(Stdio::null())
            .stdout(Stdio::from(log_file))
            .stderr(Stdio::from(log_file_err))
            .kill_on_drop(true);
        let child = cmd
            .spawn()
            .map_err(|e| format!("spawn api-server: {e}"))?;
        let started_at = chrono::Utc::now().to_rfc3339();
        {
            let mut guard = state.api_server.lock().await;
            *guard = Some(ApiServerHandle {
                child,
                port: cfg.api_port,
                log_path: log_path.clone(),
                started_at,
            });
        }

        if let Err(e) = wait_for_api_server(cfg.api_port, Duration::from_secs(25)).await {
            // Reap the handle so the next start retries cleanly.
            if let Some(mut handle) = state.api_server.lock().await.take() {
                let _ = handle.child.start_kill();
            }
            return Err(format!(
                "{e}. Tail of {}:\n{}",
                log_path.display(),
                tail_log(&log_path, 40)
            ));
        }

        // Phase 3: mint key + register cluster (idempotent — if a
        // matching cluster already exists, we just refresh its key).
        let api_key = mint_api_key(cfg.api_port, &token).await?;
        register_local_runtime_cluster(&app, &cfg, &api_key).map_err(|e| e.to_string())?;
    }

    local_runtime_status(app, state, Some(input)).await
}

#[tauri::command]
async fn stop_local_runtime(
    app: AppHandle,
    state: tauri::State<'_, Arc<LocalRuntimeState>>,
    input: Option<LocalRuntimeInput>,
) -> Result<LocalRuntimeStatus, String> {
    let input = input.unwrap_or_default();
    let cfg = resolve_runtime_config(&app, &input)?;

    // Kill the api-server first so it doesn't error-log when the
    // cluster's apiserver vanishes underneath it.
    let had_managed = {
        let mut guard = state.api_server.lock().await;
        if let Some(mut handle) = guard.take() {
            let _ = handle.child.kill().await;
            true
        } else {
            false
        }
    };
    // Fallback for adopted (CLI-launched) api-servers: there's no Child
    // handle to kill, so look up the PID listening on our port and
    // SIGTERM it. The api-server traps SIGTERM and exits cleanly.
    if !had_managed {
        if let Some(pid) = find_pid_listening_on_port(cfg.api_port).await {
            let _ = run_status_command(&["kill", &pid.to_string()]).await;
        }
    }

    let (ok, _stdout, stderr) =
        run_status_command(&["k3d", "cluster", "stop", &cfg.cluster_name]).await?;
    if !ok && !stderr.contains("not found") {
        return Err(format!("k3d cluster stop failed: {}", stderr));
    }

    local_runtime_status(app, state, Some(input)).await
}

#[tauri::command]
async fn delete_local_runtime(
    app: AppHandle,
    state: tauri::State<'_, Arc<LocalRuntimeState>>,
    input: Option<LocalRuntimeInput>,
) -> Result<LocalRuntimeStatus, String> {
    let input = input.unwrap_or_default();
    let cfg = resolve_runtime_config(&app, &input)?;

    let had_managed = {
        let mut guard = state.api_server.lock().await;
        if let Some(mut handle) = guard.take() {
            let _ = handle.child.kill().await;
            true
        } else {
            false
        }
    };
    if !had_managed {
        if let Some(pid) = find_pid_listening_on_port(cfg.api_port).await {
            let _ = run_status_command(&["kill", &pid.to_string()]).await;
        }
    }

    let (ok, _stdout, stderr) =
        run_status_command(&["k3d", "cluster", "delete", &cfg.cluster_name]).await?;
    if !ok && !stderr.contains("not found") {
        return Err(format!("k3d cluster delete failed: {}", stderr));
    }

    // Forget the registered cluster + keychain entry; the data dir is
    // left alone (the user can wipe it manually if they want to start
    // fully fresh — we treat it as their data, like Docker volumes).
    unregister_local_runtime_cluster(&app, &cfg.api_server_url).map_err(|e| e.to_string())?;

    local_runtime_status(app, state, Some(input)).await
}

// --- kubectl-driven workloads & logs --------------------------------

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct LocalWorkloads {
    deployments: Vec<DeploymentInfo>,
    pods: Vec<PodInfo>,
    services: Vec<ServiceInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeploymentInfo {
    name: String,
    image: Option<String>,
    desired: i64,
    ready: i64,
    available: i64,
    created_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PodInfo {
    name: String,
    phase: String,
    ready: bool,
    restart_count: i64,
    container_image: Option<String>,
    created_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceInfo {
    name: String,
    service_type: String,
    cluster_ip: Option<String>,
    node_port: Option<i64>,
    target_port: Option<i64>,
}

fn kube_context(cluster_name: &str) -> String {
    // k3d prefixes contexts with `k3d-`.
    format!("k3d-{}", cluster_name)
}

#[tauri::command]
async fn list_local_workloads(
    app: AppHandle,
    input: Option<LocalRuntimeInput>,
) -> Result<LocalWorkloads, String> {
    let input = input.unwrap_or_default();
    let cfg = resolve_runtime_config(&app, &input)?;
    let ctx = kube_context(&cfg.cluster_name);

    let (ok, stdout, stderr) = run_status_command(&[
        "kubectl",
        "--context",
        &ctx,
        "-n",
        &cfg.namespace,
        "get",
        "deploy,pod,svc",
        "-o",
        "json",
    ])
    .await?;
    if !ok {
        // Namespace-not-found shows up as a "NotFound" error. Treat
        // that as "no workloads yet" so the UI doesn't flash an error
        // before the user has deployed anything.
        if stderr.contains("(NotFound)") || stderr.contains("not found") {
            return Ok(LocalWorkloads::default());
        }
        return Err(format!("kubectl get failed: {}", stderr));
    }

    let parsed: serde_json::Value = serde_json::from_str(&stdout).map_err(|e| e.to_string())?;
    let mut out = LocalWorkloads::default();
    if let Some(items) = parsed.get("items").and_then(|i| i.as_array()) {
        for item in items {
            let kind = item.get("kind").and_then(|k| k.as_str()).unwrap_or("");
            let name = item
                .pointer("/metadata/name")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            let created_at = item
                .pointer("/metadata/creationTimestamp")
                .and_then(|t| t.as_str())
                .map(String::from);
            match kind {
                "Deployment" => {
                    let image = item
                        .pointer("/spec/template/spec/containers/0/image")
                        .and_then(|i| i.as_str())
                        .map(String::from);
                    let desired = item.pointer("/spec/replicas").and_then(|n| n.as_i64()).unwrap_or(0);
                    let ready = item
                        .pointer("/status/readyReplicas")
                        .and_then(|n| n.as_i64())
                        .unwrap_or(0);
                    let available = item
                        .pointer("/status/availableReplicas")
                        .and_then(|n| n.as_i64())
                        .unwrap_or(0);
                    out.deployments.push(DeploymentInfo {
                        name,
                        image,
                        desired,
                        ready,
                        available,
                        created_at,
                    });
                }
                "Pod" => {
                    let phase = item
                        .pointer("/status/phase")
                        .and_then(|p| p.as_str())
                        .unwrap_or("Unknown")
                        .to_string();
                    let container_image = item
                        .pointer("/spec/containers/0/image")
                        .and_then(|i| i.as_str())
                        .map(String::from);
                    let (ready, restart_count) = item
                        .pointer("/status/containerStatuses")
                        .and_then(|cs| cs.as_array())
                        .map(|arr| {
                            let ready = arr.iter().all(|c| c.get("ready").and_then(|r| r.as_bool()).unwrap_or(false));
                            let restarts = arr
                                .iter()
                                .map(|c| c.get("restartCount").and_then(|r| r.as_i64()).unwrap_or(0))
                                .sum::<i64>();
                            (ready, restarts)
                        })
                        .unwrap_or((false, 0));
                    out.pods.push(PodInfo {
                        name,
                        phase,
                        ready,
                        restart_count,
                        container_image,
                        created_at,
                    });
                }
                "Service" => {
                    let service_type = item
                        .pointer("/spec/type")
                        .and_then(|t| t.as_str())
                        .unwrap_or("ClusterIP")
                        .to_string();
                    let cluster_ip = item
                        .pointer("/spec/clusterIP")
                        .and_then(|i| i.as_str())
                        .map(String::from);
                    let ports = item.pointer("/spec/ports").and_then(|p| p.as_array()).cloned().unwrap_or_default();
                    let first_port = ports.first();
                    let node_port = first_port.and_then(|p| p.get("nodePort")).and_then(|n| n.as_i64());
                    let target_port = first_port
                        .and_then(|p| p.get("targetPort"))
                        .and_then(|n| n.as_i64());
                    out.services.push(ServiceInfo {
                        name,
                        service_type,
                        cluster_ip,
                        node_port,
                        target_port,
                    });
                }
                _ => {}
            }
        }
    }
    Ok(out)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PodLogsInput {
    pod_name: String,
    #[serde(default)]
    container: Option<String>,
    #[serde(default)]
    tail_lines: Option<i64>,
    #[serde(default)]
    cluster_name: Option<String>,
    #[serde(default)]
    namespace: Option<String>,
}

#[tauri::command]
async fn tail_local_pod_logs(
    app: AppHandle,
    input: PodLogsInput,
) -> Result<String, String> {
    let runtime_input = LocalRuntimeInput {
        cluster_name: input.cluster_name.clone(),
        namespace: input.namespace.clone(),
        ..Default::default()
    };
    let cfg = resolve_runtime_config(&app, &runtime_input)?;
    let ctx = kube_context(&cfg.cluster_name);
    let tail = input.tail_lines.unwrap_or(200).to_string();
    let mut args: Vec<&str> = vec![
        "kubectl",
        "--context",
        &ctx,
        "-n",
        &cfg.namespace,
        "logs",
        &input.pod_name,
        "--tail",
        &tail,
    ];
    if let Some(c) = input.container.as_deref() {
        args.push("-c");
        args.push(c);
    }
    let (ok, stdout, stderr) = run_status_command(&args).await?;
    if !ok {
        return Err(format!("kubectl logs failed: {}", stderr));
    }
    Ok(stdout)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Arc::new(LocalRuntimeState::default()))
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
            delete_local_cluster,
            local_runtime_status,
            start_local_runtime,
            stop_local_runtime,
            delete_local_runtime,
            list_local_workloads,
            tail_local_pod_logs
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
