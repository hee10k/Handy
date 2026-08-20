//! Commands that surface the transform backend (ticket 03).
//!
//! Provider/model/mode selection reuses the existing `post_process_*` settings
//! schema (ADR 4: transform = the existing post_process stack); API keys go
//! through `crate::secret` (settings SecretMap by default, OS keyring behind
//! the `keyring-store` feature). Streaming results are emitted as
//! `transform-delta` / `transform-done` / `transform-error` events by
//! `transform::run_transform`.

use crate::llm_client::{self, REASONING_LEVELS};
use crate::secret;
use crate::settings::{
    get_settings, write_settings, PostProcessProvider, APPLE_INTELLIGENCE_DEFAULT_MODEL_ID,
    APPLE_INTELLIGENCE_PROVIDER_ID,
};
use crate::transform::{self, TransformMode, TransformModeInfo, TransformState};
use log::error;
use tauri::{AppHandle, State};

/// Resolve a transform mode from its snake_case id string (the same ids
/// `TransformMode::as_str` / `list_transform_modes` expose to the frontend).
fn parse_transform_mode(id: &str) -> Result<TransformMode, String> {
    match id {
        "polish" => Ok(TransformMode::Polish),
        "translate_english" => Ok(TransformMode::TranslateEnglish),
        "prompt_english" => Ok(TransformMode::PromptEnglish),
        "custom" => Ok(TransformMode::Custom),
        other => Err(format!("Unknown transform mode: {}", other)),
    }
}

/// Static metadata for the four transform modes, so the frontend can build the
/// mode selector without hardcoding strings.
#[tauri::command]
#[specta::specta]
pub fn list_transform_modes() -> Vec<TransformModeInfo> {
    transform::list_transform_modes()
}

/// Transform `text` with the given mode, streaming result deltas back through
/// the `transform-delta` event. `instruction` is used by the Custom mode.
#[tauri::command]
#[specta::specta]
pub async fn run_transform(
    app: AppHandle,
    mode: String,
    text: String,
    instruction: Option<String>,
) -> Result<(), String> {
    let mode = parse_transform_mode(&mode)?;
    transform::run_transform(&app, mode, text, instruction)
        .await
        .map_err(|e| e.to_string())
}

/// Cancel an in-flight transform. The streaming loop observes the generation
/// bump on its next delta and stops emitting without sending a partial done.
#[tauri::command]
#[specta::specta]
pub fn cancel_transform(state: State<'_, TransformState>) -> Result<(), String> {
    state.cancel();
    Ok(())
}

/// The currently active transform provider (same selection as post_process).
#[tauri::command]
#[specta::specta]
pub fn get_transform_provider(app: AppHandle) -> Result<Option<PostProcessProvider>, String> {
    let settings = get_settings(&app);
    Ok(settings.active_post_process_provider().cloned())
}

/// Select the active transform provider by id.
#[tauri::command]
#[specta::specta]
pub fn set_transform_provider(app: AppHandle, provider_id: String) -> Result<(), String> {
    let mut settings = get_settings(&app);
    let exists = settings
        .post_process_providers
        .iter()
        .any(|p| p.id == provider_id);
    if !exists {
        return Err(format!("Provider '{}' not found", provider_id));
    }
    settings.post_process_provider_id = provider_id;
    write_settings(&app, settings);
    Ok(())
}

/// The configured model for a given provider.
#[tauri::command]
#[specta::specta]
pub fn get_transform_model(app: AppHandle, provider_id: String) -> Result<String, String> {
    let settings = get_settings(&app);
    Ok(settings
        .post_process_models
        .get(&provider_id)
        .cloned()
        .unwrap_or_default())
}

/// Persist the configured model for a given provider.
#[tauri::command]
#[specta::specta]
pub fn set_transform_model(
    app: AppHandle,
    provider_id: String,
    model: String,
) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.post_process_models.insert(provider_id, model);
    write_settings(&app, settings);
    Ok(())
}

/// The reasoning/thinking level for a provider's transform requests, or
/// `None` when unset (the provider default applies). Values are
/// `none`|`low`|`medium`|`high`|`xhigh`|`max`; `none` disables thinking.
#[tauri::command]
#[specta::specta]
pub fn get_transform_reasoning_effort(
    app: AppHandle,
    provider_id: String,
) -> Result<Option<String>, String> {
    let settings = get_settings(&app);
    // Return the raw stored value (None when unset), not the baseline-adjusted
    // effective value, so the UI can distinguish an explicit "off" from the
    // inherited default.
    Ok(settings.post_process_reasoning_effort.get(&provider_id).cloned())
}

/// Persist the reasoning/thinking level for a provider's transform requests.
/// `None` clears the override (falls back to the provider default), and an
/// unknown value is rejected.
#[tauri::command]
#[specta::specta]
pub fn set_transform_reasoning_effort(
    app: AppHandle,
    provider_id: String,
    effort: Option<String>,
) -> Result<(), String> {
    if let Some(value) = &effort {
        let level = value.trim().to_lowercase();
        if !REASONING_LEVELS.contains(&level.as_str()) {
            return Err(format!(
                "Unknown reasoning effort '{value}'. Expected one of: {}",
                REASONING_LEVELS.join(", ")
            ));
        }
    }
    let mut settings = get_settings(&app);
    match effort {
        Some(value) if !value.trim().is_empty() => {
            settings.post_process_reasoning_effort.insert(provider_id, value);
        }
        _ => {
            settings.post_process_reasoning_effort.remove(&provider_id);
        }
    }
    write_settings(&app, settings);
    Ok(())
}

/// The composer quick-action slots (ticket 09): sorted (slot, mode_id) pairs
/// for every assigned slot; slots 5-10 are simply absent until configured.
#[tauri::command]
#[specta::specta]
pub fn get_quick_action_slots(app: AppHandle) -> Result<Vec<(u8, String)>, String> {
    let settings = get_settings(&app);
    let mut slots: Vec<(u8, String)> = settings
        .quick_action_slots
        .iter()
        .map(|(idx, mode)| (*idx, mode.clone()))
        .collect();
    slots.sort_by_key(|(idx, _)| *idx);
    Ok(slots)
}

/// Assign a transform mode to one of the 10 quick-action slots
/// (Cmd/Ctrl+1..0). `None` clears the slot. Slot index is 1-based, 1..=10.
#[tauri::command]
#[specta::specta]
pub fn set_quick_action_slot(
    app: AppHandle,
    slot: u8,
    mode: Option<String>,
) -> Result<(), String> {
    if !(1..=10).contains(&slot) {
        return Err("Quick-action slot must be between 1 and 10".to_string());
    }
    if let Some(value) = &mode {
        parse_transform_mode(value)?; // reject unknown mode ids
    }
    let mut settings = get_settings(&app);
    match mode {
        Some(value) => {
            settings.quick_action_slots.insert(slot, value);
        }
        None => {
            settings.quick_action_slots.remove(&slot);
        }
    }
    write_settings(&app, settings);
    Ok(())
}

/// Fetch the list of available model ids from the provider, reusing the
/// existing OpenAI-compatible model listing path.
#[tauri::command]
#[specta::specta]
pub async fn fetch_transform_models(
    app: AppHandle,
    provider_id: String,
) -> Result<Vec<String>, String> {
    let settings = get_settings(&app);

    let provider = settings
        .post_process_providers
        .iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| format!("Provider '{}' not found", provider_id))?;

    if provider.id == APPLE_INTELLIGENCE_PROVIDER_ID {
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            return Ok(vec![APPLE_INTELLIGENCE_DEFAULT_MODEL_ID.to_string()]);
        }

        #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
        {
            return Err(
                "Apple Intelligence is only available on Apple silicon Macs running macOS 15 or later."
                    .to_string(),
            );
        }
    }

    let api_key = secret::get_api_key(&app, &provider_id)
        .map_err(|e| e.to_string())?
        .unwrap_or_default();

    // Skip fetching if no API key for providers that typically need one.
    if api_key.trim().is_empty() && provider.id != "custom" {
        return Err(format!(
            "API key is required for {}. Please add an API key to list available models.",
            provider.label
        ));
    }

    llm_client::fetch_models(provider, api_key)
        .await
        .map_err(|e| {
            error!("Failed to fetch models for provider '{}': {}", provider.id, e);
            e
        })
}

/// Read the stored API key for a provider through the secret store.
#[tauri::command]
#[specta::specta]
pub fn get_transform_api_key(app: AppHandle, provider_id: String) -> Result<Option<String>, String> {
    secret::get_api_key(&app, &provider_id).map_err(|e| e.to_string())
}

/// Store an API key for a provider through the secret store.
#[tauri::command]
#[specta::specta]
pub fn set_transform_api_key(
    app: AppHandle,
    provider_id: String,
    key: String,
) -> Result<(), String> {
    secret::set_api_key(&app, &provider_id, &key).map_err(|e| e.to_string())
}

/// Delete the stored API key for a provider (clearing any plaintext settings
/// copy so a previously-migrated key cannot linger).
#[tauri::command]
#[specta::specta]
pub fn delete_transform_api_key(app: AppHandle, provider_id: String) -> Result<(), String> {
    secret::delete_api_key(&app, &provider_id).map_err(|e| e.to_string())
}