//! Minimal writer for the shared credential store at
//! `~/.appliance/profiles.json`.
//!
//! The store is owned by the CLI (packages/cli/src/utils/profile-store.ts)
//! and also read/written by the desktop. The engine only needs one
//! operation — upsert the credential profile(s) a VM owns after minting
//! its first api key at bring-up — but it must be a *faithful* citizen
//! of the existing protocol:
//!
//! * cross-process advisory lock via an O_EXCL `profiles.json.lock`
//!   (steal when stale, proceed unlocked after a short wait — blocking
//!   a boot on a wedged lock is worse than last-writer-wins);
//! * atomic temp+rename writes, file mode 0600;
//! * the legacy `credentials.json` mirror of the active profile;
//! * never dropping fields it doesn't understand.
//!
//! That last point is why this module edits `serde_json::Value` trees
//! instead of typed structs: the CLI and desktop both attach metadata
//! (`stateBackendUrl`, `lastBootstrapInput`, `name`, …) that a typed
//! round-trip here would silently strip from entries we don't touch.

use std::path::PathBuf;
use std::time::Duration;

/// A lock held longer than this is presumed orphaned (crashed holder)
/// and may be stolen. Mirrors LOCK_STALE_MS in profile-store.ts.
const LOCK_STALE: Duration = Duration::from_secs(10);
/// Total time to wait for a contended lock before proceeding anyway.
/// Mirrors LOCK_TIMEOUT_MS in profile-store.ts.
const LOCK_TIMEOUT: Duration = Duration::from_secs(2);

fn appliance_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".appliance"))
}

/// The credential upsert `mint_profile` persists.
pub struct ProfileCredentials {
    pub api_url: String,
    pub key_id: String,
    pub secret: String,
}

/// The profile ids a VM's credentials live under. The default VM owns
/// the CLI-canonical `local` profile plus the legacy `microvm` id the
/// desktop's cluster registry reads; other VMs get `microvm-<name>`.
/// First entry is the primary. Mirrors profileForVm +
/// persistVmCredentials in packages/cli/src/utils/microvm-up.ts.
pub fn vm_profile_ids(vm_name: &str) -> Vec<String> {
    if vm_name == crate::spec::DEFAULT_VM_NAME {
        vec!["local".to_string(), "microvm".to_string()]
    } else {
        vec![format!("microvm-{vm_name}")]
    }
}

/// Upsert `credentials` under each of `profile_names`, preserving any
/// existing entry's `createdAt` and every field this writer doesn't
/// know about. `activeProfile` is only claimed when none is set — the
/// engine mint is a bring-up safety net, not a user-facing "switch to
/// this cluster" action (the CLI's `vm up` keeps that behavior).
///
/// Returns `Err` only for real write failures; a missing HOME resolves
/// to a no-op `Ok` (nowhere to write, nothing to corrupt).
pub fn upsert_vm_credentials(
    profile_names: &[String],
    credentials: &ProfileCredentials,
) -> Result<(), String> {
    let Some(dir) = appliance_dir() else {
        return Ok(());
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    let _lock = ProfilesLock::acquire(dir.join("profiles.json.lock"));

    let path = dir.join("profiles.json");
    let mut file: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(
            || serde_json::json!({ "version": 1, "activeProfile": null, "profiles": {} }),
        );
    if !file.is_object() {
        file = serde_json::json!({ "version": 1, "activeProfile": null, "profiles": {} });
    }
    let root = file.as_object_mut().expect("normalized to object above");
    if !root.get("profiles").is_some_and(|p| p.is_object()) {
        root.insert("profiles".into(), serde_json::json!({}));
    }

    let now = now_iso8601();
    let profiles = root
        .get_mut("profiles")
        .and_then(|p| p.as_object_mut())
        .expect("normalized to object above");
    for name in profile_names {
        let created_at = profiles
            .get(name)
            .and_then(|e| e.get("createdAt"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| now.clone());
        let entry = profiles
            .entry(name.clone())
            .or_insert_with(|| serde_json::json!({}));
        if !entry.is_object() {
            *entry = serde_json::json!({});
        }
        let entry = entry.as_object_mut().expect("normalized to object above");
        entry.insert("apiUrl".into(), credentials.api_url.clone().into());
        entry.insert("keyId".into(), credentials.key_id.clone().into());
        entry.insert("secret".into(), credentials.secret.clone().into());
        entry.insert("createdAt".into(), created_at.into());
        // `managed` is informational ("desktop" | "cli"); the engine
        // writes the same entries the CLI's `vm up` would have.
        entry
            .entry("managed".to_string())
            .or_insert_with(|| "cli".into());
    }

    // Claim the active slot only when nothing else holds it, so a
    // fresh install's first VM becomes usable without stealing a
    // user's selected profile on later boots.
    let active_is_unset = root
        .get("activeProfile")
        .map(|v| v.is_null())
        .unwrap_or(true);
    if active_is_unset {
        if let Some(first) = profile_names.first() {
            root.insert("activeProfile".into(), first.clone().into());
        }
    }

    // Mirror the active profile to the legacy credentials.json, exactly
    // as the CLI's writeProfiles does, so a pre-multi-profile reader
    // keeps working after the engine's write. Computed before the file
    // write so the mutable borrow of the tree has ended by then.
    let legacy = root
        .get("activeProfile")
        .and_then(|v| v.as_str())
        .and_then(|active| root.get("profiles").and_then(|p| p.get(active)))
        .and_then(|e| e.as_object())
        .map(|entry| {
            serde_json::json!({
                "apiUrl": entry.get("apiUrl").cloned().unwrap_or_default(),
                "keyId": entry.get("keyId").cloned().unwrap_or_default(),
                "secret": entry.get("secret").cloned().unwrap_or_default(),
            })
        });

    atomic_write_json(&path, &file)?;
    if let Some(legacy) = legacy {
        atomic_write_json(&dir.join("credentials.json"), &legacy)?;
    }
    Ok(())
}

/// Remove a credential profile — the engine-side counterpart of the
/// CLI's removeProfile (profile-store.ts), so `appliance-vm delete`
/// prunes the profiles a deleted VM owned instead of leaving orphan
/// clusters behind in the CLI and desktop. Same protocol as the upsert:
/// lock, edit the raw tree (never dropping unknown fields), atomic
/// write, legacy credentials.json mirror.
///
/// Returns `Ok(true)` when a profile was actually removed; `Ok(false)`
/// when it didn't exist (or there is nowhere to read from).
pub fn remove_profile(profile_name: &str) -> Result<bool, String> {
    let Some(dir) = appliance_dir() else {
        return Ok(false);
    };
    let path = dir.join("profiles.json");
    // Lock BEFORE the read: this is a read-modify-write, and reading
    // outside the lock could drop a concurrent writer's update.
    let _lock = ProfilesLock::acquire(dir.join("profiles.json.lock"));
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Ok(false);
    };
    let mut file: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        // An unparseable store is not ours to "fix" by rewriting it.
        Err(_) => return Ok(false),
    };
    if !remove_profile_from_tree(&mut file, profile_name) {
        return Ok(false);
    }
    let legacy = legacy_mirror_of(&file);
    atomic_write_json(&path, &file)?;
    let legacy_path = dir.join("credentials.json");
    match legacy {
        Some(legacy) => atomic_write_json(&legacy_path, &legacy)?,
        // No active profile any more — clear the legacy mirror so a
        // downgraded CLI doesn't keep using stale creds (mirrors
        // writeProfiles in profile-store.ts). Best-effort.
        None => {
            let _ = std::fs::remove_file(&legacy_path);
        }
    }
    Ok(true)
}

/// Pure tree edit for `remove_profile`: drop the entry and, when it was
/// the active profile, fall back to the first remaining profile (or
/// null when the store is now empty) — the activeProfile rule of
/// removeProfile in profile-store.ts. ("First" here is serde_json's
/// sorted key order rather than JS insertion order; both are arbitrary
/// fallbacks, not a contract.) Returns whether the profile existed.
fn remove_profile_from_tree(file: &mut serde_json::Value, profile_name: &str) -> bool {
    let Some(profiles) = file.get_mut("profiles").and_then(|p| p.as_object_mut()) else {
        return false;
    };
    if profiles.remove(profile_name).is_none() {
        return false;
    }
    let next_active = profiles.keys().next().cloned();
    let was_active = file
        .get("activeProfile")
        .and_then(|v| v.as_str())
        .is_some_and(|active| active == profile_name);
    if was_active {
        if let Some(root) = file.as_object_mut() {
            root.insert(
                "activeProfile".into(),
                next_active.map(Into::into).unwrap_or(serde_json::Value::Null),
            );
        }
    }
    true
}

/// The legacy credentials.json payload mirroring the active profile,
/// or None when no active profile exists (the mirror must be cleared).
/// Matches writeProfiles in profile-store.ts.
fn legacy_mirror_of(file: &serde_json::Value) -> Option<serde_json::Value> {
    let active = file.get("activeProfile")?.as_str()?;
    let entry = file.get("profiles")?.get(active)?.as_object()?;
    Some(serde_json::json!({
        "apiUrl": entry.get("apiUrl").cloned().unwrap_or_default(),
        "keyId": entry.get("keyId").cloned().unwrap_or_default(),
        "secret": entry.get("secret").cloned().unwrap_or_default(),
    }))
}

/// Read a profile's stored key id, if the entry exists and carries one.
/// Used by the bring-up mint to decide whether the host already holds a
/// credential for this VM.
pub fn profile_key_id(profile_name: &str) -> Option<String> {
    let path = appliance_dir()?.join("profiles.json");
    let raw = std::fs::read_to_string(path).ok()?;
    let file: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let key_id = file
        .get("profiles")?
        .get(profile_name)?
        .get("keyId")?
        .as_str()?
        .to_string();
    if key_id.is_empty() {
        None
    } else {
        Some(key_id)
    }
}

fn atomic_write_json(path: &std::path::Path, value: &serde_json::Value) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(value).map_err(|e| format!("serialize: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, raw).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("rename {}: {e}", path.display()))?;
    Ok(())
}

/// RFC 3339 UTC timestamp without a chrono dependency — seconds
/// precision is plenty for an informational createdAt.
fn now_iso8601() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    epoch_to_iso8601(secs)
}

/// Civil-from-days (Howard Hinnant) conversion, mirroring the approach
/// the vz clock-sync already uses — no dependency for one timestamp.
fn epoch_to_iso8601(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mth <= 2 { y + 1 } else { y };
    format!("{y:04}-{mth:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

/// Advisory cross-process lock via an O_EXCL lockfile. Mirrors
/// withProfilesLock in profile-store.ts: steal a stale lock, and after
/// LOCK_TIMEOUT give up and proceed unlocked rather than block a boot.
struct ProfilesLock {
    path: Option<PathBuf>,
}

impl ProfilesLock {
    fn acquire(path: PathBuf) -> Self {
        let deadline = std::time::Instant::now() + LOCK_TIMEOUT;
        loop {
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(_) => return Self { path: Some(path) },
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = std::fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|mtime| mtime.elapsed().ok())
                        .is_some_and(|age| age > LOCK_STALE);
                    if stale {
                        let _ = std::fs::remove_file(&path);
                        continue;
                    }
                    if std::time::Instant::now() >= deadline {
                        // Proceed unlocked: writes stay atomic, so the
                        // worst case is last-writer-wins, not corruption.
                        return Self { path: None };
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                // Unwritable dir etc. — run without the lock.
                Err(_) => return Self { path: None },
            }
        }
    }
}

impl Drop for ProfilesLock {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_vm_owns_local_and_legacy_microvm_profiles() {
        assert_eq!(vm_profile_ids("appliance"), vec!["local", "microvm"]);
        assert_eq!(vm_profile_ids("claude"), vec!["microvm-claude"]);
    }

    fn store(active: Option<&str>, names: &[&str]) -> serde_json::Value {
        let mut profiles = serde_json::Map::new();
        for name in names {
            profiles.insert(
                name.to_string(),
                serde_json::json!({
                    "apiUrl": format!("http://api.appliance.localhost:8081/{name}"),
                    "keyId": format!("key-{name}"),
                    "secret": format!("s3cret-{name}"),
                    // A field this writer doesn't know about must survive.
                    "stateBackendUrl": "s3://state",
                }),
            );
        }
        serde_json::json!({
            "version": 1,
            "activeProfile": active,
            "profiles": profiles,
        })
    }

    #[test]
    fn removing_a_missing_profile_is_a_no_op() {
        let mut file = store(Some("local"), &["local"]);
        let before = file.clone();
        assert!(!remove_profile_from_tree(&mut file, "microvm-ghost"));
        assert_eq!(file, before, "a miss must not rewrite anything");
    }

    #[test]
    fn removing_an_inactive_profile_keeps_the_active_slot() {
        let mut file = store(Some("local"), &["local", "microvm-x"]);
        assert!(remove_profile_from_tree(&mut file, "microvm-x"));
        assert_eq!(file["activeProfile"], "local");
        assert!(file["profiles"].get("microvm-x").is_none());
        // Untouched entries keep their unknown fields.
        assert_eq!(file["profiles"]["local"]["stateBackendUrl"], "s3://state");
    }

    #[test]
    fn removing_the_active_profile_falls_back_to_a_remaining_one() {
        let mut file = store(Some("local"), &["local", "prod"]);
        assert!(remove_profile_from_tree(&mut file, "local"));
        assert_eq!(file["activeProfile"], "prod");
        // The legacy mirror follows the new active profile.
        let legacy = legacy_mirror_of(&file).expect("an active profile mirrors");
        assert_eq!(legacy["keyId"], "key-prod");
        assert_eq!(legacy["secret"], "s3cret-prod");
    }

    #[test]
    fn removing_the_last_profile_clears_active_and_the_mirror() {
        let mut file = store(Some("local"), &["local"]);
        assert!(remove_profile_from_tree(&mut file, "local"));
        assert!(file["activeProfile"].is_null());
        // No active profile → the caller must delete credentials.json.
        assert!(legacy_mirror_of(&file).is_none());
    }

    #[test]
    fn epoch_converts_to_civil_utc() {
        assert_eq!(epoch_to_iso8601(0), "1970-01-01T00:00:00Z");
        // 2026-07-13T00:00:00Z
        assert_eq!(epoch_to_iso8601(1_783_900_800), "2026-07-13T00:00:00Z");
        // Leap-day: 2024-02-29T00:00:00Z is epoch 1709164800; +44696s.
        assert_eq!(epoch_to_iso8601(1_709_209_496), "2024-02-29T12:24:56Z");
    }
}
