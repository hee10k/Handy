//! API-key storage abstraction.
//!
//! Stores provider API keys in native secure storage (macOS Keychain /
//! Windows Credential Manager) on supported platforms, and in settings
//! `post_process_api_keys` on Linux.
//!
//! When starting on macOS/Windows, a verified one-way migration moves any
//! non-empty keys still present in the settings SecretMap into the OS keyring
//! and clears the plaintext copies upon verified readback.

use crate::settings::{mutate_settings_secret, read_settings_secret_map};
use log::{info, warn};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;
use tauri::AppHandle;

/// Every API key is redacted from `Debug` output so a stray `{:?}` in logs or
/// tests can never leak a secret.
pub struct Secret<'a>(pub &'a str);

impl fmt::Debug for Secret<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.0.is_empty() {
            f.write_str("<empty>")
        } else {
            f.write_str("[REDACTED]")
        }
    }
}

/// Errors reading or writing secrets. Messages never include key material.
#[derive(Debug, Clone)]
pub enum SecretError {
    /// Backend could not write/read (I/O, keyring failure, settings store error).
    Store(String),
    /// Backend is compiled out or unavailable on this platform.
    Unavailable(String),
}

impl fmt::Display for SecretError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SecretError::Store(msg) => write!(f, "Secret store error: {}", msg),
            SecretError::Unavailable(msg) => write!(f, "{}", msg),
        }
    }
}

impl std::error::Error for SecretError {}

/// Where API keys live. Implementations must never leak key material into
/// error messages or logs.
pub trait ApiKeyStore {
    fn get(&self, provider_id: &str) -> Result<Option<String>, SecretError>;
    fn set(&self, provider_id: &str, key: &str) -> Result<(), SecretError>;
    fn delete(&self, provider_id: &str) -> Result<(), SecretError>;
}

/// Settings-backed store (`post_process_api_keys` SecretMap).
/// Used on Linux as the primary store, and on macOS/Windows as the migration source.
pub struct SettingsApiKeyStore {
    app: AppHandle,
}

impl SettingsApiKeyStore {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl ApiKeyStore for SettingsApiKeyStore {
    fn get(&self, provider_id: &str) -> Result<Option<String>, SecretError> {
        read_settings_secret_map(&self.app)
            .map(|keys| {
                keys.get(provider_id)
                    .cloned()
                    .filter(|key| !key.trim().is_empty())
            })
            .map_err(SecretError::Store)
    }

    fn set(&self, provider_id: &str, key: &str) -> Result<(), SecretError> {
        mutate_settings_secret(&self.app, provider_id, Some(key)).map_err(SecretError::Store)
    }

    fn delete(&self, provider_id: &str) -> Result<(), SecretError> {
        mutate_settings_secret(&self.app, provider_id, None).map_err(SecretError::Store)
    }
}

/// Keyring-backed store for macOS and Windows.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub struct KeyringApiKeyStore;

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl ApiKeyStore for KeyringApiKeyStore {
    fn get(&self, provider_id: &str) -> Result<Option<String>, SecretError> {
        let entry = keyring::Entry::new("com.hee10k.tajagi.api-keys", provider_id)
            .map_err(|_| SecretError::Store("Native credential entry unavailable".into()))?;
        match entry.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(SecretError::Store(
                "Unable to read native credential".into(),
            )),
        }
    }

    fn set(&self, provider_id: &str, key: &str) -> Result<(), SecretError> {
        let entry = keyring::Entry::new("com.hee10k.tajagi.api-keys", provider_id)
            .map_err(|_| SecretError::Store("Native credential entry unavailable".into()))?;
        entry
            .set_password(key)
            .map_err(|_| SecretError::Store("Unable to write native credential".into()))?;
        Ok(())
    }

    fn delete(&self, provider_id: &str) -> Result<(), SecretError> {
        let entry = keyring::Entry::new("com.hee10k.tajagi.api-keys", provider_id)
            .map_err(|_| SecretError::Store("Native credential entry unavailable".into()))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(SecretError::Store(
                "Unable to delete native credential".into(),
            )),
        }
    }
}

#[cfg(test)]
/// In-memory store for unit tests and the migration test suite.
pub struct MemoryApiKeyStore {
    keys: std::sync::Mutex<HashMap<String, String>>,
}

#[cfg(test)]
impl MemoryApiKeyStore {
    pub fn new(keys: HashMap<String, String>) -> Self {
        Self {
            keys: std::sync::Mutex::new(keys),
        }
    }
}

#[cfg(test)]
impl ApiKeyStore for MemoryApiKeyStore {
    fn get(&self, provider_id: &str) -> Result<Option<String>, SecretError> {
        self.keys
            .lock()
            .map(|keys| {
                keys.get(provider_id)
                    .cloned()
                    .filter(|key| !key.trim().is_empty())
            })
            .map_err(|_| SecretError::Store("Test memory store synchronization failed".into()))
    }

    fn set(&self, provider_id: &str, key: &str) -> Result<(), SecretError> {
        self.keys
            .lock()
            .map_err(|_| SecretError::Store("Test memory store synchronization failed".into()))?
            .insert(provider_id.to_string(), key.to_string());
        Ok(())
    }

    fn delete(&self, provider_id: &str) -> Result<(), SecretError> {
        self.keys
            .lock()
            .map_err(|_| SecretError::Store("Test memory store synchronization failed".into()))?
            .remove(provider_id);
        Ok(())
    }
}

/// Resolve the API key for a provider through the active store.
pub fn get_api_key(app: &AppHandle, provider_id: &str) -> Result<Option<String>, SecretError> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let mut state = CREDENTIAL_STATE.lock().map_err(|_| {
            SecretError::Unavailable("Credential synchronization unavailable".into())
        })?;
        let _ = app;
        get_native_key(&mut state, &KeyringApiKeyStore, provider_id)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        SettingsApiKeyStore::new(app.clone()).get(provider_id)
    }
}

/// Write an API key, targeting the OS keyring on macOS/Windows and settings on Linux.
pub fn set_api_key(app: &AppHandle, provider_id: &str, key: &str) -> Result<(), SecretError> {
    if key.trim().is_empty() {
        return delete_api_key(app, provider_id);
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let mut state = CREDENTIAL_STATE.lock().map_err(|_| {
            SecretError::Unavailable("Credential synchronization unavailable".into())
        })?;
        set_native_key(
            &mut state,
            &SettingsApiKeyStore::new(app.clone()),
            &KeyringApiKeyStore,
            provider_id,
            key,
        )
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        SettingsApiKeyStore::new(app.clone()).set(provider_id, key)
    }
}

/// Delete an API key, clearing native credentials on macOS/Windows and settings on all platforms.
pub fn delete_api_key(app: &AppHandle, provider_id: &str) -> Result<(), SecretError> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let mut state = CREDENTIAL_STATE.lock().map_err(|_| {
            SecretError::Unavailable("Credential synchronization unavailable".into())
        })?;
        delete_native_key(
            &mut state,
            &SettingsApiKeyStore::new(app.clone()),
            &KeyringApiKeyStore,
            provider_id,
        )
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        SettingsApiKeyStore::new(app.clone()).delete(provider_id)
    }
}

/// Detailed outcome of migrating an individual provider's key.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MigrationOutcome {
    Migrated,
    Skipped,
    Conflict,
    Incomplete,
    Failed(String),
}

/// Status of the one-way credential migration.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, specta::Type)]
pub struct MigrationStatus {
    pub outcomes: HashMap<String, MigrationOutcome>,
}

/// Aggregate summary report of a migration run.
pub struct MigrationReport {
    pub migrated: usize,
    pub skipped: usize,
    pub outcomes: HashMap<String, MigrationOutcome>,
}

#[derive(Default)]
struct CredentialState {
    migration: Option<MigrationStatus>,
    source_scan_failed: bool,
}

#[cfg(any(target_os = "macos", target_os = "windows", test))]
impl CredentialState {
    fn require_initialized(&self) -> Result<(), SecretError> {
        if self.migration.is_none() {
            Err(SecretError::Unavailable(
                "Credential migration is not ready".into(),
            ))
        } else {
            Ok(())
        }
    }

    fn require_ready(&self, provider_id: &str) -> Result<(), SecretError> {
        self.require_initialized()?;
        let outcome = self
            .migration
            .as_ref()
            .and_then(|status| status.outcomes.get(provider_id));
        match outcome {
            Some(MigrationOutcome::Migrated | MigrationOutcome::Skipped) => Ok(()),
            Some(
                MigrationOutcome::Conflict
                | MigrationOutcome::Incomplete
                | MigrationOutcome::Failed(_),
            ) => Err(SecretError::Unavailable(
                "Credential requires verified re-entry or removal".into(),
            )),
            None if self.source_scan_failed => Err(SecretError::Unavailable(
                "Unable to read legacy credentials".into(),
            )),
            None => Ok(()),
        }
    }

    fn record(&mut self, provider_id: &str, outcome: MigrationOutcome) {
        if let Some(status) = &mut self.migration {
            status.outcomes.insert(provider_id.to_string(), outcome);
        }
    }

    fn failed(&mut self, provider_id: &str, message: &str) -> SecretError {
        self.record(provider_id, MigrationOutcome::Failed(message.to_string()));
        SecretError::Store(message.to_string())
    }
}

static CREDENTIAL_STATE: Mutex<CredentialState> = Mutex::new(CredentialState {
    migration: None,
    source_scan_failed: false,
});

/// Return an owned snapshot of retained migration outcomes.
pub fn get_migration_status() -> Option<MigrationStatus> {
    CREDENTIAL_STATE
        .lock()
        .ok()
        .and_then(|state| state.migration.clone())
}

#[cfg(any(target_os = "macos", target_os = "windows", test))]
fn get_native_key(
    state: &mut CredentialState,
    native: &dyn ApiKeyStore,
    provider_id: &str,
) -> Result<Option<String>, SecretError> {
    if state.source_scan_failed
        && state
            .migration
            .as_ref()
            .is_some_and(|status| !status.outcomes.contains_key(provider_id))
    {
        state.record(
            provider_id,
            MigrationOutcome::Failed("Unable to read legacy credentials".into()),
        );
    }
    state.require_ready(provider_id)?;
    native.get(provider_id)
}

#[cfg(any(target_os = "macos", target_os = "windows", test))]
fn set_native_key(
    state: &mut CredentialState,
    source: &dyn ApiKeyStore,
    native: &dyn ApiKeyStore,
    provider_id: &str,
    key: &str,
) -> Result<(), SecretError> {
    state.require_initialized()?;
    if native.set(provider_id, key).is_err() {
        return Err(state.failed(provider_id, "Unable to write native credential"));
    }
    match native.get(provider_id) {
        Ok(Some(readback)) if readback == key => {}
        Ok(_) => {
            state.record(provider_id, MigrationOutcome::Conflict);
            return Err(SecretError::Store(
                "Native credential verification failed".into(),
            ));
        }
        Err(_) => return Err(state.failed(provider_id, "Unable to verify native credential")),
    }
    if source.delete(provider_id).is_err() {
        state.record(provider_id, MigrationOutcome::Incomplete);
        return Err(SecretError::Store(
            "Unable to durably remove legacy credential".into(),
        ));
    }
    state.record(provider_id, MigrationOutcome::Migrated);
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows", test))]
fn delete_native_key(
    state: &mut CredentialState,
    source: &dyn ApiKeyStore,
    native: &dyn ApiKeyStore,
    provider_id: &str,
) -> Result<(), SecretError> {
    state.require_initialized()?;
    if native.delete(provider_id).is_err() {
        return Err(state.failed(provider_id, "Unable to delete native credential"));
    }
    match native.get(provider_id) {
        Ok(None) => {}
        Ok(Some(_)) => {
            state.record(provider_id, MigrationOutcome::Conflict);
            return Err(SecretError::Store(
                "Native credential removal verification failed".into(),
            ));
        }
        Err(_) => {
            return Err(state.failed(provider_id, "Unable to verify native credential removal"))
        }
    }
    if source.delete(provider_id).is_err() {
        state.record(provider_id, MigrationOutcome::Incomplete);
        return Err(SecretError::Store(
            "Unable to durably remove legacy credential".into(),
        ));
    }
    state.record(provider_id, MigrationOutcome::Skipped);
    Ok(())
}

/// Move source keys only after exact native verification and durable source removal.
pub fn migrate_secret_map(
    source: &dyn ApiKeyStore,
    dest: &dyn ApiKeyStore,
    providers: &[String],
) -> MigrationReport {
    let mut migrated = 0;
    let mut skipped = 0;
    let mut outcomes = HashMap::new();

    for provider_id in providers {
        let source_key = match source.get(provider_id) {
            Ok(Some(key)) if !key.trim().is_empty() => key,
            Ok(_) => continue,
            Err(_) => {
                outcomes.insert(
                    provider_id.clone(),
                    MigrationOutcome::Failed("Unable to read legacy credential".into()),
                );
                continue;
            }
        };
        match dest.get(provider_id) {
            Ok(Some(existing)) if !existing.trim().is_empty() => {
                if existing != source_key {
                    outcomes.insert(provider_id.clone(), MigrationOutcome::Conflict);
                } else if source.delete(provider_id).is_err() {
                    outcomes.insert(provider_id.clone(), MigrationOutcome::Incomplete);
                } else {
                    skipped += 1;
                    outcomes.insert(provider_id.clone(), MigrationOutcome::Skipped);
                }
                continue;
            }
            Ok(_) => {}
            Err(_) => {
                outcomes.insert(
                    provider_id.clone(),
                    MigrationOutcome::Failed("Unable to read native credential".into()),
                );
                continue;
            }
        }
        if dest.set(provider_id, &source_key).is_err() {
            outcomes.insert(
                provider_id.clone(),
                MigrationOutcome::Failed("Unable to write native credential".into()),
            );
            continue;
        }
        match dest.get(provider_id) {
            Ok(Some(readback)) if readback == source_key => {
                if source.delete(provider_id).is_err() {
                    outcomes.insert(provider_id.clone(), MigrationOutcome::Incomplete);
                } else {
                    migrated += 1;
                    outcomes.insert(provider_id.clone(), MigrationOutcome::Migrated);
                }
            }
            Ok(_) => {
                outcomes.insert(provider_id.clone(), MigrationOutcome::Conflict);
            }
            Err(_) => {
                outcomes.insert(
                    provider_id.clone(),
                    MigrationOutcome::Failed("Unable to verify native credential".into()),
                );
            }
        }
    }
    MigrationReport {
        migrated,
        skipped,
        outcomes,
    }
}

/// Run the verified startup migration while excluding all native credential operations.
pub fn migrate_keys_to_keyring(app: &AppHandle) {
    let Ok(mut state) = CREDENTIAL_STATE.lock() else {
        warn!("Credential synchronization unavailable; migration did not complete");
        return;
    };
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        match read_settings_secret_map(app) {
            Ok(keys) => {
                let providers: Vec<String> = keys
                    .iter()
                    .filter(|(_, key)| !key.trim().is_empty())
                    .map(|(id, _)| id.clone())
                    .collect();
                let report = migrate_secret_map(
                    &SettingsApiKeyStore::new(app.clone()),
                    &KeyringApiKeyStore,
                    &providers,
                );
                info!(
                    "Credential migration: {} migrated, {} redundant copies removed, {} unresolved",
                    report.migrated,
                    report.skipped,
                    report
                        .outcomes
                        .values()
                        .filter(|outcome| matches!(
                            outcome,
                            MigrationOutcome::Conflict
                                | MigrationOutcome::Incomplete
                                | MigrationOutcome::Failed(_)
                        ))
                        .count()
                );
                state.source_scan_failed = false;
                state.migration = Some(MigrationStatus {
                    outcomes: report.outcomes,
                });
            }
            Err(_) => {
                warn!("Unable to read legacy credentials; credential consumers remain blocked");
                state.source_scan_failed = true;
                state.migration = Some(MigrationStatus {
                    outcomes: crate::settings::get_default_settings()
                        .post_process_providers
                        .into_iter()
                        .map(|provider| {
                            (
                                provider.id,
                                MigrationOutcome::Failed(
                                    "Unable to read legacy credentials".into(),
                                ),
                            )
                        })
                        .collect(),
                });
            }
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = app;
        state.migration = Some(MigrationStatus {
            outcomes: HashMap::new(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(id: &str) -> String {
        id.to_string()
    }

    fn keyrings() -> Vec<String> {
        vec![
            provider("openai"),
            provider("anthropic"),
            provider("ollama"),
        ]
    }

    #[test]
    fn secret_debug_redacts_values() {
        let out = format!("{:?}", Secret(&"hunter2"));
        assert!(!out.contains("hunter2"));
        assert!(out.contains("[REDACTED]"));
        assert!(format!("{:?}", Secret(&"")).contains("<empty>"));
    }

    #[test]
    fn migration_moves_keys_and_clears_source() {
        let mut source_keys = HashMap::new();
        source_keys.insert("openai".to_string(), "sk-1".to_string());
        source_keys.insert("anthropic".to_string(), "sk-2".to_string());
        // Empty keys and providers without keys are not migrated.
        source_keys.insert("ollama".to_string(), String::new());
        let source = MemoryApiKeyStore::new(source_keys.clone());
        let dest = MemoryApiKeyStore::new(HashMap::new());

        let report = migrate_secret_map(&source, &dest, &keyrings());
        assert_eq!(report.migrated, 2);
        assert_eq!(report.skipped, 0);

        assert_eq!(dest.get("openai").unwrap(), Some("sk-1".to_string()));
        assert_eq!(dest.get("anthropic").unwrap(), Some("sk-2".to_string()));
        assert_eq!(dest.get("ollama").unwrap(), None);
        // Moved keys are cleared from the source.
        assert_eq!(source.get("openai").unwrap(), None);
        assert_eq!(source.get("anthropic").unwrap(), None);
    }

    #[test]
    fn migration_preserves_unequal_values_and_reports_conflict() {
        let mut source_keys = HashMap::new();
        source_keys.insert("openai".to_string(), "sk-stale".to_string());
        let source = MemoryApiKeyStore::new(source_keys.clone());

        let mut dest_keys = HashMap::new();
        dest_keys.insert("openai".to_string(), "sk-fresh".to_string());
        let dest = MemoryApiKeyStore::new(dest_keys);

        let report = migrate_secret_map(&source, &dest, &keyrings());
        assert_eq!(report.migrated, 0);
        assert_eq!(report.skipped, 0);
        assert_eq!(report.outcomes["openai"], MigrationOutcome::Conflict);
        assert_eq!(dest.get("openai").unwrap(), Some("sk-fresh".to_string()));
        assert_eq!(source.get("openai").unwrap(), Some("sk-stale".to_string()));
    }

    #[test]
    fn migration_retains_legacy_key_when_native_readback_differs() {
        struct CorruptingStore(MemoryApiKeyStore);
        impl ApiKeyStore for CorruptingStore {
            fn get(&self, id: &str) -> Result<Option<String>, SecretError> {
                self.0.get(id)
            }
            fn set(&self, id: &str, _: &str) -> Result<(), SecretError> {
                self.0.set(id, "different-test-only-value")
            }
            fn delete(&self, id: &str) -> Result<(), SecretError> {
                self.0.delete(id)
            }
        }
        let source = MemoryApiKeyStore::new(HashMap::from([(
            "p0-test".to_string(),
            "legacy-test-only-value".to_string(),
        )]));
        let dest = CorruptingStore(MemoryApiKeyStore::new(HashMap::new()));

        migrate_secret_map(&source, &dest, &[provider("p0-test")]);

        assert_eq!(
            source.get("p0-test").unwrap(),
            Some("legacy-test-only-value".to_string())
        );
    }

    #[test]
    fn migration_does_not_report_completion_when_legacy_cleanup_fails() {
        struct DeleteFailureStore(MemoryApiKeyStore);
        impl ApiKeyStore for DeleteFailureStore {
            fn get(&self, id: &str) -> Result<Option<String>, SecretError> {
                self.0.get(id)
            }
            fn set(&self, id: &str, value: &str) -> Result<(), SecretError> {
                self.0.set(id, value)
            }
            fn delete(&self, _: &str) -> Result<(), SecretError> {
                Err(SecretError::Store("test persistence denied".to_string()))
            }
        }
        let source = DeleteFailureStore(MemoryApiKeyStore::new(HashMap::from([(
            "p0-test".to_string(),
            "legacy-test-only-value".to_string(),
        )])));
        let dest = MemoryApiKeyStore::new(HashMap::new());

        let report = migrate_secret_map(&source, &dest, &[provider("p0-test")]);

        assert_eq!(report.migrated, 0);
        assert_eq!(
            source.get("p0-test").unwrap(),
            Some("legacy-test-only-value".to_string())
        );
    }

    #[test]
    fn migration_removes_redundant_plaintext_after_equal_native_readback() {
        let keys = HashMap::from([("p0-test".to_string(), "same-test-only-value".to_string())]);
        let source = MemoryApiKeyStore::new(keys.clone());
        let dest = MemoryApiKeyStore::new(keys);

        migrate_secret_map(&source, &dest, &[provider("p0-test")]);

        assert_eq!(source.get("p0-test").unwrap(), None);
        assert_eq!(
            dest.get("p0-test").unwrap(),
            Some("same-test-only-value".to_string())
        );
    }

    fn initialized_state(outcome: MigrationOutcome) -> CredentialState {
        CredentialState {
            migration: Some(MigrationStatus {
                outcomes: HashMap::from([("openai".into(), outcome)]),
            }),
            source_scan_failed: false,
        }
    }

    #[test]
    fn readiness_blocks_pending_conflict_incomplete_and_failed_providers() {
        let pending = CredentialState::default();
        assert!(pending.require_ready("openai").is_err());
        for outcome in [
            MigrationOutcome::Conflict,
            MigrationOutcome::Incomplete,
            MigrationOutcome::Failed("test-only failure".into()),
        ] {
            assert!(initialized_state(outcome).require_ready("openai").is_err());
        }
        assert!(initialized_state(MigrationOutcome::Migrated)
            .require_ready("openai")
            .is_ok());
        assert!(initialized_state(MigrationOutcome::Skipped)
            .require_ready("absent")
            .is_ok());
        let mut failed_scan = initialized_state(MigrationOutcome::Migrated);
        failed_scan.source_scan_failed = true;
        assert!(failed_scan.require_ready("openai").is_ok());
        assert!(failed_scan.require_ready("unknown-provider").is_err());
    }

    #[test]
    fn explicit_reentry_verifies_cleanup_and_resolves_retained_conflict() {
        let source = MemoryApiKeyStore::new(HashMap::from([(
            "openai".into(),
            "test-only-legacy".into(),
        )]));
        let native = MemoryApiKeyStore::new(HashMap::from([(
            "openai".into(),
            "test-only-native".into(),
        )]));
        let mut state = initialized_state(MigrationOutcome::Conflict);
        set_native_key(&mut state, &source, &native, "openai", "test-only-native").unwrap();
        assert_eq!(source.get("openai").unwrap(), None);
        assert_eq!(
            native.get("openai").unwrap(),
            Some("test-only-native".into())
        );
        assert_eq!(
            state.migration.unwrap().outcomes["openai"],
            MigrationOutcome::Migrated
        );
    }

    struct FailingStore {
        keys: MemoryApiKeyStore,
        fail_read: bool,
        missing_read: bool,
        fail_set: bool,
        fail_delete: bool,
        ignore_delete: bool,
        corrupt_set: bool,
    }

    impl ApiKeyStore for FailingStore {
        fn get(&self, id: &str) -> Result<Option<String>, SecretError> {
            if self.fail_read {
                Err(SecretError::Store("test-only raw error payload".into()))
            } else if self.missing_read {
                Ok(None)
            } else {
                self.keys.get(id)
            }
        }
        fn set(&self, id: &str, key: &str) -> Result<(), SecretError> {
            if self.fail_set {
                Err(SecretError::Store("test-only raw error payload".into()))
            } else {
                self.keys.set(
                    id,
                    if self.corrupt_set {
                        "test-only-corrupt"
                    } else {
                        key
                    },
                )
            }
        }
        fn delete(&self, id: &str) -> Result<(), SecretError> {
            if self.fail_delete {
                Err(SecretError::Store("test-only raw error payload".into()))
            } else if self.ignore_delete {
                Ok(())
            } else {
                self.keys.delete(id)
            }
        }
    }

    fn failing_store() -> FailingStore {
        FailingStore {
            keys: MemoryApiKeyStore::new(HashMap::from([(
                "openai".into(),
                "test-only-retained".into(),
            )])),
            fail_read: false,
            missing_read: false,
            fail_set: false,
            fail_delete: false,
            ignore_delete: false,
            corrupt_set: false,
        }
    }

    #[test]
    fn source_read_failure_is_failed_even_when_native_already_exists() {
        let mut source = failing_store();
        source.fail_read = true;
        let native = failing_store();
        let report = migrate_secret_map(&source, &native, &["openai".into()]);
        assert_eq!(report.skipped, 0);
        let MigrationOutcome::Failed(message) = &report.outcomes["openai"] else {
            panic!("source failure must not be skipped");
        };
        assert!(!message.contains("raw error payload"));
    }

    #[test]
    fn reentry_failure_never_cleans_source_or_unblocks_provider() {
        for phase in 0..4 {
            let source = failing_store();
            let mut native = failing_store();
            native.fail_set = phase == 0;
            native.fail_read = phase == 1;
            native.corrupt_set = phase == 2;
            native.missing_read = phase == 3;
            let mut state = initialized_state(MigrationOutcome::Conflict);
            assert!(
                set_native_key(&mut state, &source, &native, "openai", "test-only-new").is_err()
            );
            assert_eq!(
                source.get("openai").unwrap(),
                Some("test-only-retained".into())
            );
            assert!(state.require_ready("openai").is_err());
        }
    }

    #[test]
    fn reentry_cleanup_failure_stays_incomplete_until_durable_retry() {
        let mut source = failing_store();
        source.fail_delete = true;
        let native = failing_store();
        let mut state = initialized_state(MigrationOutcome::Conflict);
        assert!(set_native_key(&mut state, &source, &native, "openai", "test-only-new").is_err());
        assert_eq!(
            state.migration.as_ref().unwrap().outcomes["openai"],
            MigrationOutcome::Incomplete
        );
        assert_eq!(
            source.get("openai").unwrap(),
            Some("test-only-retained".into())
        );
        assert!(state.require_ready("openai").is_err());
        source.fail_delete = false;
        set_native_key(&mut state, &source, &native, "openai", "test-only-new").unwrap();
        assert!(state.require_ready("openai").is_ok());
    }

    #[test]
    fn deletion_failure_retains_source_and_verified_retry_resolves_status() {
        let source = failing_store();
        let mut native = failing_store();
        native.fail_delete = true;
        let mut state = initialized_state(MigrationOutcome::Conflict);
        assert!(delete_native_key(&mut state, &source, &native, "openai").is_err());
        assert_eq!(
            source.get("openai").unwrap(),
            Some("test-only-retained".into())
        );
        assert_eq!(
            native.get("openai").unwrap(),
            Some("test-only-retained".into())
        );
        assert!(state.require_ready("openai").is_err());
        native.fail_delete = false;
        delete_native_key(&mut state, &source, &native, "openai").unwrap();
        assert_eq!(source.get("openai").unwrap(), None);
        assert_eq!(native.get("openai").unwrap(), None);
        assert!(state.require_ready("openai").is_ok());
        delete_native_key(&mut state, &source, &native, "openai").unwrap();
    }

    #[test]
    fn native_getter_never_consumes_retained_source_and_absence_is_ordinary_none() {
        let native = MemoryApiKeyStore::new(HashMap::new());
        let mut blocked = initialized_state(MigrationOutcome::Incomplete);
        assert!(get_native_key(&mut blocked, &native, "openai").is_err());
        let mut ready = initialized_state(MigrationOutcome::Migrated);
        assert_eq!(get_native_key(&mut ready, &native, "openai").unwrap(), None);
        let mut inaccessible = failing_store();
        inaccessible.fail_read = true;
        assert!(get_native_key(&mut ready, &inaccessible, "openai").is_err());
        let native = failing_store();
        assert!(get_native_key(&mut blocked, &native, "openai").is_err());
        assert_eq!(
            get_native_key(&mut ready, &native, "openai").unwrap(),
            Some("test-only-retained".into())
        );
    }

    #[test]
    fn delete_requires_absence_readback_and_durable_source_cleanup() {
        for phase in 0..3 {
            let mut source = failing_store();
            source.fail_delete = true;
            let mut native = failing_store();
            native.fail_read = phase == 0;
            native.ignore_delete = phase == 2;
            let mut state = initialized_state(MigrationOutcome::Conflict);
            assert!(delete_native_key(&mut state, &source, &native, "openai").is_err());
            assert!(state.require_ready("openai").is_err());
            assert_eq!(
                source.get("openai").unwrap(),
                Some("test-only-retained".into())
            );
            if phase == 1 {
                assert_eq!(
                    state.migration.as_ref().unwrap().outcomes["openai"],
                    MigrationOutcome::Incomplete
                );
                assert_eq!(native.get("openai").unwrap(), None);
                source.fail_delete = false;
                delete_native_key(&mut state, &source, &native, "openai").unwrap();
                assert_eq!(source.get("openai").unwrap(), None);
                assert!(state.require_ready("openai").is_ok());
            }
        }
    }

    #[test]
    fn migration_retains_source_when_native_write_has_missing_readback() {
        let source = failing_store();
        let mut native = failing_store();
        native.missing_read = true;
        let report = migrate_secret_map(&source, &native, &["openai".into()]);
        assert_eq!(report.migrated, 0);
        assert_eq!(report.outcomes["openai"], MigrationOutcome::Conflict);
        assert_eq!(
            source.get("openai").unwrap(),
            Some("test-only-retained".into())
        );
    }
}
