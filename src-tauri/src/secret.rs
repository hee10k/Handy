//! API-key storage abstraction.
//!
//! The product intent (ADR 4 / SPEC S1) is to keep provider API keys in the OS
//! keyring (macOS Keychain / Windows Credential Manager) via the `keyring`
//! crate. Today the default backend keeps keys in the existing settings
//! `post_process_api_keys` `SecretMap` — which matches shipped behavior and
//! works in an unentitled macOS dev build with no extra native dependency.
//!
//! The `keyring` backend is wired in behind the `keyring-store` cargo feature
//! (off by default) so enabling it never touches the default build. When it is
//! enabled, a one-way migration moves any non-empty keys still sitting in the
//! settings SecretMap into the keyring and clears the plaintext copies.
//!
//! ## Packaging follow-up (macOS entitlements)
//!
//! A signed, packaged macOS build that stores to Keychain needs an app
//! entitlement allowing keychain access. Add `keychain-access-groups` to the
//! app entitlements file and re-sign. Until then the default
//! `SettingsApiKeyStore` keeps dev builds functional.

use crate::settings::{get_settings, write_settings};
use crate::settings::SecretMap;
use log::warn;
#[cfg(feature = "keyring-store")]
use log::info;
use std::collections::HashMap;
use std::fmt;
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

/// Default backend: settings `post_process_api_keys` SecretMap (shipped
/// behavior, works in unentitled dev builds).
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
        let settings = get_settings(&self.app);
        Ok(settings
            .post_process_api_keys
            .get(provider_id)
            .cloned()
            .filter(|key| !key.trim().is_empty()))
    }

    fn set(&self, provider_id: &str, key: &str) -> Result<(), SecretError> {
        let mut settings = get_settings(&self.app);
        settings
            .post_process_api_keys
            .insert(provider_id.to_string(), key.to_string());
        write_settings(&self.app, settings);
        Ok(())
    }

    fn delete(&self, provider_id: &str) -> Result<(), SecretError> {
        let mut settings = get_settings(&self.app);
        settings
            .post_process_api_keys
            .insert(provider_id.to_string(), String::new());
        write_settings(&self.app, settings);
        Ok(())
    }
}

/// Keyring-backed store intended for packaged builds. Compiled only when the
/// `keyring-store` feature is enabled so the default build carries no native
/// keychain dependency.
#[cfg(feature = "keyring-store")]
pub struct KeyringApiKeyStore;

#[cfg(feature = "keyring-store")]
impl ApiKeyStore for KeyringApiKeyStore {
    fn get(&self, provider_id: &str) -> Result<Option<String>, SecretError> {
        let entry = keyring::Entry::new("com.hee10k.tajagi.api-keys", provider_id)
            .map_err(|e| SecretError::Store(e.to_string()))?;
        match entry.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(SecretError::Store(e.to_string())),
        }
    }

    fn set(&self, provider_id: &str, key: &str) -> Result<(), SecretError> {
        let entry = keyring::Entry::new("com.hee10k.tajagi.api-keys", provider_id)
            .map_err(|e| SecretError::Store(e.to_string()))?;
        entry
            .set_password(key)
            .map_err(|e| SecretError::Store(e.to_string()))?;
        Ok(())
    }

    fn delete(&self, provider_id: &str) -> Result<(), SecretError> {
        let entry = keyring::Entry::new("com.hee10k.tajagi.api-keys", provider_id)
            .map_err(|e| SecretError::Store(e.to_string()))?;
        // Deleting a missing entry is a no-op success, matching settings delete.
        let _ = entry.delete_credential();
        Ok(())
    }
}

/// In-memory store for tests and the migration unit tests.
pub struct MemoryApiKeyStore {
    keys: std::sync::Mutex<HashMap<String, String>>,
}

impl MemoryApiKeyStore {
    pub fn new(keys: HashMap<String, String>) -> Self {
        Self {
            keys: std::sync::Mutex::new(keys),
        }
    }
}

impl ApiKeyStore for MemoryApiKeyStore {
    fn get(&self, provider_id: &str) -> Result<Option<String>, SecretError> {
        Ok(self
            .keys
            .lock()
            .unwrap()
            .get(provider_id)
            .cloned()
            .filter(|key| !key.trim().is_empty()))
    }

    fn set(&self, provider_id: &str, key: &str) -> Result<(), SecretError> {
        self.keys
            .lock()
            .unwrap()
            .insert(provider_id.to_string(), key.to_string());
        Ok(())
    }

    fn delete(&self, provider_id: &str) -> Result<(), SecretError> {
        self.keys
            .lock()
            .unwrap()
            .insert(provider_id.to_string(), String::new());
        Ok(())
    }
}

/// Resolve the API key for a provider through the compiled-in backend,
/// preferring an already-populated keyring entry when available.
pub fn get_api_key(app: &AppHandle, provider_id: &str) -> Result<Option<String>, SecretError> {
    #[cfg(feature = "keyring-store")]
    {
        let keyring_store = KeyringApiKeyStore;
        if let Some(key) = keyring_store.get(provider_id)? {
            return Ok(Some(key));
        }
    }
    SettingsApiKeyStore::new(app.clone()).get(provider_id)
}

/// Write an API key, preferring the keyring backend when enabled.
pub fn set_api_key(app: &AppHandle, provider_id: &str, key: &str) -> Result<(), SecretError> {
    #[cfg(feature = "keyring-store")]
    {
        KeyringApiKeyStore.set(provider_id, key)?;
        return Ok(());
    }
    SettingsApiKeyStore::new(app.clone()).set(provider_id, key)
}

/// Delete an API key, clearing any plaintext copy in the settings SecretMap so
/// a previously-migrated key cannot linger.
pub fn delete_api_key(app: &AppHandle, provider_id: &str) -> Result<(), SecretError> {
    #[cfg(feature = "keyring-store")]
    {
        KeyringApiKeyStore.delete(provider_id)?;
    }
    SettingsApiKeyStore::new(app.clone()).delete(provider_id)
}

/// Result of a one-way migration from the settings SecretMap into a better
/// store. `migrated` is the number of keys that were actually moved; `skipped`
/// counts providers that already had a keyring entry (so we don't clobber a
/// newer value with the stale settings copy).
pub struct MigrationReport {
    pub migrated: usize,
    pub skipped: usize,
}

/// Move non-empty provider keys from `source` into `dest`, then clear the moved
/// keys from `source`. Keys already present in `dest` are left untouched on both
/// sides (the keyring is authoritative once populated).
pub fn migrate_secret_map(
    source: &dyn ApiKeyStore,
    dest: &dyn ApiKeyStore,
    providers: &[String],
) -> MigrationReport {
    let mut migrated = 0;
    let mut skipped = 0;

    for provider_id in providers {
        // A destination value is authoritative: never clobber a newer key with
        // the stale settings copy.
        match dest.get(provider_id) {
            Ok(Some(existing)) if !existing.trim().is_empty() => {
                skipped += 1;
                continue;
            }
            Ok(_) => {}
            Err(e) => {
                warn!(
                    "Secret backend unavailable for provider '{}': {}",
                    provider_id, e
                );
                continue;
            }
        }
        match source.get(provider_id) {
            Ok(Some(key)) if !key.trim().is_empty() => match dest.set(provider_id, &key) {
                Ok(()) => {
                    let _ = source.delete(provider_id);
                    migrated += 1;
                }
                Err(e) => warn!("Failed to migrate key for '{}': {}", provider_id, e),
            },
            _ => {}
        }
    }

    MigrationReport { migrated, skipped }
}

/// The settings-side source store for migration: reads from the SecretMap.
pub fn settings_secret_map(app: &AppHandle) -> SecretMap {
    get_settings(app).post_process_api_keys
}

/// Convenience list of provider ids currently carrying a non-empty key in the
/// SecretMap, used by the migration scheduler.
pub fn provider_ids_with_keys(app: &AppHandle) -> Vec<String> {
    get_settings(app)
        .post_process_api_keys
        .iter()
        .filter(|(_, v)| !v.trim().is_empty())
        .map(|(id, _)| id.clone())
        .collect()
}

/// One-way settings→keyring migration scheduled at startup. Non-blocking and
/// a no-op on default builds (feature off → settings backend only), so it is
/// safe to call unconditionally from startup. When `keyring-store` is enabled
/// it moves any non-empty provider keys present in the settings SecretMap into
/// the OS keyring and clears the plaintext copies; keys already in the keyring
/// are left untouched (keyring is authoritative once populated).
#[cfg_attr(not(feature = "keyring-store"), allow(unused_variables))]
pub fn migrate_keys_to_keyring(app: &AppHandle) {
    #[cfg(feature = "keyring-store")]
    {
        let provider_ids = provider_ids_with_keys(app);
        if provider_ids.is_empty() {
            return;
        }
        let app_for_task = app.clone();
        tauri::async_runtime::spawn(async move {
            let source = SettingsApiKeyStore::new(app_for_task.clone());
            let report = migrate_secret_map(&source, &KeyringApiKeyStore, &provider_ids);
            info!(
                "Migrated {} provider API key(s) to the OS keyring ({} skipped)",
                report.migrated, report.skipped
            );
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
    fn settings_store_get_set_delete() {
        let store = MemoryApiKeyStore::new(HashMap::new());
        assert_eq!(store.get("openai").unwrap(), None);
        store.set("openai", "sk-secret").unwrap();
        assert_eq!(store.get("openai").unwrap(), Some("sk-secret".to_string()));
        store.delete("openai").unwrap();
        assert_eq!(store.get("openai").unwrap(), None);
    }

    #[test]
    fn secret_debug_redacts_values() {
        format!("{:?}", Secret(&"hunter2"));
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
    fn migration_skips_providers_already_in_dest() {
        let mut source_keys = HashMap::new();
        source_keys.insert("openai".to_string(), "sk-stale".to_string());
        let source = MemoryApiKeyStore::new(source_keys.clone());

        let mut dest_keys = HashMap::new();
        dest_keys.insert("openai".to_string(), "sk-fresh".to_string());
        let dest = MemoryApiKeyStore::new(dest_keys);

        let report = migrate_secret_map(&source, &dest, &keyrings());
        assert_eq!(report.migrated, 0);
        assert_eq!(report.skipped, 1);
        // The keyring value is authoritative; the stale settings copy is kept
        // (not migrated, but also not deleted here — deletion is a follow-up).
        assert_eq!(dest.get("openai").unwrap(), Some("sk-fresh".to_string()));
        assert_eq!(source.get("openai").unwrap(), Some("sk-stale".to_string()));
    }

    #[test]
    fn keyring_unavailable_surfaces_error_not_panic() {
        // A store that always fails to read should yield a SecretError that a
        // caller can surface, never a panic or a leaked value.
        struct Broken;
        impl ApiKeyStore for Broken {
            fn get(&self, _: &str) -> Result<Option<String>, SecretError> {
                Err(SecretError::Unavailable("keychain locked".to_string()))
            }
            fn set(&self, _: &str, _: &str) -> Result<(), SecretError> {
                Err(SecretError::Unavailable("keychain locked".to_string()))
            }
            fn delete(&self, _: &str) -> Result<(), SecretError> {
                Err(SecretError::Unavailable("keychain locked".to_string()))
            }
        }
        let store = Broken;
        let err = store.get("openai").unwrap_err();
        assert!(matches!(err, SecretError::Unavailable(_)));
    }
}