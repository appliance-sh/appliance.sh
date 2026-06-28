mod terminal;

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
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
    // Key id last copied into the keychain from the shared profile.
    // Only set on CLI-managed adoptions (the microVM cluster): it
    // lets the recurring sync detect a CLI re-key by comparing files,
    // without a keychain read — which macOS gates behind an access
    // prompt when the binary's signing identity changed (every dev
    // rebuild).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    synced_key_id: Option<String>,
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

#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
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
        // An entry that survived the retain above is CLI-owned (e.g.
        // the microVM engine's profile, written by `appliance vm up`).
        // The desktop adopts such clusters via sync, never the other
        // way: writing here would clobber a CLI re-key with whatever
        // stale copy the keychain holds.
        if file.profiles.contains_key(&cluster.id) {
            continue;
        }
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

// ============================================================
// Single-source-of-truth migration (stage 1: non-destructive seed)
//
// GOAL: make ~/.appliance/profiles.json the authoritative store for
// every desktop cluster's secret and turn the macOS keychain into a
// one-way derived cache (read FROM profiles.json, written TO keychain).
//
// Before we can flip the read direction, every secret that currently
// lives ONLY in the keychain (desktop-managed clusters created before
// this change, where mirror_to_shared_profiles wrote the metadata but
// an older build never copied the secret, or where the shared entry's
// secret was cleared) must be copied into profiles.json. Otherwise
// flipping the read to source from profiles.json would surface an
// empty secret and silently break the cluster.
//
// This is the SEED step. It is:
//   * non-destructive — it only ever WRITES into profiles.json; it
//     never deletes or overwrites a keychain entry, and never clears
//     a secret;
//   * authoritative-preserving — it refuses to overwrite a non-empty
//     secret already in profiles.json (that copy is, by definition,
//     the authoritative one once this lands);
//   * idempotent — re-running it once everything is seeded is a no-op.
// ============================================================

/// Outcome of evaluating one cluster for the keychain→profiles.json
/// seed. Pure data so the decision can be unit-tested without touching
/// the real keychain.
#[derive(Debug, PartialEq)]
enum SeedDecision {
    /// profiles.json already holds a non-empty secret for this id (it
    /// is authoritative) — leave it untouched.
    AlreadySeeded,
    /// No secret anywhere we can see (keychain miss and no shared
    /// secret) — nothing to copy; metadata, if any, stays as-is.
    NothingToSeed,
    /// The keychain held the only copy — fold it into profiles.json.
    /// Carries the entry that should be written for `cluster_id`.
    Seed {
        cluster_id: String,
        entry: SharedProfileEntry,
    },
}

/// Decide whether a single desktop cluster's keychain secret needs
/// seeding into profiles.json. Pure: all IO (keychain + file reads) is
/// resolved by the caller and passed in.
///
/// * `cluster` — the desktop's in-memory record (metadata source).
/// * `keychain_key` — what `read_api_key(cluster:<id>)` returned, or
///   `None` if the keychain has no entry / it was unreadable.
/// * `existing` — the current profiles.json entry for this id, if any.
fn decide_seed(
    cluster: &Cluster,
    keychain_key: Option<&ApiKey>,
    existing: Option<&SharedProfileEntry>,
) -> SeedDecision {
    // An existing non-empty shared secret is authoritative — never
    // clobber it from the (now derived) keychain. This is the
    // idempotency guard: once seeded, every later run lands here.
    if let Some(entry) = existing {
        if !entry.secret.is_empty() && !entry.key_id.is_empty() {
            return SeedDecision::AlreadySeeded;
        }
    }

    let Some(key) = keychain_key else {
        // Secret lives nowhere we can read it. Don't fabricate an
        // empty entry; leave whatever metadata exists alone.
        return SeedDecision::NothingToSeed;
    };
    if key.secret.is_empty() || key.id.is_empty() {
        return SeedDecision::NothingToSeed;
    }

    // Carry forward any metadata the shared entry already had (e.g. a
    // CLI-written `managed`/`name`) so the seed only fills in the
    // missing secret without rewriting unrelated fields. Default the
    // surface marker to "desktop" since that's the only producer that
    // stored a secret solely in the keychain.
    let prev = existing.cloned().unwrap_or_default();
    SeedDecision::Seed {
        cluster_id: cluster.id.clone(),
        entry: SharedProfileEntry {
            api_url: if prev.api_url.is_empty() {
                cluster.api_server_url.clone()
            } else {
                prev.api_url
            },
            key_id: key.id.clone(),
            secret: key.secret.clone(),
            created_at: prev.created_at.or_else(|| Some(cluster.created_at.clone())),
            state_backend_url: prev.state_backend_url.or_else(|| cluster.state_backend_url.clone()),
            last_bootstrap_input: prev
                .last_bootstrap_input
                .or_else(|| cluster.last_bootstrap_input.clone()),
            managed: prev.managed.or_else(|| Some("desktop".to_string())),
            name: prev.name.or_else(|| Some(cluster.name.clone())),
        },
    }
}

/// Stage-1 seed: for every desktop cluster whose secret currently
/// exists ONLY in the keychain, copy it into profiles.json once. Reads
/// each cluster's secret from the keychain and applies `decide_seed`.
///
/// Returns the number of entries newly seeded (0 ⇒ nothing changed, so
/// no write is needed). The shared file is only rewritten when at least
/// one entry was seeded, keeping the steady-state path write-free.
///
/// SAFETY: this only ADDS secrets to profiles.json — it never removes
/// a keychain entry and never overwrites an existing non-empty shared
/// secret, so no secret can be lost by running it. Hold `config_lock`
/// across the call (as the sync path does) so the read-modify-write of
/// profiles.json doesn't interleave with another desktop write.
fn seed_profiles_from_keychain(cfg: &PersistedConfig) -> Result<usize, HostError> {
    let mut file = read_shared_profiles().unwrap_or_default();
    let mut seeded = 0usize;
    for cluster in &cfg.clusters {
        let keychain_key = read_api_key(&cluster_keychain_account(&cluster.id));
        let existing = file.profiles.get(&cluster.id);
        match decide_seed(cluster, keychain_key.as_ref(), existing) {
            SeedDecision::Seed { cluster_id, entry } => {
                file.profiles.insert(cluster_id, entry);
                seeded += 1;
            }
            SeedDecision::AlreadySeeded | SeedDecision::NothingToSeed => {}
        }
    }
    if seeded > 0 {
        write_shared_profiles(&file)?;
    }
    Ok(seeded)
}

/// Launch-time entry point for the stage-1 seed. Reads the desktop's
/// persisted clusters and folds any keychain-only secret into
/// profiles.json. Takes `config_lock` for the read-modify-write so it
/// can't interleave with a concurrent desktop write (e.g. the microVM
/// sync that runs right after). Cross-PROCESS interleaving with the
/// CLI is still possible — see the concurrency note on `config_lock`.
fn seed_desktop_profiles(app: &AppHandle) -> Result<usize, HostError> {
    let _guard = config_lock();
    let persisted = read_persisted_config(app)?;
    seed_profiles_from_keychain(&persisted)
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
            // The keychain copy below comes from this very entry.
            synced_key_id: Some(entry.key_id.clone()),
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

/// Serializes every read-modify-write of the persisted config.
/// Multiple surfaces touch config.json concurrently — frontend
/// commands (get_config's legacy migration, cluster CRUD) and
/// background work (the launch-time seed + microVM sync) — and an
/// unguarded interleaving lets a later write clobber an earlier one
/// with stale state. Take this for the full read→mutate→write span.
///
/// SCOPE: this guards in-PROCESS races only (it's a process-global
/// Mutex). It does NOT serialize against the CLI, which is a separate
/// process that performs its own read-modify-write of profiles.json
/// (e.g. `appliance keys rotate`). A cross-process advisory file lock
/// around profiles.json is the remaining piece of stage-3 concurrency
/// safety — see docs/credentials.md. Until then the window is small
/// (both sides do atomic temp-file renames, so neither can read a
/// half-written file; the risk is purely last-writer-wins on
/// interleaved full read→write cycles).
fn config_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
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
    let mut migrated = migrate_legacy_top_level_url(cfg)?;
    migrated |= migrate_legacy_local_runtime_urls(cfg);
    if migrated {
        write_persisted_config(app, cfg)?;
    }
    Ok(migrated)
}

/// Original field-shape migration: top-level `api_server_url` →
/// `clusters[]` entry. Runs once per upgrade from the pre-clusters
/// era.
fn migrate_legacy_top_level_url(cfg: &mut PersistedConfig) -> Result<bool, HostError> {
    if !cfg.clusters.is_empty() {
        // Already migrated. Drop the legacy field if it lingered.
        return Ok(cfg.api_server_url.take().is_some());
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
        synced_key_id: None,
    };

    write_api_key(&cluster_keychain_account(&id), &legacy_key)?;
    delete_api_key(LEGACY_KEYCHAIN_ACCOUNT);
    cfg.clusters.push(cluster);
    cfg.selected_cluster_id = Some(id);
    Ok(true)
}

/// Phase-4 URL-shape migration. Pre-Phase-4 desktops registered the
/// Local Runtime cluster with `http://localhost:<api_port>` because
/// api-server ran as a host-side child process. Phase 4 moves
/// api-server in-cluster and re-derives the URL as
/// `http://api.appliance.localhost:<host_port>`. Without this fixup a
/// post-upgrade lookup of the legacy `local-runtime` cluster against
/// the new URL would come up empty and risk a duplicate registration.
/// Rewriting in place keeps the cluster id (so the keychain entry
/// survives) and lets the freshly in-cluster api-server pick up the
/// existing API key the moment it's reachable.
fn migrate_legacy_local_runtime_urls(cfg: &mut PersistedConfig) -> bool {
    let new_url = format!("http://{}:{}", IN_CLUSTER_API_SERVER_HOSTNAME, DEFAULT_LOCAL_HOST_PORT);
    let mut migrated = false;
    for cluster in &mut cfg.clusters {
        if cluster.id != LOCAL_RUNTIME_CLUSTER_ID {
            continue;
        }
        if is_pre_phase4_local_runtime_url(&cluster.api_server_url) {
            cluster.api_server_url = new_url.clone();
            migrated = true;
        }
    }
    migrated
}

fn is_pre_phase4_local_runtime_url(url: &str) -> bool {
    // Pre-Phase-4 default port was DEFAULT_LOCAL_API_PORT (3030) but
    // users could override via LocalRuntimeInput.api_port to anything;
    // matching the host (localhost / 127.0.0.1) is the discriminator
    // that catches the legacy shape without false-positiving on the
    // new `api.appliance.localhost` form.
    let stripped = url.strip_prefix("http://").unwrap_or(url);
    stripped.starts_with("localhost:") || stripped.starts_with("127.0.0.1:")
}

fn derive_name_from_url(url: &str) -> String {
    // Strip scheme + path so the cluster shows a recognisable hostname.
    let without_scheme = url.split("://").nth(1).unwrap_or(url);
    let host = without_scheme.split('/').next().unwrap_or(without_scheme);
    host.strip_prefix("api.").unwrap_or(host).to_string()
}

#[tauri::command]
fn get_config(app: AppHandle) -> Result<HostConfig, HostError> {
    let _guard = config_lock();
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
    let _guard = config_lock();
    let mut persisted = read_persisted_config(&app)?;
    migrate_legacy(&app, &mut persisted)?;

    let cluster = Cluster {
        id: uuid::Uuid::new_v4().to_string(),
        name: input.name,
        api_server_url: input.api_server_url,
        created_at: chrono::Utc::now().to_rfc3339(),
        synced_key_id: None,
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
    let _guard = config_lock();
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
    let _guard = config_lock();
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
    let _guard = config_lock();
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
                } else {
                    name.strip_prefix("profile ").map(|rest| rest.trim().to_string())
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
        .map_err(|e| {
            // The Node sidecar drives the AWS bootstrap path (Pulumi
            // automation), which still needs a system Node. Day-to-day
            // local-runtime use no longer touches this code path —
            // the helper-install flow uses the Bun-compiled CLI
            // directly. So this error is only surfaced when an
            // operator runs the bootstrap wizard without Node.
            if e.kind() == std::io::ErrorKind::NotFound {
                "Node.js is not installed or not on PATH. The AWS bootstrap flow requires Node — \
install it from https://nodejs.org/ (or `brew install node`) and retry. The Local Runtime page \
doesn't need Node and should work without this dependency."
                    .to_string()
            } else {
                format!("failed to spawn node sidecar: {}", e)
            }
        })?;

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

/// Drive a helper-install by spawning the bundled, statically-linked
/// `appliance` CLI binary with `local install --json`.
///
/// The binary is registered as a Tauri externalBin (see tauri.conf
/// `bundle.externalBin`) and resolved here via tauri-plugin-shell's
/// `sidecar` API. The same binary is also published as a GitHub
/// Release asset by `.github/workflows/release-cli-binaries.yml`
/// for standalone CLI users; the desktop ships its own copy so the
/// first-start flow doesn't depend on a network download.
///
/// The CLI emits NDJSON: one JSON object per stdout line, with a
/// final `{type: "result", result: {outcomes: [...]}}`. Progress
/// lines flow through `on_event` so the UI can render live status.
/// Because the CLI is a Bun-compiled binary with no runtime
/// dependencies, this works on a fresh user's machine without Node
/// or any other runtime — the original bootstrap deadlock is gone.
#[tauri::command]
async fn local_helper_install(
    app: AppHandle,
    input: serde_json::Value,
    on_event: Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let payload = match input {
        serde_json::Value::Object(map) => map,
        serde_json::Value::Null => serde_json::Map::new(),
        other => return Err(format!("local_helper_install expected an object input, got: {}", other)),
    };

    let force = payload.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
    let tools: Vec<String> = match payload.get("tools") {
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect(),
        Some(serde_json::Value::Null) | None => Vec::new(),
        Some(other) => return Err(format!("`tools` must be an array of strings, got: {}", other)),
    };

    let mut args: Vec<String> = vec!["local".into(), "install".into()];
    for t in &tools {
        args.push(t.clone());
    }
    if force {
        args.push("--force".into());
    }
    args.push("--json".into());

    let sidecar = app
        .shell()
        .sidecar("appliance")
        .map_err(|e| {
            format!(
                "Bundled appliance CLI is unavailable: {e}. Rebuild with `pnpm --filter @appliance.sh/desktop build` so the CLI binary lands in src-tauri/binaries/."
            )
        })?
        .args(&args);

    let (mut rx, _child) = sidecar
        .spawn()
        .map_err(|e| format!("failed to spawn appliance CLI: {e}"))?;

    let mut final_outcomes: Option<serde_json::Value> = None;
    let mut error: Option<String> = None;
    let mut exit_code: Option<i32> = None;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                handle_cli_line(&bytes, &on_event, &mut final_outcomes, &mut error);
            }
            CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim().to_string();
                if !line.is_empty() {
                    let _ = on_event.send(serde_json::json!({
                        "type": "log",
                        "level": "info",
                        "message": line,
                    }));
                }
            }
            CommandEvent::Error(msg) => {
                error = Some(msg);
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
            }
            _ => {}
        }
    }

    if let Some(msg) = error {
        return Err(msg);
    }
    let outcomes = final_outcomes.unwrap_or_else(|| {
        if exit_code.map(|c| c != 0).unwrap_or(true) {
            serde_json::json!([{
                "tool": "cli",
                "status": "failed",
                "message": format!(
                    "appliance CLI exited with code {}",
                    exit_code.map_or_else(|| "?".to_string(), |c| c.to_string()),
                ),
            }])
        } else {
            serde_json::json!([])
        }
    });

    Ok(serde_json::json!({ "outcomes": outcomes }))
}

/// Parse one line of CLI stdout. Most lines are NDJSON; anything that
/// fails to parse is forwarded as a log event so we don't drop output
/// (e.g. if chalk color codes ever leak through despite --json).
fn handle_cli_line(
    bytes: &[u8],
    on_event: &Channel<serde_json::Value>,
    final_outcomes: &mut Option<serde_json::Value>,
    error: &mut Option<String>,
) {
    let line = String::from_utf8_lossy(bytes);
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    let parsed: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => {
            let _ = on_event.send(serde_json::json!({
                "type": "log",
                "level": "info",
                "message": trimmed,
            }));
            return;
        }
    };
    let kind = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "result" => {
            *final_outcomes = parsed.get("result").and_then(|r| r.get("outcomes")).cloned();
        }
        "error" => {
            *error = parsed.get("error").and_then(|v| v.as_str()).map(|s| s.to_string());
        }
        _ => {
            let _ = on_event.send(parsed);
        }
    }
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

// Default cluster name + namespace the desktop's runtime-config
// resolution falls back to. `appliance-local` doubles as the
// "unset cluster name" sentinel kube_target_args maps to the
// canonical microVM. Must match DEFAULT_LOCAL_CLUSTER_NAME in
// `packages/infra/src/lib/local/LocalContainerDeploymentService.ts`.
const DEFAULT_LOCAL_CLUSTER_NAME: &str = "appliance-local";
const DEFAULT_LOCAL_NAMESPACE: &str = "appliance";
const DEFAULT_LOCAL_HOST_PORT: u16 = 8081;
// Stable cluster id == profile name used by the CLI's `--profile`
// flag and the shared profiles.json key. Survives as the id the
// pre-Phase-4 URL migration rewrites in place.
const LOCAL_RUNTIME_CLUSTER_ID: &str = "local-runtime";
const MICROVM_CLUSTER_NAME: &str = "MicroVM Runtime";
// Mirrors MICROVM_PROFILE in packages/cli/src/appliance-vm.ts — the
// CLI's `vm up` writes this profile; the desktop adopts it as a
// cluster with the same stable id.
const MICROVM_CLUSTER_ID: &str = "microvm";

// Tools the local-runtime path shells out to. Centralised so preflight
// + spawn error mapping stay in sync — if one of these is renamed or a
// new one is added (e.g. `crane`), everything downstream picks it up.
//
// `auto_installable` mirrors the `Provider.autoInstallable` flag in
// `@appliance.sh/helper`. The UI uses it to decide whether to render
// an Install button vs. fall back to copy-paste guidance. Stays in
// lockstep with the helper's provider definitions.
struct PrereqTool {
    name: &'static str,
    purpose: &'static str,
    // Argv to print a version banner. Tool-specific: kubectl predates
    // `--version` and only accepts `version --client`.
    version_args: &'static [&'static str],
    auto_installable: bool,
}

const LOCAL_PREREQS: &[PrereqTool] = &[
    PrereqTool {
        name: "docker",
        purpose: "Container runtime Appliance shells out to for `docker build` / `docker save`.",
        version_args: &["--version"],
        // Container runtimes are an OS-level install (kernel
        // features, privileged daemon, GUI on macOS); we can't ship
        // one, so guidance-only.
        auto_installable: false,
    },
    PrereqTool {
        name: "kubectl",
        purpose: "Used to read Deployments / Services / pod logs from the microVM.",
        version_args: &["version", "--client"],
        auto_installable: true,
    },
];

/// Per-OS install command for a prerequisite. Surfaced to the UI so
/// the user can copy-paste a working install line for their platform
/// instead of hunting through docs after seeing a spawn error.
fn install_hint(tool: &str) -> &'static str {
    if cfg!(target_os = "macos") {
        match tool {
            "docker" => "Install any container runtime (Docker Desktop, OrbStack, Colima, Rancher Desktop). https://www.docker.com/products/docker-desktop/ — https://orbstack.dev — https://github.com/abiosoft/colima",
            "kubectl" => "brew install kubectl",
            _ => "",
        }
    } else if cfg!(target_os = "linux") {
        match tool {
            "docker" => "Install any container runtime (Docker Engine, Podman, Rancher Desktop). Docker Engine: curl -fsSL https://get.docker.com | sh",
            "kubectl" => "curl -LO https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl && sudo install -m 0755 kubectl /usr/local/bin/kubectl",
            _ => "",
        }
    } else if cfg!(target_os = "windows") {
        match tool {
            "docker" => "Install any container runtime (Docker Desktop, Rancher Desktop, Podman Desktop). https://www.docker.com/products/docker-desktop/",
            "kubectl" => "winget install Kubernetes.kubectl",
            _ => "",
        }
    } else {
        ""
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PreflightCheck {
    /// Tool name as invoked on the command line (`docker`, `kubectl`, …).
    tool: String,
    /// True when the tool resolved on PATH and `<tool> --version` exited 0.
    installed: bool,
    /// First non-empty line of stdout from `<tool> --version`. Useful for
    /// confirming compatibility (e.g. older tool versions miss flags).
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    /// One-line human description of what this tool is used for.
    purpose: String,
    /// Platform-appropriate install command. Empty on unsupported OSes.
    install_hint: String,
    /// True when `appliance local install <tool>` can ship a working
    /// binary without manual steps. Drives whether the UI shows an
    /// Install button vs. only the copy-paste hint.
    auto_installable: bool,
    /// stderr captured when the version check itself failed (e.g. docker
    /// daemon not running for `docker version`). Lets the UI distinguish
    /// "not installed" from "installed but broken".
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// For docker only: whether a daemon is actually *reachable*, not
    /// just whether the CLI is installed. `None` for tools where daemon
    /// state is meaningless (kubectl), so the UI only special-cases
    /// docker. A `Some(false)` here is "installed but not running".
    #[serde(skip_serializing_if = "Option::is_none")]
    daemon_running: Option<bool>,
    /// For docker only, meaningful when `daemon_running` is `Some(false)`:
    /// whether appliance can start the runtime itself (colima is the
    /// active runtime). Drives a "Start runtime" button vs. manual-start
    /// guidance in the doctor view.
    #[serde(skip_serializing_if = "Option::is_none")]
    daemon_startable: Option<bool>,
}

/// Probe each required CLI tool with `--version`. Designed to never
/// fail the call itself — every tool returns a structured record the UI
/// can render even when nothing is installed, so users can copy the
/// install commands without first hitting a cryptic spawn error.
#[tauri::command]
async fn local_preflight() -> Vec<PreflightCheck> {
    let mut out = Vec::with_capacity(LOCAL_PREREQS.len());
    for tool in LOCAL_PREREQS {
        let mut check = probe_tool(tool).await;
        // Docker is special: `--version` only proves the CLI exists, not
        // that a daemon is reachable. Probe the daemon too so the doctor
        // view can show "installed but not running" (and offer to start
        // it) instead of a misleading green check followed by a failed
        // Start. kubectl has no daemon, so leave its fields None.
        if tool.name == "docker" && check.installed {
            let reachable = docker_daemon_reachable().await;
            check.daemon_running = Some(reachable);
            if !reachable {
                let startable = colima_is_active_runtime().await;
                check.daemon_startable = Some(startable);
                check.error = Some(if startable {
                    "Docker is installed but its colima VM isn't running.".to_string()
                } else {
                    docker_unreachable_hint()
                });
            }
        }
        out.push(check);
    }
    out
}

async fn probe_tool(tool: &PrereqTool) -> PreflightCheck {
    let probe = Command::new(tool.name).args(tool.version_args).output().await;
    match probe {
        Ok(output) if output.status.success() => {
            let line = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            PreflightCheck {
                tool: tool.name.to_string(),
                installed: true,
                version: line,
                purpose: tool.purpose.to_string(),
                install_hint: install_hint(tool.name).to_string(),
                auto_installable: tool.auto_installable,
                error: None,
                daemon_running: None,
                daemon_startable: None,
            }
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let (hint, error) =
                resolve_missing_hint(tool.name, if stderr.is_empty() { None } else { Some(stderr) }).await;
            PreflightCheck {
                tool: tool.name.to_string(),
                installed: false,
                version: None,
                purpose: tool.purpose.to_string(),
                install_hint: hint,
                auto_installable: tool.auto_installable,
                error,
                daemon_running: None,
                daemon_startable: None,
            }
        }
        Err(err) => {
            let raw = if err.kind() == std::io::ErrorKind::NotFound {
                "not on PATH".to_string()
            } else {
                err.to_string()
            };
            let (hint, error) = resolve_missing_hint(tool.name, Some(raw)).await;
            PreflightCheck {
                tool: tool.name.to_string(),
                installed: false,
                version: None,
                purpose: tool.purpose.to_string(),
                install_hint: hint,
                auto_installable: tool.auto_installable,
                error,
                daemon_running: None,
                daemon_startable: None,
            }
        }
    }
}

/// Customise the install hint for a missing tool when an adjacent
/// runtime is already on PATH. Appliance shells out to the `docker`
/// CLI specifically, so a Colima- or Podman-only setup looks like
/// "I have a runtime" to the user but trips us up. Detect those and
/// turn the generic "install a runtime" hint into one targeted line:
///
///   * Colima present → `brew install docker` (Colima is the daemon;
///     the user just needs the matching CLI client).
///   * Podman present → suggest podman-mac-helper / aliasing (Podman
///     ships its own CLI; bridging it to `docker` gives Appliance what
///     it needs).
///
/// Returns `(install_hint, error_message)`.
async fn resolve_missing_hint(tool: &str, raw_error: Option<String>) -> (String, Option<String>) {
    if tool != "docker" {
        return (install_hint(tool).to_string(), raw_error);
    }
    if which_succeeds("colima").await {
        let hint =
            "brew install docker  # Colima is already on PATH; this adds the matching `docker` CLI client.".to_string();
        let note = "Colima is installed but Appliance needs the `docker` CLI (it shells out to `docker build` / `docker save`). Install the client alongside the runtime."
            .to_string();
        return (hint, merge_note(raw_error, note));
    }
    if which_succeeds("podman").await {
        let hint = if cfg!(target_os = "macos") {
            "brew install podman-mac-helper && sudo podman-mac-helper install  # exposes Podman as a `docker`-compatible socket+CLI".to_string()
        } else {
            "Install the `podman-docker` package, or alias `docker` to `podman`".to_string()
        };
        let note = "Podman is installed but Appliance shells out to the `docker` CLI. Bridge them via podman-docker / an alias and retry."
            .to_string();
        return (hint, merge_note(raw_error, note));
    }
    (install_hint(tool).to_string(), raw_error)
}

async fn which_succeeds(cmd: &str) -> bool {
    Command::new(cmd)
        .arg("--version")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn merge_note(raw: Option<String>, note: String) -> Option<String> {
    match raw {
        Some(prev) if !prev.is_empty() => Some(format!("{note} ({prev})")),
        _ => Some(note),
    }
}

/// Wrap a spawn error in an actionable, installer-aware message when the
/// underlying OS error is "command not found". Other errors pass through
/// unchanged so debugging info isn't lost.
fn map_spawn_error(tool: &str, err: std::io::Error) -> String {
    if err.kind() == std::io::ErrorKind::NotFound {
        let hint = install_hint(tool);
        if hint.is_empty() {
            format!("`{tool}` is not installed or not on PATH.")
        } else {
            format!(
                "`{tool}` is not installed or not on PATH. Install it with:\n  {hint}\nThen retry."
            )
        }
    } else {
        format!("failed to spawn {tool}: {err}")
    }
}

async fn run_status_command(args: &[&str]) -> Result<(bool, String, String), String> {
    let output = Command::new(args[0])
        .args(&args[1..])
        .output()
        .await
        .map_err(|e| map_spawn_error(args[0], e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Ok((output.status.success(), stdout, stderr))
}

// A cold colima VM boot (disk allocation, base image pull, network
// setup) can take well over a minute on first start; bound it
// generously so a genuinely wedged `colima start` still can't hang the
// caller forever, while leaving plenty of headroom for a normal boot.
const COLIMA_START_TIMEOUT_SECS: u64 = 240;

/// Probe whether a Docker daemon is actually *reachable* — distinct
/// from "the `docker` CLI is on PATH". The preflight's `docker
/// --version` only proves the client binary exists; it exits 0 even
/// when no daemon is running. `docker version --format
/// {{.Server.Version}}` forces a round-trip to the daemon, so a
/// non-zero exit here means "installed but not running" — the exact
/// state a stopped colima VM leaves the machine in.
async fn docker_daemon_reachable() -> bool {
    matches!(
        run_status_command(&["docker", "version", "--format", "{{.Server.Version}}"]).await,
        Ok((true, _, _))
    )
}

/// Docker contexts created by GUI runtimes. When any of these exist
/// alongside colima, the machine has a competing runtime that may own
/// the default socket — auto-starting colima could race or confuse
/// it, so we stay hands-off and surface guidance instead.
const GUI_RUNTIME_CONTEXTS: [&str; 3] = ["desktop-linux", "orbstack", "rancher-desktop"];

/// Whether the user has a colima VM instance (running or stopped).
/// `colima list -j` emits one JSON object per line, one per instance;
/// empty when the user never created a VM (`colima start` would then
/// build a fresh one — a bigger action than restarting the VM they
/// already had, so we don't auto-start in that case).
async fn colima_instance_exists() -> bool {
    match run_status_command(&["colima", "list", "-j"]).await {
        Ok((true, out, _)) => out.lines().filter(|l| !l.trim().is_empty()).any(|l| {
            serde_json::from_str::<serde_json::Value>(l)
                .ok()
                .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(|s| !s.is_empty()))
                .unwrap_or(false)
        }),
        _ => false,
    }
}

/// True when colima is the runtime providing Docker on this machine —
/// the guard for auto-start: we only bring colima up when the user's
/// docker is actually backed by it, never when they're on Docker
/// Desktop / OrbStack with a stray colima install sitting alongside.
///
/// Detection, in order of confidence:
///   1. `DOCKER_HOST` points at a colima socket.
///   2. The active docker context is `colima`.
///   3. The active context is `default` (a clean `colima stop` resets
///      the context, so a stopped colima looks exactly like "no
///      runtime" here), a colima VM instance exists, and no GUI
///      runtime context is present to claim the default socket
///      instead.
async fn colima_is_active_runtime() -> bool {
    if !which_succeeds("colima").await {
        return false;
    }
    if std::env::var("DOCKER_HOST")
        .map(|h| h.contains(".colima"))
        .unwrap_or(false)
    {
        return true;
    }
    let current = match run_status_command(&["docker", "context", "show"]).await {
        Ok((true, ctx, _)) => ctx.trim().to_string(),
        _ => return false,
    };
    if current == "colima" {
        return true;
    }
    if current != "default" {
        return false;
    }
    let names: Vec<String> =
        match run_status_command(&["docker", "context", "ls", "--format", "{{.Name}}"]).await {
            Ok((true, out, _)) => out
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect(),
            _ => return false,
        };
    if names.iter().any(|n| GUI_RUNTIME_CONTEXTS.contains(&n.as_str())) {
        return false;
    }
    colima_instance_exists().await
}

/// Platform-appropriate nudge for "Docker is installed but the daemon
/// isn't reachable" in the cases appliance can't safely auto-start
/// (Docker Desktop is a GUI app, system dockerd needs root). colima is
/// handled before we ever reach this, so we don't suggest it as the
/// primary fix here.
fn docker_unreachable_hint() -> String {
    if cfg!(target_os = "macos") {
        "Docker isn't running. Start your container runtime — Docker Desktop, OrbStack, or `colima start` — and retry.".to_string()
    } else if cfg!(target_os = "linux") {
        "Docker isn't running. Start it with `sudo systemctl start docker` and retry.".to_string()
    } else {
        "Docker isn't running. Start Docker Desktop and retry.".to_string()
    }
}

/// Like `run_status_command` but bounded by `timeout`. Reserved for the
/// few operations that can legitimately run for a minute-plus (booting
/// a colima VM) where a wedged invocation must not hang the caller
/// indefinitely.
async fn run_command_with_timeout(
    args: &[&str],
    timeout: Duration,
) -> Result<(bool, String, String), String> {
    match tokio::time::timeout(timeout, run_status_command(args)).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "`{}` timed out after {}s.",
            args.join(" "),
            timeout.as_secs()
        )),
    }
}

/// Bring the container runtime up if appliance can do so safely.
///
/// The `docker` provider is intentionally detect-only — we don't
/// install or boot arbitrary runtimes (Docker Desktop is a GUI app,
/// system dockerd needs root; both "fork system trust decisions").
/// Colima is the one exception worth automating: it's a userland CLI
/// the user installed themselves, and `colima start` is an ordinary
/// unprivileged, idempotent command — exactly what they'd type by
/// hand. So when Docker is unreachable *and* the CLI is wired to
/// colima, we start it for them; every other "daemon down" case
/// returns an actionable message instead of letting a cryptic
/// container-runtime timeout surface downstream.
async fn ensure_docker_running() -> Result<(), String> {
    if docker_daemon_reachable().await {
        return Ok(());
    }
    if !colima_is_active_runtime().await {
        return Err(docker_unreachable_hint());
    }
    // colima start is idempotent: a no-op if already running, boots the
    // VM otherwise.
    match run_command_with_timeout(
        &["colima", "start"],
        Duration::from_secs(COLIMA_START_TIMEOUT_SECS),
    )
    .await
    {
        Ok((true, _, _)) => {}
        Ok((false, _, stderr)) => {
            return Err(format!(
                "Docker isn't running and `colima start` failed: {}",
                stderr.trim()
            ));
        }
        Err(e) => return Err(e),
    }
    // The host-side docker socket can lag a beat behind colima
    // reporting ready while the forward is wired up, so poll briefly
    // rather than assuming reachability the instant `colima start`
    // returns.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        if docker_daemon_reachable().await {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(
                "colima started but the Docker daemon is still unreachable. Check `colima status` and `docker info`."
                    .to_string(),
            );
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// Start the container runtime (colima) on behalf of the user when
/// appliance can do so safely. Thin command wrapper over
/// `ensure_docker_running` so the doctor view's "Start runtime" button
/// and the implicit cluster-start path share one code path; the error
/// string carries actionable guidance for runtimes we can't auto-start.
#[tauri::command]
async fn start_container_runtime() -> Result<(), String> {
    ensure_docker_running().await
}

// ============================================================
// Local runtime support surface
//
// What remains after bare k3d's removal: the shared runtime-config
// resolution that the in-cluster api-server bootstrap and the
// engine-routed workload/log reads build on. The local runtime itself
// is the microVM (driven through the `vm`/microVM commands), an
// `appliance-base-kubernetes` cluster that registers like any other.
// ============================================================

/// Runtime input shared by the in-cluster bootstrap + the engine-routed
/// workload/log reads. All fields are optional and fall back to
/// baked-in defaults.
#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
struct LocalRuntimeInput {
    cluster_name: Option<String>,
    namespace: Option<String>,
    host_port: Option<u16>,
    data_dir: Option<String>,
    /// Which local engine kubectl-level reads (workloads, pod logs)
    /// address — "microvm" routes through the microVM's fetched
    /// kubeconfig. The sole local engine now that bare k3d is gone.
    engine: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ResolvedRuntimeConfig {
    cluster_name: String,
    namespace: String,
    host_port: u16,
    data_dir: String,
    api_server_url: String,
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
    let data_dir = match &input.data_dir {
        Some(p) => PathBuf::from(p),
        None => default_local_runtime_dir(app)?,
    };
    // api-server lives in-cluster behind the Ingress, reached at
    // `host_port`. URL omits the port when it's 80.
    let api_server_url = if host_port == 80 {
        format!("http://{}", IN_CLUSTER_API_SERVER_HOSTNAME)
    } else {
        format!("http://{}:{}", IN_CLUSTER_API_SERVER_HOSTNAME, host_port)
    };
    Ok(ResolvedRuntimeConfig {
        cluster_name,
        namespace,
        host_port,
        data_dir: data_dir.to_string_lossy().to_string(),
        api_server_url,
    })
}

/// Default data dir for the local runtime. Shared with the CLI:
/// `~/.appliance/local-runtime/` (same convention `appliance` already
/// uses for its credentials store + the demo script). Falling back to
/// the Tauri-managed `app_data_dir()` when $HOME is unset keeps Linux
/// CI / sandbox builds working — the only case where the env var
/// might not be set.
///
/// Migration: if the legacy `<app-config>/local-runtime/` directory
/// exists but the new one doesn't, surface a one-line warning to
/// stderr so the operator can move the data over manually. Auto-
/// migration of a multi-GB Pulumi/api-server state dir is too risky
/// to do silently.
fn default_local_runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let preferred = home_dir().map(|h| h.join(SHARED_PROFILES_DIR).join("local-runtime"));
    let legacy = app
        .path()
        .app_data_dir()
        .map(|d| d.join("local-runtime"))
        .ok();

    if let Some(preferred) = preferred {
        if let Some(legacy) = legacy.as_ref() {
            if legacy.exists() && !preferred.exists() {
                eprintln!(
                    "warn: legacy local-runtime data at {} — move it to {} to share state with the CLI",
                    legacy.display(),
                    preferred.display()
                );
            }
        }
        return Ok(preferred);
    }

    legacy.ok_or_else(|| "could not resolve a local-runtime data dir (no $HOME, no app data dir)".to_string())
}

/// Generate a short opaque token used as BOOTSTRAP_TOKEN for the
/// in-cluster api-server. Valid only for the lifetime of this
/// bootstrap call — once we mint an api key, the token is forgotten.
fn random_bootstrap_token() -> String {
    uuid::Uuid::new_v4().to_string().replace('-', "")
}

// ============================================================
// In-cluster api-server bootstrap
//
// Generates and applies the manifests that run api-server *inside*
// the cluster — Deployment + Service + Ingress, plus a
// ServiceAccount/Role bound to the appliance namespace so the
// in-cluster api-server can drive deploys against itself via
// loadFromCluster(). The same image works against any kubernetes
// cluster; here it's pulled from the cluster-attached registry.
//
// This is the model for `appliance-base-kubernetes`: a Tauri command
// the frontend invokes against a reachable cluster (the microVM passes
// its fetched kubeconfig), independent of any host-side runtime
// lifecycle.
// ============================================================

const IN_CLUSTER_API_SERVER_NAMESPACE: &str = "appliance-system";
const IN_CLUSTER_API_SERVER_NAME: &str = "api-server";
const IN_CLUSTER_API_SERVER_HOSTNAME: &str = "api.appliance.localhost";
const IN_CLUSTER_API_SERVER_PORT: u16 = 3000;
// Default api-server image. Cluster pulls this directly from ghcr
// on first deploy; subsequent pod restarts reuse the cached image
// thanks to `imagePullPolicy: IfNotPresent`. Override via the
// `image` field on `BootstrapInClusterInput` for local dev iteration
// (build → push to <registry_url>/appliance-api-server:<tag>, pass
// that ref through). The tag tracks the SDK release stream — bump
// in lockstep with packages/sdk's published version.
const IN_CLUSTER_API_SERVER_DEFAULT_IMAGE: &str = "ghcr.io/appliance-sh/api-server:latest";

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct BootstrapInClusterInput {
    /// Override the runtime input that resolves cluster name, data
    /// dir, namespace, host port, etc. Defaults to the baked-in
    /// runtime-config defaults.
    runtime: Option<LocalRuntimeInput>,
    /// Override the api-server image reference. Defaults to
    /// `ghcr.io/appliance-sh/api-server:latest` (cluster pulls from
    /// ghcr on first deploy, caches thereafter). For local dev
    /// iteration build the image and push to
    /// `<registry_url>/appliance-api-server:<tag>`, then pass that
    /// ref through here so the cluster pulls from the local
    /// registry mirror instead.
    image: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BootstrapInClusterResult {
    /// Hostname the in-cluster api-server is reachable at. Always
    /// goes through the cluster's Ingress so the URL is identical
    /// across local + remote deploys of the same image.
    api_server_url: String,
    /// API key minted via the bootstrap token. Caller persists this
    /// alongside the cluster registration so the SDK can sign
    /// subsequent requests.
    api_key: ApiKey,
}

/// Build the JSON `APPLIANCE_BASE_CONFIG` env value for the in-cluster
/// api-server. Uses the new `appliance-base-kubernetes` variant — the
/// in-cluster api-server authenticates via its mounted ServiceAccount
/// (loadFromCluster()), so we don't ship server/token here.
fn build_in_cluster_base_config(cfg: &ResolvedRuntimeConfig) -> String {
    // namespace must track cfg.namespace (which honors user
    // input.namespace override). Hardcoding to DEFAULT_LOCAL_NAMESPACE
    // would silently diverge from the namespace the desktop's
    // list_local_workloads queries against. hostnameSuffix +
    // ingressClassName are currently not user-overridable so the
    // defaults match LocalContainerDeploymentService's defaults; lift
    // them onto ResolvedRuntimeConfig if/when an override surface
    // appears. The registry is configured by the engine's own bring-up
    // (the microVM's in-VM registry), not from here.
    let kubernetes = serde_json::json!({
        "dataDir": "/data",
        "namespace": cfg.namespace,
        "hostnameSuffix": "appliance.localhost",
        "ingressClassName": "traefik",
        // The ingress publishes :80 on this host port — deploy-result
        // URLs must carry it to be clickable from the host
        // (KubernetesDeploymentService composes
        // `http://<stack>.<suffix>[:<hostPort>]` from it).
        "hostPort": cfg.host_port,
    });
    serde_json::json!({
        "type": "appliance-base-kubernetes",
        "name": "local-runtime",
        "kubernetes": kubernetes,
    })
    .to_string()
}

/// Minimal-escape transform for values interpolated into YAML
/// double-quoted scalars. Covers the three characters that can
/// break a double-quoted scalar: `\` (escape lead-in), `\n` (closes
/// the scalar mid-string), `"` (terminates the scalar). Quoting at
/// the call sites is unconditional, so we don't need to handle the
/// plain-scalar reserved characters here.
fn yaml_double_quoted(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\n', "\\n").replace('"', "\\\"")
}

/// Compose the multi-document YAML manifest deployed via kubectl apply.
/// Resource breakdown:
///   * Namespace `appliance-system` — keeps system components separate
///     from user appliances (which land in `appliance`).
///   * ServiceAccount + ClusterRole + ClusterRoleBinding — grants the
///     in-cluster api-server CRUD on the resources it manages
///     (deployments, services, ingresses, pods, namespaces, secrets).
///   * Secret — carries APPLIANCE_BASE_CONFIG + BOOTSTRAP_TOKEN so the
///     deployment env doesn't expose them in `kubectl describe`.
///   * PersistentVolume + PersistentVolumeClaim — hostPath-backed PV
///     mounted into the api-server pod as /data, mirroring the
///     filesystem object store path the cloud path stores in S3.
///   * Deployment + Service + Ingress — the api-server itself, fronted
///     by the cluster's Traefik at `api.appliance.localhost`.
fn render_in_cluster_api_server_manifest(
    cfg: &ResolvedRuntimeConfig,
    image: &str,
    bootstrap_token: &str,
) -> String {
    let base_config = build_in_cluster_base_config(cfg);
    let escaped_base_config = yaml_double_quoted(&base_config);
    // Windows resolves data_dir through Tauri's app_data_dir() into
    // a backslash-laden path (`C:\Users\..`). YAML 1.2 only accepts
    // a fixed set of escapes inside double-quoted scalars (`\n`, `\t`,
    // `\\`, `\"`, `\uNNNN`, `\UNNNNNNNN`, …); a bare `\U` followed
    // by anything other than 8 hex digits parses as an invalid
    // escape and kubectl rejects the whole apply. Same escape pass
    // as base_config keeps both safe for Windows + arbitrary
    // user-supplied overrides.
    let host_data_dir = yaml_double_quoted(&cfg.data_dir);
    format!(
        r#"apiVersion: v1
kind: Namespace
metadata:
  name: {ns}
  labels:
    app.kubernetes.io/managed-by: appliance.sh
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {name}
  namespace: {ns}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: appliance-api-server
rules:
- apiGroups: [""]
  resources: ["namespaces", "services", "pods", "secrets", "configmaps", "persistentvolumeclaims", "events"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["apps"]
  resources: ["deployments", "replicasets"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["networking.k8s.io"]
  resources: ["ingresses"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["pods/log"]
  verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: appliance-api-server
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: appliance-api-server
subjects:
- kind: ServiceAccount
  name: {name}
  namespace: {ns}
---
apiVersion: v1
kind: Secret
metadata:
  name: {name}-config
  namespace: {ns}
type: Opaque
stringData:
  APPLIANCE_BASE_CONFIG: "{base_config}"
  BOOTSTRAP_TOKEN: "{token}"
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: appliance-data
  labels:
    app.kubernetes.io/managed-by: appliance.sh
spec:
  capacity:
    storage: 10Gi
  accessModes: [ReadWriteOnce]
  hostPath:
    path: "{data_dir}"
  persistentVolumeReclaimPolicy: Retain
  storageClassName: ""
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: appliance-data
  namespace: {ns}
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 10Gi
  volumeName: appliance-data
  storageClassName: ""
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {name}
  namespace: {ns}
  labels:
    app.kubernetes.io/name: {name}
    app.kubernetes.io/managed-by: appliance.sh
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: {name}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: {name}
        app.kubernetes.io/managed-by: appliance.sh
    spec:
      serviceAccountName: {name}
      containers:
      - name: api-server
        image: "{image}"
        imagePullPolicy: IfNotPresent
        ports:
        - containerPort: {port}
          name: http
        envFrom:
        - secretRef:
            name: {name}-config
        env:
        - name: APPLIANCE_MODE
          value: "server"
        - name: PORT
          value: "{port}"
        - name: HOST
          value: "0.0.0.0"
        readinessProbe:
          httpGet:
            path: /bootstrap/status
            port: {port}
          initialDelaySeconds: 2
          periodSeconds: 2
        volumeMounts:
        - name: data
          mountPath: /data
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: appliance-data
---
apiVersion: v1
kind: Service
metadata:
  name: {name}
  namespace: {ns}
  labels:
    app.kubernetes.io/managed-by: appliance.sh
spec:
  selector:
    app.kubernetes.io/name: {name}
  ports:
  - port: 80
    targetPort: {port}
    protocol: TCP
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {name}
  namespace: {ns}
  labels:
    app.kubernetes.io/managed-by: appliance.sh
spec:
  ingressClassName: traefik
  rules:
  - host: {hostname}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: {name}
            port:
              number: 80
"#,
        ns = IN_CLUSTER_API_SERVER_NAMESPACE,
        name = IN_CLUSTER_API_SERVER_NAME,
        hostname = IN_CLUSTER_API_SERVER_HOSTNAME,
        port = IN_CLUSTER_API_SERVER_PORT,
        image = image,
        data_dir = host_data_dir,
        base_config = escaped_base_config,
        token = bootstrap_token,
    )
}

/// Read the existing BOOTSTRAP_TOKEN out of the api-server Secret in
/// the appliance-system namespace. Returns None when the Secret
/// doesn't exist yet (first bootstrap), when kubectl fails (cluster
/// down), or when the field is absent. Used so re-bootstrap reuses
/// the token the already-running pod's env was seeded with — see
/// bug_004 reasoning in bootstrap_in_cluster_api_server.
async fn read_existing_bootstrap_token() -> Option<String> {
    let (ok, stdout, _stderr) = run_status_command(&[
        "kubectl",
        "-n",
        IN_CLUSTER_API_SERVER_NAMESPACE,
        "get",
        "secret",
        &format!("{}-config", IN_CLUSTER_API_SERVER_NAME),
        "-o",
        "jsonpath={.data.BOOTSTRAP_TOKEN}",
    ])
    .await
    .ok()?;
    if !ok {
        return None;
    }
    let encoded = stdout.trim();
    if encoded.is_empty() {
        return None;
    }
    // Secret values are base64-encoded on read. Decode and validate
    // it's a non-empty UTF-8 string before reusing.
    use base64::Engine;
    let decoded = base64::engine::general_purpose::STANDARD.decode(encoded).ok()?;
    let token = String::from_utf8(decoded).ok()?;
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

/// Pipe a manifest string into `kubectl apply -f -` so we don't have
/// to materialize a temp file on disk. Surfaces stderr verbatim — the
/// kubectl error messages are usually self-explanatory and the caller
/// just bubbles them up to the UI.
async fn kubectl_apply_manifest(manifest: &str) -> Result<(), String> {
    let mut child = Command::new("kubectl")
        .args(["apply", "-f", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn kubectl: {e}"))?;
    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "kubectl stdin unavailable".to_string())?;
        stdin
            .write_all(manifest.as_bytes())
            .await
            .map_err(|e| format!("write kubectl stdin: {e}"))?;
    }
    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("kubectl wait: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("kubectl apply failed: {}", stderr));
    }
    Ok(())
}

/// Poll an arbitrary URL until /bootstrap/status returns 2xx, or the
/// timeout elapses. Used to detect when the in-cluster api-server is
/// past its readiness probe and reachable via the cluster's Ingress.
async fn wait_for_api_server_url(url: &str, max_wait: Duration) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + max_wait;
    let target = format!("{}/bootstrap/status", url.trim_end_matches('/'));
    loop {
        let (ok, _stdout, _stderr) =
            run_status_command(&["curl", "-fsS", "-o", "/dev/null", &target]).await?;
        if ok {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "in-cluster api-server did not become reachable at {url} within {}s",
                max_wait.as_secs()
            ));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// Mint an initial api key against the in-cluster api-server. Mirrors
/// the host-side `mint_api_key` but takes the full URL instead of a
/// loopback port — same `/bootstrap/create-key` route, same payload.
async fn mint_api_key_url(api_server_url: &str, token: &str) -> Result<ApiKey, String> {
    let url = format!("{}/bootstrap/create-key", api_server_url.trim_end_matches('/'));
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

/// Apply the in-cluster api-server manifests to the running
/// cluster, wait for the deployment to become reachable, and mint
/// the first API key. The api-server image must already be present
/// in the cluster-attached registry (push via the desktop's
/// build_and_import_image with `image_tag: appliance-api-server:latest`,
/// or pre-pull from a remote registry). Idempotent: applying twice
/// reconciles the manifest in place and mints a fresh key.
#[tauri::command]
async fn bootstrap_in_cluster_api_server(
    app: AppHandle,
    input: BootstrapInClusterInput,
) -> Result<BootstrapInClusterResult, String> {
    let runtime_input = input.runtime.unwrap_or_default();
    let cfg = resolve_runtime_config(&app, &runtime_input)?;
    let image = input
        .image
        .unwrap_or_else(|| IN_CLUSTER_API_SERVER_DEFAULT_IMAGE.to_string());
    // Reuse the existing Secret's BOOTSTRAP_TOKEN when one is
    // present — the running api-server pod's env was populated via
    // envFrom at container start, which is a one-shot snapshot;
    // updating the Secret does NOT re-inject env vars or restart
    // the pod, so minting a fresh token here would mean the pod's
    // env (old token) and the curl we POST below (new token) never
    // match — 401 forever, until manual pod restart. Reading the
    // existing token sidesteps this and keeps re-bootstrap clean
    // when the pod is already up.
    let bootstrap_token = read_existing_bootstrap_token().await.unwrap_or_else(random_bootstrap_token);
    let manifest = render_in_cluster_api_server_manifest(&cfg, &image, &bootstrap_token);
    kubectl_apply_manifest(&manifest).await?;

    // The Ingress goes through the cluster's serverlb host port. URL
    // shape mirrors what user appliances get (`<name>.appliance.localhost`)
    // so the desktop's cluster registry can treat the in-cluster
    // api-server as just-another-reachable-URL.
    let api_server_url = if cfg.host_port == 80 {
        format!("http://{}", IN_CLUSTER_API_SERVER_HOSTNAME)
    } else {
        format!("http://{}:{}", IN_CLUSTER_API_SERVER_HOSTNAME, cfg.host_port)
    };
    wait_for_api_server_url(&api_server_url, Duration::from_secs(60)).await?;
    let api_key = mint_api_key_url(&api_server_url, &bootstrap_token).await?;
    Ok(BootstrapInClusterResult {
        api_server_url,
        api_key,
    })
}

// --- microVM engine ---------------------------------------------------
//
// The microVM runtime (packages/vm — appliance-vm) is driven through
// two channels: lifecycle reads/stops go straight to the appliance-vm
// binary; the full `up` orchestration (in-VM registry wait, api-server
// image push, bootstrap, profile registration) lives in the bundled
// appliance CLI (`appliance vm up`) and is streamed here, so desktop
// and CLI share one implementation of the control-plane logic.
//
// The engine binary itself is desktop-managed: packaged builds carry
// it as a bundle resource (scripts/copy-vm.mjs), dev builds reach for
// the repo's cargo output, and `microvm_install` places it in
// ~/.appliance/bin — the shared managed location the CLI resolves too.

/// Locate the appliance-vm binary: the helper-managed bin dir first
/// (the CLI's `appliance vm` resolves the same path), then PATH.
fn vm_binary() -> Option<PathBuf> {
    if let Some(home) = home_dir() {
        let managed = home.join(SHARED_PROFILES_DIR).join("bin").join("appliance-vm");
        if managed.exists() {
            return Some(managed);
        }
    }
    which_path("appliance-vm")
}

/// Where an installable appliance-vm binary can come from: the
/// bundled resource (packaged builds; placed by scripts/copy-vm.mjs),
/// or — in dev builds — the repo checkout's cargo output.
fn vm_install_source(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(resource) = app
        .path()
        .resolve("vm-bin/appliance-vm", tauri::path::BaseDirectory::Resource)
    {
        if resource.is_file() {
            return Some(resource);
        }
    }
    #[cfg(debug_assertions)]
    {
        let vm_target = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../vm/target");
        for profile in ["release", "debug"] {
            let candidate = vm_target.join(profile).join("appliance-vm");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// The entitlement Virtualization.framework gates VM creation on —
/// compiled in from packages/vm/vz.entitlements (one source of truth).
#[cfg(target_os = "macos")]
const VZ_ENTITLEMENTS: &str = include_str!("../../../vm/vz.entitlements");

/// Re-sign an installed appliance-vm with the virtualization
/// entitlement (ad-hoc). Copying the binary out of the app bundle
/// leaves it outside the bundle's signature, and an unentitled binary
/// can't create VMs.
#[cfg(target_os = "macos")]
async fn sign_with_vz_entitlement(binary: &std::path::Path) -> Result<(), String> {
    let entitlements_path = std::env::temp_dir().join("appliance-vz.entitlements");
    fs::write(&entitlements_path, VZ_ENTITLEMENTS)
        .map_err(|e| format!("write {}: {e}", entitlements_path.display()))?;
    let entitlements = entitlements_path.to_string_lossy().to_string();
    let binary = binary.to_string_lossy().to_string();
    let (ok, _stdout, stderr) = run_status_command(&[
        "codesign",
        "--force",
        "--sign",
        "-",
        "--entitlements",
        &entitlements,
        &binary,
    ])
    .await?;
    if !ok {
        return Err(format!("codesign {binary} failed: {}", stderr.trim()));
    }
    Ok(())
}

/// Install the appliance-vm engine into ~/.appliance/bin, where both
/// the desktop and the CLI resolve it. Returns the installed path.
#[tauri::command]
async fn microvm_install(app: AppHandle) -> Result<String, String> {
    let source = vm_install_source(&app)
        .ok_or("no installable appliance-vm binary ships with this build")?;
    let home = home_dir().ok_or("cannot resolve the home directory")?;
    let bin_dir = home.join(SHARED_PROFILES_DIR).join("bin");
    fs::create_dir_all(&bin_dir).map_err(|e| format!("create {}: {e}", bin_dir.display()))?;
    let dest = bin_dir.join("appliance-vm");
    // Unlink first: overwriting in place would truncate the inode a
    // still-running VM host process executes from.
    let _ = fs::remove_file(&dest);
    fs::copy(&source, &dest).map_err(|e| format!("copy to {}: {e}", dest.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dest, fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("chmod {}: {e}", dest.display()))?;
    }
    #[cfg(target_os = "macos")]
    sign_with_vz_entitlement(&dest).await?;
    Ok(dest.to_string_lossy().to_string())
}

/// Ensure the managed engine binary in ~/.appliance/bin matches the one
/// this build bundles, (re)installing when it's **missing or stale**.
/// The engine reports a fixed `--version`, so a version string can't
/// tell builds apart; we compare bytes against the bundled source
/// instead — `microvm_install` copies that source and re-signs it with
/// the same ad-hoc entitlement it already carries, so an up-to-date
/// install is byte-identical. A no-op when the build ships no
/// installable source (we then use whatever is already on PATH/managed).
///
/// This is what keeps `appliance vm dev up` (spawned via the bundled CLI,
/// which resolves the managed binary) from running a stale engine that
/// predates flags like `--dev`.
async fn ensure_vm_installed(app: &AppHandle, on_event: &Channel<serde_json::Value>) -> Result<(), String> {
    let Some(source) = vm_install_source(app) else {
        return Ok(());
    };
    let dest = home_dir()
        .map(|h| h.join(SHARED_PROFILES_DIR).join("bin").join("appliance-vm"));
    let up_to_date = dest.as_ref().is_some_and(|dest| {
        dest.is_file()
            // Cheap length gate before reading both binaries in full.
            && fs::metadata(&source).map(|m| m.len()).ok() == fs::metadata(dest).map(|m| m.len()).ok()
            && fs::read(&source).ok() == fs::read(dest).ok()
    });
    if up_to_date {
        return Ok(());
    }
    let _ = on_event.send(serde_json::json!({
        "type": "log",
        "level": "info",
        "message": "installing the microVM engine (appliance-vm) into ~/.appliance/bin",
    }));
    microvm_install(app.clone()).await?;
    Ok(())
}

/// Adopt the CLI-managed microVM profile (~/.appliance/profiles.json,
/// written by `appliance vm up`) as a desktop cluster, so the deploy
/// wizard and cluster switcher target the engine like any other
/// cluster. The CLI stays the source of truth for these credentials:
/// the keychain copy is refreshed from the shared entry (catching CLI
/// re-keys), and mirror_to_shared_profiles never writes over
/// CLI-managed entries. Idempotent — no-ops once everything matches.
fn sync_microvm_cluster(app: &AppHandle, name: &str) -> Result<(), HostError> {
    let _guard = config_lock();
    let cluster_id = microvm_cluster_id(name);
    let cluster_label = microvm_cluster_label(name);
    let Some(shared) = read_shared_profiles() else {
        return Ok(());
    };
    let Some(entry) = shared.profiles.get(&cluster_id) else {
        return Ok(());
    };
    if entry.api_url.is_empty() || entry.key_id.is_empty() || entry.secret.is_empty() {
        return Ok(());
    }

    let mut persisted = read_persisted_config(app)?;
    migrate_legacy(app, &mut persisted)?;

    // Freshness is judged by comparing the shared entry against the
    // cluster record (synced_key_id), never by reading the keychain:
    // this runs on every status poll, and a keychain read can block on
    // a macOS access prompt. The keychain is written only when the
    // CLI actually re-keyed.
    let api_key = ApiKey {
        id: entry.key_id.clone(),
        secret: entry.secret.clone(),
    };
    let changed = match persisted.clusters.iter_mut().find(|c| c.id == cluster_id) {
        Some(cluster) => {
            let mut changed = false;
            if cluster.api_server_url != entry.api_url {
                cluster.api_server_url = entry.api_url.clone();
                changed = true;
            }
            // A bare ingest from profiles.json labels the cluster with
            // its slug; upgrade it to the human name.
            if cluster.name == cluster_id {
                cluster.name = cluster_label.clone();
                changed = true;
            }
            if cluster.synced_key_id.as_deref() != Some(entry.key_id.as_str()) {
                write_api_key(&cluster_keychain_account(&cluster_id), &api_key)?;
                cluster.synced_key_id = Some(entry.key_id.clone());
                changed = true;
            }
            changed
        }
        None => {
            write_api_key(&cluster_keychain_account(&cluster_id), &api_key)?;
            persisted.clusters.push(Cluster {
                id: cluster_id.clone(),
                name: cluster_label,
                api_server_url: entry.api_url.clone(),
                created_at: entry
                    .created_at
                    .clone()
                    .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
                state_backend_url: None,
                last_bootstrap_input: None,
                synced_key_id: Some(entry.key_id.clone()),
            });
            // First-cluster convenience: select it when nothing else
            // is, never override a user's choice.
            if persisted.selected_cluster_id.is_none() {
                persisted.selected_cluster_id = Some(cluster_id.clone());
            }
            true
        }
    };
    if changed {
        write_persisted_config(app, &persisted)?;
    }
    Ok(())
}

/// Drop the microVM cluster registration (config + keychain + shared
/// profile) — its credentials live in the VM's data disk, so deleting
/// the VM invalidates them. Best-effort.
fn unregister_microvm_cluster(app: &AppHandle, name: &str) -> Result<(), HostError> {
    let _guard = config_lock();
    let cluster_id = microvm_cluster_id(name);
    let mut persisted = read_persisted_config(app)?;
    migrate_legacy(app, &mut persisted)?;
    let before = persisted.clusters.len();
    persisted.clusters.retain(|c| c.id != cluster_id);
    delete_api_key(&cluster_keychain_account(&cluster_id));
    if let Some(mut shared) = read_shared_profiles() {
        if shared.profiles.remove(&cluster_id).is_some() {
            if shared.active_profile.as_deref() == Some(cluster_id.as_str()) {
                shared.active_profile = None;
            }
            let _ = write_shared_profiles(&shared);
        }
    }
    if persisted.clusters.len() == before {
        return Ok(());
    }
    if persisted.selected_cluster_id.as_deref() == Some(cluster_id.as_str()) {
        persisted.selected_cluster_id = persisted.clusters.first().map(|c| c.id.clone());
    }
    write_persisted_config(app, &persisted)
}

fn which_path(cmd: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(cmd);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MicroVmStatus {
    /// appliance-vm binary present on this machine.
    available: bool,
    /// Not installed, but this build carries a binary it can install
    /// (surface an Install action instead of a dead-end message).
    installable: bool,
    exists: bool,
    running: bool,
    /// kubeconfig fetched and the host process alive — the cluster
    /// answers. Gated on `running` so a stopped VM (whose kubeconfig
    /// file lingers on disk) doesn't read as ready.
    kubeconfig_ready: bool,
    /// Current bring-up stage while starting: media | booting | network |
    /// cluster | ready | failed. `None` when not running. Lets the UI
    /// show "starting (k3s)" / "failed" instead of a blunt "running".
    #[serde(skip_serializing_if = "Option::is_none")]
    phase: Option<String>,
    /// Whether this VM is provisioned as a development environment
    /// (`appliance vm dev up`). Drives the dev-shell affordance.
    dev: bool,
    api_server_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

const MICROVM_NAME: &str = "appliance";
const MICROVM_HOST_PORT: u16 = 8081;

/// Resolve a VM name from an optional command argument. Defaults to the
/// canonical "appliance" VM so existing single-VM callers keep working.
fn vm_name(name: Option<String>) -> String {
    name.map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| MICROVM_NAME.to_string())
}

/// The desktop cluster id (and CLI profile name) a VM owns. Mirrors
/// profileForVm in packages/cli/src/appliance-vm.ts: the default VM
/// keeps the plain "microvm" id; each other VM gets "microvm-<name>".
fn microvm_cluster_id(name: &str) -> String {
    if name == MICROVM_NAME {
        MICROVM_CLUSTER_ID.to_string()
    } else {
        format!("{MICROVM_CLUSTER_ID}-{name}")
    }
}

/// Human-facing cluster label for a VM.
fn microvm_cluster_label(name: &str) -> String {
    if name == MICROVM_NAME {
        MICROVM_CLUSTER_NAME.to_string()
    } else {
        format!("{MICROVM_CLUSTER_NAME} ({name})")
    }
}

/// One VM as reported by `appliance-vm list` — its allocated ports and
/// running state, plus the desktop cluster id it registers under.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MicroVmSummary {
    name: String,
    running: bool,
    /// Cluster answers (kubeconfig fetched) while running — lets the
    /// switcher show "starting" vs "ready" per VM. `false` for older
    /// engine binaries that don't report it.
    cluster_ready: bool,
    /// Current bring-up stage while starting. `None` when not running or
    /// when the engine predates phase reporting.
    #[serde(skip_serializing_if = "Option::is_none")]
    phase: Option<String>,
    host_port: u16,
    api_port: u16,
    registry_port: u16,
    egress_port: u16,
    cluster_id: String,
}

#[tauri::command]
async fn microvm_list() -> Result<Vec<MicroVmSummary>, String> {
    let Some(bin) = vm_binary() else {
        return Ok(Vec::new());
    };
    let bin = bin.to_string_lossy().to_string();
    let (ok, stdout, stderr) = run_status_command(&[&bin, "list"]).await?;
    if !ok {
        return Err(format!("appliance-vm list failed: {}", stderr.trim()));
    }
    let parsed: Vec<serde_json::Value> = serde_json::from_str(stdout.trim()).unwrap_or_default();
    Ok(parsed
        .into_iter()
        .map(|v| {
            let name = v.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
            let cluster_id = microvm_cluster_id(&name);
            MicroVmSummary {
                running: v.get("running").and_then(|r| r.as_bool()).unwrap_or(false),
                cluster_ready: v.get("clusterReady").and_then(|r| r.as_bool()).unwrap_or(false),
                phase: v.get("phase").and_then(|p| p.as_str()).map(|s| s.to_string()),
                host_port: v.get("hostPort").and_then(|p| p.as_u64()).unwrap_or(0) as u16,
                api_port: v.get("apiPort").and_then(|p| p.as_u64()).unwrap_or(0) as u16,
                registry_port: v.get("registryPort").and_then(|p| p.as_u64()).unwrap_or(0) as u16,
                egress_port: v.get("egressPort").and_then(|p| p.as_u64()).unwrap_or(0) as u16,
                cluster_id,
                name,
            }
        })
        .collect())
}

#[tauri::command]
async fn microvm_status(app: AppHandle, name: Option<String>) -> MicroVmStatus {
    let name = vm_name(name);
    // Fallback URL before we know the VM's allocated port (binary
    // missing, or status failed). The default VM keeps 8081; a named VM
    // we can't probe yet gets its host:port filled in from status below.
    let api_server_url = format!("http://{}:{}", IN_CLUSTER_API_SERVER_HOSTNAME, MICROVM_HOST_PORT);
    let Some(bin) = vm_binary() else {
        let installable = vm_install_source(&app).is_some();
        return MicroVmStatus {
            available: false,
            installable,
            exists: false,
            running: false,
            kubeconfig_ready: false,
            phase: None,
            dev: false,
            api_server_url,
            message: Some(if installable {
                "The microVM engine isn't installed yet.".into()
            } else {
                "appliance-vm is not installed (expected in ~/.appliance/bin or on PATH) \
                 and this build has no bundled copy. In a repo checkout: \
                 `cargo build --release && ./scripts/sign-dev.sh --release` in packages/vm."
                    .into()
            }),
        };
    };
    let bin = bin.to_string_lossy().to_string();
    let (ok, stdout, stderr) = match run_status_command(&[&bin, "status", &name]).await {
        Ok(t) => t,
        Err(e) => {
            return MicroVmStatus {
                available: false,
                installable: false,
                exists: false,
                running: false,
                kubeconfig_ready: false,
                phase: None,
                dev: false,
                api_server_url,
                message: Some(e),
            }
        }
    };
    if !ok {
        return MicroVmStatus {
            available: true,
            installable: false,
            exists: false,
            running: false,
            kubeconfig_ready: false,
            phase: None,
            dev: false,
            api_server_url,
            message: Some(stderr.trim().to_string()),
        };
    }
    let parsed: serde_json::Value = serde_json::from_str(&stdout).unwrap_or_default();
    // Prefer the VM's actual forwarded ingress port (status now reports
    // it) so a named VM resolves to its own api-server URL.
    let api_server_url = match parsed.get("hostPort").and_then(|v| v.as_u64()) {
        Some(port) => format!("http://{}:{}", IN_CLUSTER_API_SERVER_HOSTNAME, port),
        None => api_server_url,
    };
    let running = parsed.get("running").and_then(|v| v.as_bool()).unwrap_or(false);
    // The engine now reports `clusterReady` (kubeconfig fetched *and* the
    // host process alive) directly — prefer it. Fall back to the on-disk
    // kubeconfig check for older engine binaries that predate the field,
    // gating on `running` so a stopped VM's lingering kubeconfig doesn't
    // read as ready.
    let kubeconfig_ready = match parsed.get("clusterReady").and_then(|v| v.as_bool()) {
        Some(ready) => ready,
        None => {
            running
                && home_dir()
                    .map(|h| {
                        h.join(SHARED_PROFILES_DIR)
                            .join("vm")
                            .join(&name)
                            .join("kubeconfig.yaml")
                            .exists()
                    })
                    .unwrap_or(false)
        }
    };
    let phase = parsed
        .get("phase")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    if running && kubeconfig_ready {
        // Keep the desktop's cluster registration in step with the
        // CLI-owned profile while the engine is up — this also catches
        // an `appliance vm up` run outside the desktop, and re-keys.
        if let Err(e) = sync_microvm_cluster(&app, &name) {
            eprintln!("warn: microvm cluster sync failed: {e}");
        }
    }
    MicroVmStatus {
        available: true,
        installable: false,
        exists: parsed.get("exists").and_then(|v| v.as_bool()).unwrap_or(false),
        running,
        kubeconfig_ready,
        phase,
        dev: parsed.get("dev").and_then(|v| v.as_bool()).unwrap_or(false),
        api_server_url,
        message: parsed
            .get("message")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    }
}

/// Run `appliance vm up` through the bundled CLI, streaming output
/// lines to the frontend. Returns when the runtime is fully up
/// (api-server bootstrapped + microvm profile registered).
#[tauri::command]
async fn microvm_up(
    app: AppHandle,
    name: Option<String>,
    on_event: Channel<serde_json::Value>,
) -> Result<(), String> {
    let name = vm_name(name);
    run_microvm_up(app, name, false, None, on_event).await
}

/// Boot a microVM as a development environment (`appliance vm dev up`):
/// same full bring-up as `microvm_up`, plus the dev toolchain +
/// persistent `/persist/workspace` you shell into.
#[tauri::command]
async fn microvm_dev_up(
    app: AppHandle,
    name: Option<String>,
    mount: Option<String>,
    on_event: Channel<serde_json::Value>,
) -> Result<(), String> {
    let name = vm_name(name);
    run_microvm_up(app, name, true, mount, on_event).await
}

/// Shared bring-up for `microvm_up` / `microvm_dev_up`. `dev` selects
/// the `vm dev up` subcommand (provisioned dev environment) over the
/// plain `vm up`; `mount` (dev only) shares a host folder into the
/// workspace. Everything else — engine self-heal, log streaming,
/// cluster registration — is identical.
async fn run_microvm_up(
    app: AppHandle,
    name: String,
    dev: bool,
    mount: Option<String>,
    on_event: Channel<serde_json::Value>,
) -> Result<(), String> {
    // Self-heal: refresh the managed engine binary the bundled CLI below
    // resolves (~/.appliance/bin) when it's missing OR stale, so a freshly
    // bundled engine always wins over a leftover older install.
    ensure_vm_installed(&app, &on_event).await?;
    // `vm dev up` and `vm up` share the same bring-up; the dev variant
    // additionally provisions the toolchain + workspace, and may share a
    // host folder into it.
    let mount = mount.filter(|m| !m.trim().is_empty());
    let mut argv: Vec<&str> = if dev {
        vec!["vm", "dev", "up", "--name", &name]
    } else {
        vec!["vm", "up", "--name", &name]
    };
    if let Some(m) = mount.as_deref() {
        argv.extend(["--mount", m]);
    }
    let sidecar = app
        .shell()
        .sidecar("appliance")
        .map_err(|e| format!("Bundled appliance CLI is unavailable: {e}"))?
        .args(argv);
    let (mut rx, _child) = sidecar
        .spawn()
        .map_err(|e| format!("failed to spawn appliance CLI: {e}"))?;

    let mut exit_code: Option<i32> = None;
    let mut tail: Vec<String> = Vec::new();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim_end().to_string();
                if line.is_empty() {
                    continue;
                }
                tail.push(line.clone());
                if tail.len() > 12 {
                    tail.remove(0);
                }
                let _ = on_event.send(serde_json::json!({
                    "type": "log",
                    "level": "info",
                    "message": line,
                }));
            }
            CommandEvent::Error(msg) => return Err(msg),
            CommandEvent::Terminated(payload) => exit_code = payload.code,
            _ => {}
        }
    }
    match exit_code {
        Some(0) => {
            // The CLI just wrote (or verified) the microvm profile —
            // adopt it as a desktop cluster right away so the deploy
            // wizard can target the engine without waiting for the
            // next status poll.
            sync_microvm_cluster(&app, &name).map_err(|e| format!("register microVM cluster: {e}"))?;
            Ok(())
        }
        code => Err(format!(
            "appliance vm up exited with {:?}\n{}",
            code,
            tail.join("\n")
        )),
    }
}

#[tauri::command]
async fn microvm_stop(name: Option<String>) -> Result<(), String> {
    let name = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    let (ok, _stdout, stderr) = run_status_command(&[&bin, "stop", &name]).await?;
    if !ok {
        return Err(format!("appliance-vm stop failed: {}", stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
async fn microvm_delete(app: AppHandle, name: Option<String>) -> Result<(), String> {
    let name = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    // Stop first (delete refuses while running), tolerating "not running".
    let _ = run_status_command(&[&bin, "stop", &name]).await;
    // Give the host process a moment to exit before delete checks the pidfile.
    for _ in 0..20 {
        let (ok, stdout, _) = run_status_command(&[&bin, "status", &name]).await?;
        if ok {
            let parsed: serde_json::Value = serde_json::from_str(&stdout).unwrap_or_default();
            if !parsed.get("running").and_then(|v| v.as_bool()).unwrap_or(false) {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let (ok, _stdout, stderr) = run_status_command(&[&bin, "delete", &name]).await?;
    if !ok {
        return Err(format!("appliance-vm delete failed: {}", stderr.trim()));
    }
    // The credentials lived in the VM's data disk — drop the now-dead
    // cluster registration (best-effort; the VM itself is gone).
    if let Err(e) = unregister_microvm_cluster(&app, &name) {
        eprintln!("warn: microvm cluster unregister failed: {e}");
    }
    Ok(())
}

// --- egress (outbound-traffic control) ------------------------------
//
// The desktop drives the same `appliance-vm egress` surface the CLI
// uses, so the policy file stays single-sourced. Reads go through
// `egress policy` (JSON); mutations through the typed subcommands —
// the binary owns CA generation when MITM is switched on.

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct EgressPolicy {
    #[serde(default)]
    default: String,
    #[serde(default)]
    allow: Vec<String>,
    #[serde(default)]
    deny: Vec<String>,
    #[serde(default)]
    mitm: bool,
    /// CA cert path, populated for the UI when interception is on and
    /// the cert exists — the user injects this into clients to trust
    /// the interceptor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ca_path: Option<String>,
}

fn microvm_ca_path(name: &str) -> Option<PathBuf> {
    let p = home_dir()?
        .join(SHARED_PROFILES_DIR)
        .join("vm")
        .join(name)
        .join("egress-ca.pem");
    p.is_file().then_some(p)
}

#[tauri::command]
async fn microvm_egress_get(name: Option<String>) -> Result<EgressPolicy, String> {
    let name = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    let (ok, stdout, stderr) = run_status_command(&[&bin, "egress", "policy", &name]).await?;
    if !ok {
        return Err(format!("read egress policy failed: {}", stderr.trim()));
    }
    let mut policy: EgressPolicy = serde_json::from_str(&stdout).map_err(|e| e.to_string())?;
    policy.ca_path = microvm_ca_path(&name).map(|p| p.to_string_lossy().into_owned());
    Ok(policy)
}

#[tauri::command]
async fn microvm_egress_default(name: Option<String>, action: String) -> Result<(), String> {
    let name = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    let (ok, _o, stderr) =
        run_status_command(&[&bin, "egress", "default", &action, "--name", &name]).await?;
    if !ok {
        return Err(format!("set default failed: {}", stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
async fn microvm_egress_rule(name: Option<String>, action: String, host: String) -> Result<(), String> {
    // action: "allow" | "deny"
    if action != "allow" && action != "deny" {
        return Err(format!("rule action must be allow|deny, got '{action}'"));
    }
    let name = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    let (ok, _o, stderr) =
        run_status_command(&[&bin, "egress", &action, &host, "--name", &name]).await?;
    if !ok {
        return Err(format!("add {action} rule failed: {}", stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
async fn microvm_egress_mitm(name: Option<String>, enabled: bool) -> Result<(), String> {
    let name = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    let state = if enabled { "on" } else { "off" };
    let (ok, _o, stderr) =
        run_status_command(&[&bin, "egress", "mitm", state, "--name", &name]).await?;
    if !ok {
        return Err(format!("set mitm failed: {}", stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
async fn microvm_egress_reset(name: Option<String>) -> Result<(), String> {
    let name = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    let (ok, _o, stderr) = run_status_command(&[&bin, "egress", "reset", &name]).await?;
    if !ok {
        return Err(format!("reset egress failed: {}", stderr.trim()));
    }
    Ok(())
}

/// One recorded egress request — mirrors TrafficEvent in
/// packages/vm/src/traffic.rs.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EgressEvent {
    ts: u64,
    host: String,
    port: u16,
    method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    decision: String,
}

#[tauri::command]
async fn microvm_egress_log(name: Option<String>, tail: Option<u32>) -> Result<Vec<EgressEvent>, String> {
    let name = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    let tail = tail.unwrap_or(200).to_string();
    let (ok, stdout, stderr) =
        run_status_command(&[&bin, "egress", "log", &name, "--tail", &tail]).await?;
    if !ok {
        return Err(format!("read egress log failed: {}", stderr.trim()));
    }
    serde_json::from_str(stdout.trim()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn microvm_egress_clear_log(name: Option<String>) -> Result<(), String> {
    let name = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    let (ok, _o, stderr) =
        run_status_command(&[&bin, "egress", "log", &name, "--clear"]).await?;
    if !ok {
        return Err(format!("clear egress log failed: {}", stderr.trim()));
    }
    Ok(())
}

// --- credential capture/injection (apiKeyHelper) --------------------
//
// Per-host rules + a host-side secret store, driven through the same
// `appliance-vm creds` surface the CLI uses.

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CredentialRule {
    host: String,
    #[serde(default)]
    capture: bool,
    #[serde(default)]
    inject: bool,
    #[serde(default)]
    header: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    helper: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StoredSecret {
    host: String,
    header: String,
    masked: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct CredentialsState {
    #[serde(default)]
    rules: Vec<CredentialRule>,
    #[serde(default)]
    secrets: Vec<StoredSecret>,
}

#[tauri::command]
async fn microvm_creds_list(name: Option<String>) -> Result<CredentialsState, String> {
    let name = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    let (ok, stdout, stderr) = run_status_command(&[&bin, "creds", "list", &name]).await?;
    if !ok {
        return Err(format!("read creds failed: {}", stderr.trim()));
    }
    serde_json::from_str(stdout.trim()).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredsAddInput {
    host: String,
    capture: bool,
    inject: bool,
    #[serde(default)]
    header: Option<String>,
    #[serde(default)]
    helper: Option<String>,
}

#[tauri::command]
async fn microvm_creds_add(name: Option<String>, input: CredsAddInput) -> Result<(), String> {
    let name = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    let mut args: Vec<String> =
        vec![bin.clone(), "creds".into(), "add".into(), input.host.clone(), "--name".into(), name];
    if input.capture {
        args.push("--capture".into());
    }
    if input.inject {
        args.push("--inject".into());
    }
    if let Some(h) = input.header.filter(|h| !h.trim().is_empty()) {
        args.push("--header".into());
        args.push(h);
    }
    if let Some(c) = input.helper.filter(|c| !c.trim().is_empty()) {
        args.push("--helper".into());
        args.push(c);
    }
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let (ok, _o, stderr) = run_status_command(&argv).await?;
    if !ok {
        return Err(format!("add credential rule failed: {}", stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
async fn microvm_creds_remove(name: Option<String>, host: String) -> Result<(), String> {
    let name = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    let (ok, _o, stderr) =
        run_status_command(&[&bin, "creds", "rm", &host, "--name", &name]).await?;
    if !ok {
        return Err(format!("remove credential rule failed: {}", stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
async fn microvm_creds_set(
    name: Option<String>,
    host: String,
    value: String,
    header: Option<String>,
) -> Result<(), String> {
    let name = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    let mut args: Vec<String> =
        vec![bin.clone(), "creds".into(), "set".into(), host, value, "--name".into(), name];
    if let Some(h) = header.filter(|h| !h.trim().is_empty()) {
        args.push("--header".into());
        args.push(h);
    }
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let (ok, _o, stderr) = run_status_command(&argv).await?;
    if !ok {
        return Err(format!("store secret failed: {}", stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
async fn microvm_creds_forget(name: Option<String>) -> Result<(), String> {
    let name = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    let (ok, _o, stderr) = run_status_command(&[&bin, "creds", "forget", &name]).await?;
    if !ok {
        return Err(format!("forget secrets failed: {}", stderr.trim()));
    }
    Ok(())
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

/// kubectl target-selection args for the microVM engine: the
/// kubeconfig appliance-vm fetched out of the guest. The microVM is
/// the only local engine, so a missing/other engine is an error rather
/// than a fallback to a host context.
fn kube_target_args(engine: Option<&str>, cluster_name: &str) -> Result<Vec<String>, String> {
    if engine != Some("microvm") {
        return Err("a local engine is required — pass engine=\"microvm\"".into());
    }
    // `cluster_name` carries the VM name (the frontend passes it). The
    // default sentinel means "unset" — fall back to the canonical VM.
    let vm = if cluster_name.is_empty() || cluster_name == DEFAULT_LOCAL_CLUSTER_NAME {
        MICROVM_NAME
    } else {
        cluster_name
    };
    let home = home_dir().ok_or("cannot resolve the home directory")?;
    let kubeconfig = home
        .join(SHARED_PROFILES_DIR)
        .join("vm")
        .join(vm)
        .join("kubeconfig.yaml");
    if !kubeconfig.is_file() {
        return Err("the microVM kubeconfig is not available — is the engine up?".into());
    }
    Ok(vec![
        "--kubeconfig".to_string(),
        kubeconfig.to_string_lossy().into_owned(),
    ])
}

#[tauri::command]
async fn list_local_workloads(
    app: AppHandle,
    input: Option<LocalRuntimeInput>,
) -> Result<LocalWorkloads, String> {
    let input = input.unwrap_or_default();
    let cfg = resolve_runtime_config(&app, &input)?;
    let target = kube_target_args(input.engine.as_deref(), &cfg.cluster_name)?;

    let mut args: Vec<&str> = vec!["kubectl"];
    args.extend(target.iter().map(String::as_str));
    args.extend(["-n", &cfg.namespace, "get", "deploy,pod,svc", "-o", "json"]);
    let (ok, stdout, stderr) = run_status_command(&args).await?;
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
    /// See LocalRuntimeInput.engine — "microvm" reads through the
    /// microVM's kubeconfig.
    #[serde(default)]
    engine: Option<String>,
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
    let target = kube_target_args(input.engine.as_deref(), &cfg.cluster_name)?;
    let tail = input.tail_lines.unwrap_or(200).to_string();
    let mut args: Vec<&str> = vec!["kubectl"];
    args.extend(target.iter().map(String::as_str));
    args.extend(["-n", &cfg.namespace, "logs", &input.pod_name, "--tail", &tail]);
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

// --- interactive terminals (PTY) ------------------------------------
//
// xterm.js in the desktop drives a real PTY (see terminal.rs) so
// `kubectl exec -it` into a workload behaves like a native shell.
// microVM target selection (the VM's fetched kubeconfig) is resolved
// here, next to the other kube wiring; terminal.rs only moves bytes.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOpenInput {
    /// kubectl target — a pod name, or any exec-able ref like
    /// `deploy/my-app`.
    target: String,
    #[serde(default)]
    namespace: Option<String>,
    #[serde(default)]
    cluster_name: Option<String>,
    /// "microvm" routes through the microVM's kubeconfig.
    #[serde(default)]
    engine: Option<String>,
    /// Shell target. Absent → `kubectl exec` into the pod named by
    /// `target` (the default). "dev" → a shell in the microVM's dev
    /// workspace; "host" → a raw root shell on the microVM host. Both
    /// ride `kubectl debug node/` + chroot (microVM engine only).
    #[serde(default)]
    mode: Option<String>,
    /// Command to run; defaults to an interactive `/bin/sh`.
    #[serde(default)]
    command: Option<Vec<String>>,
    #[serde(default)]
    container: Option<String>,
    cols: u16,
    rows: u16,
}

/// Interactive login for the dev workspace — mirrors DEV_SHELL_LOGIN in
/// the CLI: a stable HOME on the persistent disk, cd into the
/// workspace, and bash once the toolchain has installed it (sh until
/// then).
const DEV_SHELL_LOGIN: &str = "export HOME=/persist/workspace; cd /persist/workspace 2>/dev/null || true; \
     if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi";

/// Build the argv for a shell into the microVM host itself, riding
/// `kubectl debug node/<node>` + chroot (the same mechanism as
/// `appliance vm shell`). `dev` lands in the persistent workspace with
/// the provisioned toolchain; otherwise a raw root shell at /. Resolves
/// the VM's single node name first (async kubectl), so this lives
/// outside the sync `terminal_exec_argv`.
async fn microvm_host_shell_argv(input: &TerminalOpenInput, dev: bool) -> Result<Vec<String>, String> {
    // Prefer the fast vsock shell when the relay socket is up: it needs
    // no k3s and leaves no debugger pod behind. Falls through to
    // kubectl-debug for older VMs or before the guest agent is ready.
    let cluster = input.cluster_name.as_deref().unwrap_or("");
    let vm = if cluster.is_empty() || cluster == DEFAULT_LOCAL_CLUSTER_NAME {
        MICROVM_NAME
    } else {
        cluster
    };
    if let (Some(bin), Some(home)) = (vm_binary(), home_dir()) {
        let sock = home
            .join(SHARED_PROFILES_DIR)
            .join("vm")
            .join(vm)
            .join("shell.sock");
        if sock.exists() {
            return Ok(vec![bin.to_string_lossy().into_owned(), "shell".to_string(), vm.to_string()]);
        }
    }

    let target = kube_target_args(input.engine.as_deref(), input.cluster_name.as_deref().unwrap_or(""))?;
    // target is ["--kubeconfig", <path>]; reuse the path for the node lookup.
    let mut node_args: Vec<&str> = vec!["kubectl"];
    node_args.extend(target.iter().map(String::as_str));
    node_args.extend(["get", "nodes", "-o", "jsonpath={.items[0].metadata.name}"]);
    let (ok, stdout, stderr) = run_status_command(&node_args).await?;
    let node = stdout.trim();
    if !ok || node.is_empty() {
        return Err(format!(
            "could not resolve the VM node — is the engine up?{}",
            if stderr.trim().is_empty() { String::new() } else { format!(" ({})", stderr.trim()) }
        ));
    }
    let entry = if dev { DEV_SHELL_LOGIN } else { "exec /bin/sh -l" };
    let mut argv = vec!["kubectl".to_string()];
    argv.extend(target);
    argv.extend(
        [
            "debug",
            &format!("node/{node}"),
            "-it",
            "--image=busybox:1.36",
            "--profile=sysadmin",
            "--",
            "chroot",
            "/host",
            "/bin/sh",
            "-c",
            entry,
        ]
        .into_iter()
        .map(String::from),
    );
    Ok(argv)
}

/// Build the `kubectl exec -it` argv for an interactive terminal.
fn terminal_exec_argv(app: &AppHandle, input: &TerminalOpenInput) -> Result<Vec<String>, String> {
    let runtime_input = LocalRuntimeInput {
        cluster_name: input.cluster_name.clone(),
        namespace: input.namespace.clone(),
        ..Default::default()
    };
    let cfg = resolve_runtime_config(app, &runtime_input)?;
    let mut argv = vec!["kubectl".to_string()];
    argv.extend(kube_target_args(input.engine.as_deref(), &cfg.cluster_name)?);
    argv.push("-n".to_string());
    argv.push(cfg.namespace.clone());
    argv.push("exec".to_string());
    argv.push("-it".to_string());
    if let Some(c) = input.container.as_deref() {
        argv.push("-c".to_string());
        argv.push(c.to_string());
    }
    argv.push(input.target.clone());
    argv.push("--".to_string());
    match input.command.as_deref() {
        Some(cmd) if !cmd.is_empty() => argv.extend(cmd.iter().cloned()),
        _ => argv.push("/bin/sh".to_string()),
    }
    Ok(argv)
}

#[tauri::command]
async fn terminal_open(
    app: AppHandle,
    input: TerminalOpenInput,
    on_event: Channel<terminal::TermEvent>,
) -> Result<String, String> {
    // "dev"/"host" open a shell into the microVM host (kubectl debug +
    // chroot); anything else is a `kubectl exec` into the pod.
    let argv = match input.mode.as_deref() {
        Some("dev") => microvm_host_shell_argv(&input, true).await?,
        Some("host") => microvm_host_shell_argv(&input, false).await?,
        _ => terminal_exec_argv(&app, &input)?,
    };
    let id = uuid::Uuid::new_v4().to_string();
    terminal::open(id.clone(), argv, input.cols, input.rows, on_event)?;
    Ok(id)
}

#[tauri::command]
async fn terminal_write(id: String, data: String) -> Result<(), String> {
    terminal::write(&id, &data)
}

#[tauri::command]
async fn terminal_resize(id: String, cols: u16, rows: u16) -> Result<(), String> {
    terminal::resize(&id, cols, rows)
}

#[tauri::command]
async fn terminal_close(id: String) -> Result<(), String> {
    terminal::close(&id)
}

/// Sweep the `node-debugger-*` pods that `kubectl debug node/` leaves
/// behind, so repeated dev/host shells don't accumulate Completed pods.
/// The frontend calls this when a dev-shell terminal closes. Best-
/// effort and cosmetic — mirrors cleanupNodeDebuggerPods in the CLI.
#[tauri::command]
async fn microvm_dev_cleanup(name: Option<String>) -> Result<(), String> {
    let name = vm_name(name);
    let home = home_dir().ok_or("cannot resolve the home directory")?;
    let kubeconfig = home
        .join(SHARED_PROFILES_DIR)
        .join("vm")
        .join(&name)
        .join("kubeconfig.yaml");
    if !kubeconfig.is_file() {
        return Ok(()); // VM gone — nothing to sweep.
    }
    let kc = kubeconfig.to_string_lossy().to_string();
    let (ok, stdout, _) = run_status_command(&[
        "kubectl",
        "--kubeconfig",
        &kc,
        "get",
        "pods",
        "-o",
        "jsonpath={.items[*].metadata.name}",
    ])
    .await?;
    if !ok {
        return Ok(());
    }
    let debuggers: Vec<&str> = stdout
        .split_whitespace()
        .filter(|n| n.starts_with("node-debugger-"))
        .collect();
    if debuggers.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = vec!["kubectl", "--kubeconfig", &kc, "delete", "pod", "--wait=false"];
    args.extend(debuggers);
    let _ = run_status_command(&args).await;
    Ok(())
}

// ============================================================
// Build + deploy from a local source folder.
//
// Driven by the desktop's deploy wizard: pick a folder containing an
// appliance.json manifest, optionally override env/runtime params,
// then build the image with docker + push to the local cluster's
// registry. The actual api-server build + deploy calls run from the
// frontend using the existing SDK (it already holds the cluster's
// signed credentials, so we don't reimplement that in Rust).
// ============================================================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplianceManifestInfo {
    /// Manifest type / format. Mirrors the JSON manifest's `manifest`
    /// field; informational only.
    #[serde(skip_serializing_if = "Option::is_none")]
    manifest: Option<String>,
    name: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    appliance_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    platform: Option<String>,
    /// Default env values from the manifest, surfaced so the wizard
    /// can prefill the env-var editor.
    #[serde(skip_serializing_if = "Option::is_none")]
    env: Option<serde_json::Value>,
    /// Path to the resolved manifest file (`<dir>/appliance.json`).
    manifest_path: String,
}

/// Probe a folder for an appliance manifest and return its parsed
/// contents. `appliance.json` is read directly. Programmatic .ts/.js
/// manifests are evaluated by spawning the bundled CLI sidecar with
/// `appliance manifest read --json`, which runs the manifest in its
/// QuickJS sandbox (see packages/cli/src/sandbox) and prints the
/// resolved object as a single JSON line on stdout. The CLI binary
/// is the same one shipped to end users, so the desktop and CLI
/// always see the manifest through the same sandbox.
#[tauri::command]
async fn read_appliance_manifest(
    app: AppHandle,
    path: String,
) -> Result<ApplianceManifestInfo, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("not a directory: {}", dir.display()));
    }

    let json_path = dir.join("appliance.json");
    if json_path.exists() {
        let raw = fs::read_to_string(&json_path).map_err(|e| format!("read manifest: {e}"))?;
        let value: serde_json::Value =
            serde_json::from_str(&raw).map_err(|e| format!("parse manifest: {e}"))?;
        return manifest_info_from_value(&value, &json_path);
    }

    // Probe for a programmatic manifest. First hit wins, matching the
    // CLI's resolution order so both surfaces pick the same file.
    let code_manifest = ["appliance.ts", "appliance.mts", "appliance.cts",
                        "appliance.js", "appliance.mjs", "appliance.cjs"]
        .iter()
        .map(|n| dir.join(n))
        .find(|p| p.exists());

    let Some(code_path) = code_manifest else {
        return Err(format!(
            "No appliance manifest found in {} (looked for appliance.json plus .ts/.mts/.cts/.js/.mjs/.cjs)",
            dir.display()
        ));
    };

    let value = evaluate_manifest_via_sidecar(&app, &code_path).await?;
    manifest_info_from_value(&value, &code_path)
}

/// Shape one manifest field-set into the wizard-facing struct. Shared
/// between the JSON fast path and the sandbox-evaluated path.
fn manifest_info_from_value(
    value: &serde_json::Value,
    file_path: &std::path::Path,
) -> Result<ApplianceManifestInfo, String> {
    let name = value
        .get("name")
        .and_then(|n| n.as_str())
        .ok_or_else(|| "manifest is missing 'name'".to_string())?
        .to_string();
    Ok(ApplianceManifestInfo {
        manifest: value
            .get("manifest")
            .and_then(|m| m.as_str())
            .map(String::from),
        name,
        appliance_type: value.get("type").and_then(|t| t.as_str()).map(String::from),
        port: value
            .get("port")
            .and_then(|p| p.as_u64())
            .and_then(|p| u16::try_from(p).ok()),
        platform: value
            .get("platform")
            .and_then(|p| p.as_str())
            .map(String::from),
        env: value.get("env").cloned(),
        manifest_path: file_path.to_string_lossy().to_string(),
    })
}

/// Spawn the bundled `appliance` CLI sidecar with the `manifest read`
/// subcommand. The CLI emits exactly one JSON line on stdout:
///
///     {ok: true, path, manifest}                       (success)
///     {ok: false, kind: 'runtime' | 'validation', error, path?}  (failure)
///
/// We surface the failure as a plain string so the wizard can display
/// it next to the folder picker without any further unwrapping.
async fn evaluate_manifest_via_sidecar(
    app: &AppHandle,
    manifest_path: &std::path::Path,
) -> Result<serde_json::Value, String> {
    let sidecar = app
        .shell()
        .sidecar("appliance")
        .map_err(|e| format!(
            "Bundled appliance CLI is unavailable: {e}. Rebuild with `pnpm --filter @appliance.sh/desktop build` so the CLI binary lands in src-tauri/binaries/."
        ))?
        .args([
            "manifest".to_string(),
            "read".to_string(),
            manifest_path.to_string_lossy().to_string(),
        ]);

    let (mut rx, _child) = sidecar
        .spawn()
        .map_err(|e| format!("failed to spawn appliance CLI: {e}"))?;

    let mut stdout_buf = String::new();
    let mut stderr_buf = String::new();
    let mut exit_code: Option<i32> = None;
    let mut spawn_error: Option<String> = None;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                stdout_buf.push_str(&String::from_utf8_lossy(&bytes));
            }
            CommandEvent::Stderr(bytes) => {
                stderr_buf.push_str(&String::from_utf8_lossy(&bytes));
            }
            CommandEvent::Error(msg) => {
                spawn_error = Some(msg);
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
            }
            _ => {}
        }
    }

    if let Some(msg) = spawn_error {
        return Err(format!("appliance CLI error: {msg}"));
    }

    // The CLI prints exactly one JSON object. Take the last non-empty
    // line so any incidental warnings on stdout don't break parsing.
    let last_json_line = stdout_buf
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .ok_or_else(|| {
            let stderr_tail = stderr_buf.trim();
            if stderr_tail.is_empty() {
                format!(
                    "appliance CLI produced no output (exit code {:?})",
                    exit_code
                )
            } else {
                format!("appliance CLI produced no output (stderr: {stderr_tail})")
            }
        })?;

    let parsed: serde_json::Value = serde_json::from_str(last_json_line)
        .map_err(|e| format!("appliance CLI output was not JSON: {e}: {last_json_line}"))?;

    let ok = parsed.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if !ok {
        let err = parsed
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown error in manifest sandbox")
            .to_string();
        return Err(err);
    }

    parsed
        .get("manifest")
        .cloned()
        .ok_or_else(|| "appliance CLI did not return a manifest object".to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildAndImportInput {
    /// Absolute path of the build context (the folder containing the Dockerfile).
    path: String,
    /// Image tag to build with, e.g. "demo-node-container:latest".
    image_tag: String,
    /// Requested `--platform` (e.g. "linux/amd64"). Overridden to the
    /// host arch for these local-cluster builds — the cluster can't run
    /// anything else — so a cross-arch manifest value never crashloops.
    #[serde(default)]
    platform: Option<String>,
    /// Host-side registry URL to push to (e.g. the microVM's forwarded
    /// in-VM registry `localhost:5052`). The image is tagged
    /// `<registry_url>/<image_tag>` and pushed via `docker push` (with
    /// a host-side `docker save` + `crane push` fallback). The returned
    /// image URI references the registry path so the cluster pulls
    /// through the mirror. Required — local image delivery is
    /// registry-only.
    #[serde(default)]
    registry_url: Option<String>,
}

/// Stream stdout+stderr from a child process onto the channel as
/// `{type:"log", stream:"stdout"|"stderr", message: <line>}` events.
async fn stream_child_to_channel(
    program: &str,
    args: &[String],
    on_event: &Channel<serde_json::Value>,
) -> Result<(), String> {
    let _ = on_event.send(serde_json::json!({
        "type": "log",
        "stream": "meta",
        "message": format!("$ {} {}", program, args.join(" ")),
    }));

    let mut child = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawn {}: {e}", program))?;

    let stdout = child.stdout.take().ok_or("stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("stderr unavailable")?;

    let ch_out = on_event.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = ch_out.send(serde_json::json!({
                "type": "log",
                "stream": "stdout",
                "message": line,
            }));
        }
    });
    let ch_err = on_event.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = ch_err.send(serde_json::json!({
                "type": "log",
                "stream": "stderr",
                "message": line,
            }));
        }
    });

    let status = child.wait().await.map_err(|e| e.to_string())?;
    let _ = stdout_task.await;
    let _ = stderr_task.await;

    if !status.success() {
        return Err(format!("{} exited with status {}", program, status));
    }
    Ok(())
}

/// Build the image with docker, then push it to the cluster's
/// host-side registry. Streams raw command output to the frontend so
/// the wizard can show a live terminal-style log pane.
///
/// Returns the registry-qualified image reference
/// (`<registry_url>/<image_tag>`) the cluster pulls through its mirror,
/// which the caller (the deploy wizard) hands straight to api-server's
/// build resolver. Local image delivery is registry-only.
#[tauri::command]
async fn build_and_import_image(
    input: BuildAndImportInput,
    on_event: Channel<serde_json::Value>,
) -> Result<String, String> {
    // Local image delivery is registry-only now that bare k3d (and its
    // `k3d image import` path) is gone. The deploy wizard resolves the
    // registry from the cluster's /cluster-info before calling here.
    let registry_url = input.registry_url.as_deref().ok_or(
        "no registry configured for this cluster — local image delivery is registry-only \
         (run \"appliance vm up\" to reconcile the in-VM registry)",
    )?;
    // Tag the build with the registry-qualified ref up front so the
    // single `docker build` produces an image already named the way
    // we'll push it. Avoids a separate `docker tag` step.
    let pushable = format!("{}/{}", registry_url, input.image_tag);

    // This command only ever targets a local cluster, which runs this
    // machine's architecture and can't emulate (the microVM has no
    // binfmt). Build for the host arch regardless of any requested
    // platform — a cross-arch image would just crashloop with `exec
    // format error` after an opaque rollout timeout.
    let host_platform = format!(
        "linux/{}",
        if std::env::consts::ARCH == "aarch64" {
            "arm64"
        } else {
            "amd64"
        }
    );
    if let Some(p) = input.platform.as_deref() {
        if p != host_platform.as_str() {
            let _ = on_event.send(serde_json::json!({
                "type": "log",
                "stream": "meta",
                "message": format!(
                    "requested platform {p} can't run on this local cluster ({host_platform}) — building {host_platform} instead"
                ),
            }));
        }
    }
    let build_args: Vec<String> = vec![
        "build".into(),
        "-t".into(),
        pushable.clone(),
        "--platform".into(),
        host_platform,
        input.path.clone(),
    ];
    stream_child_to_channel("docker", &build_args, &on_event).await?;

    // Push, then return the registry-qualified reference so the cluster
    // pulls through its mirror. A plain `docker push` executes inside
    // the docker provider's VM (colima/Docker Desktop), where
    // host-loopback registries (the microVM's forwarded 5052) don't
    // exist — fall back to a host-side `docker save` + `crane push` in
    // that case, exactly like the CLI deploy pipeline.
    let push_args: Vec<String> = vec!["push".into(), pushable.clone()];
    if stream_child_to_channel("docker", &push_args, &on_event)
        .await
        .is_ok()
    {
        return Ok(pushable);
    }
    let _ = on_event.send(serde_json::json!({
        "type": "log",
        "stream": "meta",
        "message": "docker push failed — retrying host-side with crane",
    }));
    crane_push_fallback(&pushable, &on_event).await
}

/// Host-side image delivery for registries the docker daemon cannot
/// reach: `docker save` to a temp tarball, then `crane push
/// --insecure` from this process. Returns the digest-qualified ref so
/// redeploys roll even under a reused tag. crane comes from the
/// helper-managed bin dir (`appliance local install crane`) or PATH.
async fn crane_push_fallback(
    image_ref: &str,
    on_event: &Channel<serde_json::Value>,
) -> Result<String, String> {
    let crane = helper_bin_dir()
        .map(|d| d.join("crane"))
        .filter(|p| p.exists())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "crane".to_string());

    let tar_path = std::env::temp_dir().join(format!("appliance-image-{}.tar", std::process::id()));
    let tar_str = tar_path.to_string_lossy().to_string();
    let save_args: Vec<String> = vec!["save".into(), "-o".into(), tar_str.clone(), image_ref.into()];
    stream_child_to_channel("docker", &save_args, on_event).await?;

    let result = run_status_command(&[&crane, "push", "--insecure", &tar_str, image_ref]).await;
    let _ = std::fs::remove_file(&tar_path);
    let (ok, stdout, stderr) = result?;
    if !ok {
        return Err(format!(
            "crane push failed: {} (install crane with `appliance local install crane`)",
            stderr.trim()
        ));
    }
    // crane prints the digest-qualified reference as its final line.
    let digest_ref = stdout
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .unwrap_or(image_ref)
        .to_string();
    if !digest_ref.contains("@sha256:") {
        return Ok(image_ref.to_string());
    }
    let _ = on_event.send(serde_json::json!({
        "type": "log",
        "stream": "meta",
        "message": format!("pushed {digest_ref}"),
    }));
    Ok(digest_ref)
}

/// Resolve the helper-managed bin dir (`~/.appliance/bin` on POSIX,
/// `%LOCALAPPDATA%\Appliance\bin` on Windows) so we can prepend it to
/// PATH before spawning child processes. Mirrors `helperBinDir()` in
/// `@appliance.sh/helper` — both sides must agree on the location for
/// `appliance local install` (Node) to land binaries the desktop's
/// `Command::new("kubectl")` calls then pick up.
fn helper_bin_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            return Some(PathBuf::from(local).join("Appliance").join("bin"));
        }
    }
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".appliance").join("bin"))
}

/// Prepend the helper bin dir to this process's PATH so every
/// downstream `Command::new(...)` sees `~/.appliance/bin/kubectl` etc.
/// without each call site having to manage env vars. Idempotent.
fn ensure_helper_bin_on_path() {
    let Some(dir) = helper_bin_dir() else {
        return;
    };
    prepend_to_path(&[dir]);
}

/// macOS GUI apps (anything launched from Finder, the Dock, or
/// Spotlight) inherit a stripped-down PATH like
/// `/usr/bin:/bin:/usr/sbin:/sbin`. Tools the user installed via
/// Homebrew (`/opt/homebrew/bin` on Apple Silicon, `/usr/local/bin`
/// on Intel) or pip/cargo's `~/.local/bin` are nowhere to be found,
/// so `Command::new("docker")` returns ENOENT even when `which docker`
/// works fine in Terminal. The user's shell rc files (.zshrc /
/// .bashrc) are NOT sourced for GUI launches.
///
/// We pre-populate PATH with the canonical user-bin dirs so
/// downstream spawns of docker / kubectl / git / etc. resolve
/// the same binaries the user runs from their shell. Existence
/// filtering avoids littering PATH with non-existent entries.
fn ensure_user_paths_on_path() {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if cfg!(target_os = "macos") {
        candidates.extend([
            // Homebrew on Apple Silicon.
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/opt/homebrew/sbin"),
            // Homebrew on Intel + common manual installs.
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/local/sbin"),
            // MacPorts.
            PathBuf::from("/opt/local/bin"),
            PathBuf::from("/opt/local/sbin"),
        ]);
    } else if cfg!(target_os = "linux") {
        candidates.extend([
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/local/sbin"),
            PathBuf::from("/snap/bin"),
            PathBuf::from("/var/lib/flatpak/exports/bin"),
        ]);
    }

    if !cfg!(target_os = "windows") {
        if let Ok(home) = std::env::var("HOME") {
            let home = PathBuf::from(home);
            candidates.push(home.join(".local").join("bin"));
            // cargo, mise, asdf shims; cheap to include since
            // prepend_to_path filters missing entries.
            candidates.push(home.join(".cargo").join("bin"));
            candidates.push(home.join(".local").join("share").join("mise").join("shims"));
            candidates.push(home.join(".asdf").join("shims"));
        }
    }

    let existing: Vec<PathBuf> = candidates
        .into_iter()
        .filter(|p| p.is_dir())
        .collect();
    prepend_to_path(&existing);
}

/// Prepend any dirs not already on PATH, preserving order. Skips
/// empty / unresolvable paths and dirs that are already present so
/// repeat calls are no-ops.
fn prepend_to_path(dirs: &[PathBuf]) {
    if dirs.is_empty() {
        return;
    }
    let sep = if cfg!(target_os = "windows") { ';' } else { ':' };
    let current = std::env::var("PATH").unwrap_or_default();
    let existing: std::collections::HashSet<&str> = current.split(sep).collect();

    let mut prefix = String::new();
    for dir in dirs {
        let Some(dir_str) = dir.to_str() else { continue };
        if existing.contains(dir_str) || prefix.split(sep).any(|p| p == dir_str) {
            continue;
        }
        if !prefix.is_empty() {
            prefix.push(sep);
        }
        prefix.push_str(dir_str);
    }
    if prefix.is_empty() {
        return;
    }
    let next = if current.is_empty() {
        prefix
    } else {
        format!("{prefix}{sep}{current}")
    };
    // Safety: set_var is unsafe in newer Rust because env mutation
    // races other threads. We call it once at startup before any
    // tokio runtime is up.
    unsafe { std::env::set_var("PATH", next) };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Order matters: user paths first so Homebrew etc. resolve before
    // any helper-installed fallback. The helper dir is then prepended
    // on top — its binaries win when both system + helper have a
    // copy, which keeps versioning predictable.
    ensure_user_paths_on_path();
    ensure_helper_bin_on_path();
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init());

    // Self-update is a desktop-only capability: the updater plugin pulls
    // a signed bundle from the feed in tauri.conf.json and swaps the app
    // in place, and `process::relaunch` restarts into the new version.
    // Mobile targets have no equivalent (app-store managed), so gate
    // both plugins behind `#[cfg(desktop)]` to keep the mobile build
    // compiling.
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

    builder
        .setup(|app| {
            // Adopt CLI-registered microVM clusters at launch —
            // `appliance vm up` may have run (for any VM) while the
            // desktop was closed, and the cluster switcher should
            // reflect each one without a visit to the Runtimes page.
            // Off the main thread: keychain + file IO, and launch
            // shouldn't block.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Stage-1 single-source-of-truth seed: fold any
                // keychain-only secret into profiles.json before
                // anything else reads it, so the shared store is the
                // complete, authoritative copy. Non-destructive and
                // idempotent — see seed_profiles_from_keychain.
                if let Err(e) = seed_desktop_profiles(&handle) {
                    eprintln!("warn: credential seed at launch failed: {e}");
                }
                let names = match microvm_list().await {
                    Ok(vms) => vms.into_iter().map(|v| v.name).collect::<Vec<_>>(),
                    Err(_) => vec![MICROVM_NAME.to_string()],
                };
                for name in names {
                    if let Err(e) = sync_microvm_cluster(&handle, &name) {
                        eprintln!("warn: microvm cluster sync at launch failed for '{name}': {e}");
                    }
                }
            });
            Ok(())
        })
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
            local_helper_install,
            local_preflight,
            start_container_runtime,
            list_local_workloads,
            tail_local_pod_logs,
            read_appliance_manifest,
            build_and_import_image,
            bootstrap_in_cluster_api_server,
            microvm_list,
            microvm_status,
            microvm_install,
            microvm_up,
            microvm_dev_up,
            microvm_dev_cleanup,
            microvm_stop,
            microvm_delete,
            microvm_egress_get,
            microvm_egress_default,
            microvm_egress_rule,
            microvm_egress_mitm,
            microvm_egress_reset,
            microvm_egress_log,
            microvm_egress_clear_log,
            microvm_creds_list,
            microvm_creds_add,
            microvm_creds_remove,
            microvm_creds_set,
            microvm_creds_forget,
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- stage-1 credential seed (decide_seed) -------------------

    fn test_cluster(id: &str) -> Cluster {
        Cluster {
            id: id.to_string(),
            name: "Prod".to_string(),
            api_server_url: "https://api.example.com".to_string(),
            created_at: "2024-01-01T00:00:00Z".to_string(),
            state_backend_url: None,
            last_bootstrap_input: None,
            synced_key_id: None,
        }
    }

    fn key(id: &str, secret: &str) -> ApiKey {
        ApiKey {
            id: id.to_string(),
            secret: secret.to_string(),
        }
    }

    #[test]
    fn seeds_keychain_only_secret_into_profiles() {
        // The core case: secret lives only in the keychain, no shared
        // entry yet. It must be folded into profiles.json with the
        // cluster's metadata and a "desktop" surface marker.
        let cluster = test_cluster("prod");
        let k = key("key-1", "s3cr3t");
        match decide_seed(&cluster, Some(&k), None) {
            SeedDecision::Seed { cluster_id, entry } => {
                assert_eq!(cluster_id, "prod");
                assert_eq!(entry.key_id, "key-1");
                assert_eq!(entry.secret, "s3cr3t");
                assert_eq!(entry.api_url, "https://api.example.com");
                assert_eq!(entry.managed.as_deref(), Some("desktop"));
                assert_eq!(entry.name.as_deref(), Some("Prod"));
                assert_eq!(entry.created_at.as_deref(), Some("2024-01-01T00:00:00Z"));
            }
            other => panic!("expected Seed, got {other:?}"),
        }
    }

    #[test]
    fn does_not_overwrite_existing_authoritative_secret() {
        // profiles.json already holds a non-empty secret — it is the
        // source of truth and must NOT be clobbered by the keychain
        // (which may be a stale derived copy after a CLI re-key).
        let cluster = test_cluster("prod");
        let keychain = key("old-key", "stale");
        let existing = SharedProfileEntry {
            api_url: "https://api.example.com".to_string(),
            key_id: "new-key".to_string(),
            secret: "fresh".to_string(),
            managed: Some("cli".to_string()),
            ..Default::default()
        };
        assert_eq!(
            decide_seed(&cluster, Some(&keychain), Some(&existing)),
            SeedDecision::AlreadySeeded
        );
    }

    #[test]
    fn is_idempotent_on_already_seeded_entry() {
        // Re-running after a successful seed (keychain and shared agree)
        // is a no-op — guards against repeated writes on every launch.
        let cluster = test_cluster("prod");
        let k = key("key-1", "s3cr3t");
        let existing = SharedProfileEntry {
            api_url: "https://api.example.com".to_string(),
            key_id: "key-1".to_string(),
            secret: "s3cr3t".to_string(),
            managed: Some("desktop".to_string()),
            ..Default::default()
        };
        assert_eq!(
            decide_seed(&cluster, Some(&k), Some(&existing)),
            SeedDecision::AlreadySeeded
        );
    }

    #[test]
    fn seeds_when_shared_entry_has_empty_secret() {
        // mirror_to_shared_profiles' placeholder path could write an
        // entry with metadata but an empty secret. That is NOT
        // authoritative, so a keychain secret should still seed it —
        // and preserve the placeholder's metadata.
        let cluster = test_cluster("prod");
        let k = key("key-1", "s3cr3t");
        let existing = SharedProfileEntry {
            api_url: "https://api.example.com".to_string(),
            key_id: String::new(),
            secret: String::new(),
            name: Some("Renamed Prod".to_string()),
            managed: Some("desktop".to_string()),
            ..Default::default()
        };
        match decide_seed(&cluster, Some(&k), Some(&existing)) {
            SeedDecision::Seed { entry, .. } => {
                assert_eq!(entry.secret, "s3cr3t");
                assert_eq!(entry.key_id, "key-1");
                // Existing metadata wins over the cluster's copy.
                assert_eq!(entry.name.as_deref(), Some("Renamed Prod"));
            }
            other => panic!("expected Seed, got {other:?}"),
        }
    }

    #[test]
    fn nothing_to_seed_without_keychain_secret() {
        // No keychain entry and no shared secret: don't fabricate an
        // empty profile. Leave the (meta-only or absent) state alone.
        let cluster = test_cluster("prod");
        assert_eq!(decide_seed(&cluster, None, None), SeedDecision::NothingToSeed);
    }

    #[test]
    fn nothing_to_seed_on_blank_keychain_secret() {
        // A malformed/blank keychain payload must not produce an empty
        // authoritative secret — that's worse than leaving it unset.
        let cluster = test_cluster("prod");
        let blank = key("", "");
        assert_eq!(
            decide_seed(&cluster, Some(&blank), None),
            SeedDecision::NothingToSeed
        );
        let no_id = key("", "secret");
        assert_eq!(
            decide_seed(&cluster, Some(&no_id), None),
            SeedDecision::NothingToSeed
        );
    }
}
