use std::fs;
use std::path::PathBuf;
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

// Keychain service + account identifiers. Service is shared across
// all Appliance Desktop installs on the machine; the account label
// is stable and host-config-agnostic, which means one keychain
// entry per user on the OS — enough for v1 (single-cluster shell).
// Multi-cluster shell support would key on cluster ID here.
const KEYCHAIN_SERVICE: &str = "sh.appliance.desktop";
const KEYCHAIN_ACCOUNT: &str = "api-key";
const CONFIG_FILE: &str = "config.json";

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostConfig {
    api_server_url: Option<String>,
    api_key: Option<ApiKey>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistedConfig {
    api_server_url: Option<String>,
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

fn keychain_entry() -> Result<keyring::Entry, HostError> {
    Ok(keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)?)
}

#[tauri::command]
fn get_config(app: AppHandle) -> Result<HostConfig, HostError> {
    let persisted = read_persisted_config(&app)?;
    let api_key = keychain_entry()
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .and_then(|raw| serde_json::from_str::<ApiKey>(&raw).ok());
    Ok(HostConfig {
        api_server_url: persisted.api_server_url,
        api_key,
    })
}

#[tauri::command]
fn save_api_server_url(app: AppHandle, url: String) -> Result<(), HostError> {
    let mut cfg = read_persisted_config(&app)?;
    cfg.api_server_url = Some(url);
    write_persisted_config(&app, &cfg)
}

#[tauri::command]
fn save_api_key(id: String, secret: String) -> Result<(), HostError> {
    let entry = keychain_entry()?;
    let payload = serde_json::to_string(&ApiKey { id, secret })?;
    entry.set_password(&payload)?;
    Ok(())
}

#[tauri::command]
fn clear_api_key() -> Result<(), HostError> {
    let entry = keychain_entry()?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        // Idempotent: missing entry is fine.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[tauri::command]
fn disconnect(app: AppHandle) -> Result<(), HostError> {
    // Clear keychain entry (idempotent).
    if let Ok(entry) = keychain_entry() {
        let _ = entry.delete_credential();
    }
    // Clear api_server_url from the persisted config.
    let mut cfg = read_persisted_config(&app)?;
    cfg.api_server_url = None;
    write_persisted_config(&app, &cfg)
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
            save_api_server_url,
            save_api_key,
            clear_api_key,
            disconnect,
            run_bootstrap
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
