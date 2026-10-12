//! Tauri commands for automatic bilingual keyboard input and local text models.

use crate::managers::auto_input::catalog::AutoInputModelInfo;
use crate::managers::auto_input::resolver::{AutoInputDecision, AutoInputSpan};
use crate::managers::auto_input::{AutoInputManager, AutoInputState};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

#[tauri::command]
#[specta::specta]
pub async fn get_auto_input_models(app: AppHandle) -> Result<Vec<AutoInputModelInfo>, String> {
    let manager = app
        .try_state::<Arc<AutoInputManager>>()
        .ok_or_else(|| "AutoInputManager not initialized".to_string())?;

    Ok(manager.get_models().await)
}

#[tauri::command]
#[specta::specta]
pub async fn get_auto_input_state(app: AppHandle) -> Result<AutoInputState, String> {
    let manager = app
        .try_state::<Arc<AutoInputManager>>()
        .ok_or_else(|| "AutoInputManager not initialized".to_string())?;

    Ok(manager.get_state().await)
}

#[tauri::command]
#[specta::specta]
pub async fn download_auto_input_model(app: AppHandle, model_id: String) -> Result<(), String> {
    let manager = app
        .try_state::<Arc<AutoInputManager>>()
        .ok_or_else(|| "AutoInputManager not initialized".to_string())?;

    manager
        .download_model(model_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn cancel_auto_input_model_download(
    app: AppHandle,
    model_id: String,
) -> Result<(), String> {
    let manager = app
        .try_state::<Arc<AutoInputManager>>()
        .ok_or_else(|| "AutoInputManager not initialized".to_string())?;

    manager
        .cancel_model_download(&model_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_auto_input_model(app: AppHandle, model_id: String) -> Result<(), String> {
    let manager = app
        .try_state::<Arc<AutoInputManager>>()
        .ok_or_else(|| "AutoInputManager not initialized".to_string())?;

    manager
        .delete_model(&model_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn set_auto_input_model(app: AppHandle, model_id: Option<String>) -> Result<(), String> {
    let manager = app
        .try_state::<Arc<AutoInputManager>>()
        .ok_or_else(|| "AutoInputManager not initialized".to_string())?;

    manager.set_model(model_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn set_auto_input_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app
        .try_state::<Arc<AutoInputManager>>()
        .ok_or_else(|| "AutoInputManager not initialized".to_string())?;

    manager
        .set_enabled(enabled)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn resolve_auto_input(
    app: AppHandle,
    context: String,
    spans: Vec<AutoInputSpan>,
) -> Result<Vec<AutoInputDecision>, String> {
    let manager = app
        .try_state::<Arc<AutoInputManager>>()
        .ok_or_else(|| "AutoInputManager not initialized".to_string())?;

    manager
        .resolve(&context, &spans)
        .await
        .map_err(|e| e.to_string())
}
