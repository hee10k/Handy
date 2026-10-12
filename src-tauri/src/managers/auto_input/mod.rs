//! Local text-model lifecycle, verified installation, and candidate-only inference.

pub mod catalog;
pub mod download;
pub mod lexicon;
pub mod resolver;
pub mod runtime;

use anyhow::{anyhow, Result};
use catalog::{load_catalog, AutoInputModelInfo, CatalogModel};
use download::{download_file_verified, DownloadCancellationToken, DownloadError};
use parking_lot::Mutex;
use resolver::{resolve_spans_via_runtime, AutoInputDecision, AutoInputSpan, AutoLanguage};
use runtime::{
    extract_runtime_archive, get_current_platform_asset, locate_llama_server, wait_for_readiness,
    RuntimeProcesses,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Type)]
pub struct AutoInputState {
    pub enabled: bool,
    pub selected_model: Option<String>,
    pub loading: bool,
    pub loaded_model: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, tauri_specta::Event)]
pub struct AutoInputModelProgressPayload {
    pub model_id: String,
    pub phase: String,
    pub downloaded: u64,
    pub total: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, tauri_specta::Event)]
pub struct AutoInputModelStatePayload {
    pub enabled: bool,
    pub selected_model: Option<String>,
    pub loading: bool,
    pub loaded_model: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, tauri_specta::Event)]
pub struct AutoInputModelsChangedPayload {}

#[derive(Default)]
struct ModeIntent(u64);

impl ModeIntent {
    fn begin(&mut self) -> u64 {
        self.0 += 1;
        self.0
    }

    fn apply(&self, epoch: u64, enabled: bool, state: &mut AutoInputState) -> bool {
        if self.0 != epoch {
            return false;
        }
        state.enabled = enabled;
        if enabled {
            state.error = None;
        }
        true
    }
}

struct ActiveDownload {
    id: uuid::Uuid,
    cancel: DownloadCancellationToken,
    done: tokio::sync::watch::Sender<bool>,
}

#[derive(Default)]
struct DownloadReservations(HashMap<String, ActiveDownload>);

impl DownloadReservations {
    fn reserve(
        &mut self,
        model: &str,
    ) -> Result<(
        uuid::Uuid,
        tokio::sync::watch::Receiver<bool>,
        DownloadCancellationToken,
    )> {
        if self.0.contains_key(model) {
            return Err(anyhow!(
                "An operation is already in progress for model '{}'",
                model
            ));
        }
        let id = uuid::Uuid::new_v4();
        let (done, receiver) = tokio::sync::watch::channel(false);
        let cancel = DownloadCancellationToken::new();
        self.0.insert(
            model.to_owned(),
            ActiveDownload {
                id,
                cancel: cancel.clone(),
                done,
            },
        );
        Ok((id, receiver, cancel))
    }

    fn owns(&self, model: &str, id: uuid::Uuid) -> bool {
        self.0.get(model).is_some_and(|entry| entry.id == id)
    }

    // Called only after terminal publication, cleanup, and autoload have finished.
    fn finish(&mut self, model: &str, id: uuid::Uuid) -> bool {
        if !self.owns(model, id) {
            return false;
        }
        if let Some(entry) = self.0.remove(model) {
            entry.done.send_replace(true);
        }
        true
    }
}

pub struct AutoInputManager {
    app: AppHandle,
    http_client: reqwest::Client,
    inference_client: reqwest::Client,
    models_dir: PathBuf,
    runtime_dir: PathBuf,
    catalog_models: Vec<CatalogModel>,
    // Lock ordering: process -> state -> models. No synchronous guard crosses await.
    process: Mutex<RuntimeProcesses>,
    mode_intent: Mutex<ModeIntent>,
    state: Mutex<AutoInputState>,
    models: Mutex<HashMap<String, AutoInputModelInfo>>,
    active_downloads: Mutex<DownloadReservations>,
    runtime_install: tokio::sync::Mutex<()>,
}

impl Drop for AutoInputManager {
    fn drop(&mut self) {
        self.unload_sync();
    }
}

// Defensive net for unexpected task aborts. Explicit error paths already
// finalize state under the owner lock, so this only reaps an owned child.
struct ModelLoadGuard<'a> {
    owner: &'a Mutex<RuntimeProcesses>,
    epoch: u64,
    finished: bool,
}

impl<'a> ModelLoadGuard<'a> {
    fn new(owner: &'a Mutex<RuntimeProcesses>, epoch: u64) -> Self {
        Self {
            owner,
            epoch,
            finished: false,
        }
    }
}

impl Drop for ModelLoadGuard<'_> {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        let mut owner = self.owner.lock();
        if owner.owns(self.epoch) {
            owner.kill_owned(self.epoch);
        }
    }
}

// The worker is detached from the invoking future so dropping a command cannot
// abandon its cancellation barrier. Drop also finalizes unexpected task exits.
struct DownloadOperation {
    manager: Arc<AutoInputManager>,
    model: String,
    id: uuid::Uuid,
    finished: bool,
}

impl DownloadOperation {
    fn finish(&mut self) {
        self.manager
            .active_downloads
            .lock()
            .finish(&self.model, self.id);
        self.finished = true;
    }
}

impl Drop for DownloadOperation {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        let mut downloads = self.manager.active_downloads.lock();
        if downloads.owns(&self.model, self.id) {
            if let Some(info) = self.manager.models.lock().get_mut(&self.model) {
                info.downloading = false;
                info.error = Some("Model operation was interrupted".into());
            }
            self.manager.emit_models_changed();
            downloads.finish(&self.model, self.id);
        }
    }
}

impl AutoInputManager {
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let root = crate::portable::app_data_dir(app_handle)?.join("auto-input");
        let models_dir = root.join("models");
        let runtime_dir = root.join("runtime");
        fs::create_dir_all(&models_dir)?;
        let catalog_models =
            load_catalog().map_err(|e| anyhow!("Invalid text-model catalog: {}", e))?;
        let settings = crate::settings::get_settings(app_handle);
        let models = catalog_models
            .iter()
            .map(|model| {
                let bytes = fs::metadata(models_dir.join(&model.filename))
                    .ok()
                    .filter(|m| m.is_file())
                    .map_or(0, |m| m.len());
                (
                    model.id.clone(),
                    model.to_model_info(bytes == model.size_bytes, false, bytes, false, None),
                )
            })
            .collect();
        Ok(Self {
            app: app_handle.clone(),
            http_client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(300))
                .build()?,
            inference_client: reqwest::Client::builder()
                .no_proxy()
                .timeout(std::time::Duration::from_secs(30))
                .build()?,
            models_dir,
            runtime_dir,
            catalog_models,
            process: Mutex::new(RuntimeProcesses::default()),
            mode_intent: Mutex::new(ModeIntent::default()),
            state: Mutex::new(AutoInputState {
                enabled: settings.auto_input_enabled,
                selected_model: settings.auto_input_model,
                loading: false,
                loaded_model: None,
                error: None,
            }),
            models: Mutex::new(models),
            active_downloads: Mutex::new(DownloadReservations::default()),
            runtime_install: tokio::sync::Mutex::new(()),
        })
    }

    /// No startup downloads; only restore a previously installed selection.
    /// Runs on the app's async runtime: this is invoked from Tauri setup, which
    /// is not itself a Tokio reactor context.
    pub fn init_on_startup(self: &Arc<Self>) {
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let state = this.state.lock().clone();
            if state.enabled {
                if let Some(model) = state.selected_model {
                    let _ = this.load_model_internal(&model).await;
                }
            }
        });
    }

    pub async fn get_models(&self) -> Vec<AutoInputModelInfo> {
        let mut models = self.models.lock();
        self.catalog_models
            .iter()
            .filter_map(|model| {
                let info = models.get_mut(&model.id)?;
                if !info.downloading {
                    let bytes = fs::metadata(self.models_dir.join(&model.filename))
                        .ok()
                        .filter(|m| m.is_file())
                        .map_or(0, |m| m.len());
                    info.downloaded = bytes == model.size_bytes;
                    info.downloaded_bytes = bytes;
                }
                Some(info.clone())
            })
            .collect()
    }

    pub async fn get_state(&self) -> AutoInputState {
        self.state.lock().clone()
    }

    pub async fn set_enabled(&self, enabled: bool) -> Result<()> {
        let intent_epoch = self.mode_intent.lock().begin();
        if enabled {
            let selected = self
                .state
                .lock()
                .selected_model
                .clone()
                .ok_or_else(|| anyhow!("No auto-input model selected"))?;
            self.load_model_internal(&selected).await?;
        }
        // Serialize checking ownership and persistence, not merely an atomic
        // check followed by await. A later disable always owns the last write.
        let intent = self.mode_intent.lock();
        let owner = self.process.lock();
        if enabled && !owner.process.as_ref().is_some_and(|process| process.ready) {
            return Err(anyhow!("The selected auto-input model is no longer ready"));
        }
        let mut state = self.state.lock();
        if !intent.apply(intent_epoch, enabled, &mut state) {
            return Ok(());
        }
        let mut settings = crate::settings::get_settings(&self.app);
        settings.auto_input_enabled = enabled;
        crate::settings::write_settings(&self.app, settings);
        drop(state);
        self.emit_state();
        Ok(())
    }

    fn validate_model(&self, id: &str) -> Result<(PathBuf, PathBuf)> {
        let model = self
            .catalog_models
            .iter()
            .find(|m| m.id == id)
            .ok_or_else(|| anyhow!("Model '{}' not found in catalog", id))?;
        let path = self.models_dir.join(&model.filename);
        let metadata =
            fs::metadata(&path).map_err(|_| anyhow!("Model '{}' is not installed", id))?;
        if !metadata.is_file() || metadata.len() != model.size_bytes {
            return Err(anyhow!("Model '{}' is incomplete or corrupted", id));
        }
        let server = locate_llama_server(&self.runtime_dir)
            .ok_or_else(|| anyhow!("llama.cpp runtime is not installed"))?;
        Ok((server, path))
    }

    pub async fn set_model(&self, model_id: Option<String>) -> Result<()> {
        let files = model_id
            .as_deref()
            .map(|id| self.validate_model(id))
            .transpose()?;
        let epoch = {
            let mut owner = self.process.lock();
            let epoch = owner.begin()?;
            {
                let mut state = self.state.lock();
                state.selected_model = model_id.clone();
                state.error = None;
            }
            let mut settings = crate::settings::get_settings(&self.app);
            settings.auto_input_model = model_id.clone();
            crate::settings::write_settings(&self.app, settings);
            if let (Some(id), Some((server, model))) = (model_id.as_deref(), files.as_ref()) {
                self.start_load(&mut owner, epoch, id, server, model)?;
            } else {
                self.publish_load_result(None, None);
            }
            epoch
        };
        if model_id.is_some() {
            self.finish_load(epoch).await?;
        }
        Ok(())
    }

    fn start_load(
        &self,
        owner: &mut RuntimeProcesses,
        epoch: u64,
        id: &str,
        server: &std::path::Path,
        model: &std::path::Path,
    ) -> Result<()> {
        if let Err(error) = owner.spawn(epoch, server, model, id) {
            self.publish_load_result(None, Some(error.to_string()));
            return Err(error);
        }
        {
            let mut state = self.state.lock();
            state.loading = true;
            state.loaded_model = None;
            state.error = None;
        }
        for info in self.models.lock().values_mut() {
            info.loaded = false;
        }
        self.emit_state();
        self.emit_models_changed();
        Ok(())
    }

    async fn load_model_internal(&self, id: &str) -> Result<()> {
        let (server, model) = self.validate_model(id)?;
        let epoch = {
            let mut owner = self.process.lock();
            if self.state.lock().selected_model.as_deref() != Some(id) {
                return Err(anyhow!("Model selection changed"));
            }
            if owner
                .process
                .as_ref()
                .is_some_and(|p| p.ready && p.model_id == id)
            {
                return Ok(());
            }
            let epoch = owner.begin()?;
            self.start_load(&mut owner, epoch, id, &server, &model)?;
            epoch
        };
        self.finish_load(epoch).await
    }

    async fn finish_load(&self, epoch: u64) -> Result<()> {
        let mut guard = ModelLoadGuard::new(&self.process, epoch);
        let result = wait_for_readiness(&self.process, epoch).await;
        {
            let mut owner = self.process.lock();
            if !owner.owns(epoch) {
                return Err(anyhow!("Model load superseded"));
            }
            match &result {
                Ok(()) => {
                    let id = owner
                        .process
                        .as_mut()
                        .ok_or_else(|| anyhow!("Model process disappeared during startup"))?
                        .model_id
                        .clone();
                    owner.process.as_mut().expect("checked above").ready = true;
                    self.publish_load_result(Some(&id), None);
                }
                Err(error) => {
                    owner.kill_owned(epoch);
                    self.publish_load_result(None, Some(error.to_string()));
                }
            }
            guard.finished = true;
        }
        result
    }

    // Caller holds process ownership throughout this synchronous publication.
    fn publish_load_result(&self, loaded: Option<&str>, error: Option<String>) {
        {
            let mut state = self.state.lock();
            state.loading = false;
            state.loaded_model = loaded.map(str::to_owned);
            state.error = error;
        }
        for (id, info) in self.models.lock().iter_mut() {
            info.loaded = loaded == Some(id.as_str());
        }
        self.emit_state();
        self.emit_models_changed();
    }

    /// Used by RunEvent::Exit: no await, try_lock, or dependency on future Drop.
    /// The shutdown latch prevents any task from registering a later child.
    pub fn unload_sync(&self) {
        let mut owner = self.process.lock();
        owner.shutdown();
    }

    /// Bundled `wordfreq` dictionaries (Korean then English), shared with the
    /// composer predictor. Already warmed at startup, so this is normally a
    /// no-op lookup that hands back the existing index.
    fn lexicon_predictor(&self) -> Result<Arc<crate::text_predict::TextPredictor>> {
        let resolve = |rel: &str| {
            self.app
                .path()
                .resolve(rel, tauri::path::BaseDirectory::Resource)
                .map_err(|e| anyhow!("Cannot resolve bundled dictionary {rel}: {e}"))
        };
        let ko = resolve("models/small_ko.txt.zst")?;
        let en = resolve("models/large_en.txt.zst")?;
        let state = self.app.state::<crate::text_predict::PredictorState>();
        crate::text_predict::load_predictor(&ko, &en, &state).map_err(|e| anyhow!("{e}"))
    }

    /// Resolves every span: the bundled lexicon decides the words it knows, and
    /// a loaded local model decides the rest. A model is therefore only required
    /// when a span is genuinely ambiguous — auto input works with zero downloads.
    pub async fn resolve(
        &self,
        context: &str,
        spans: &[AutoInputSpan],
    ) -> Result<Vec<AutoInputDecision>> {
        // Reject duplicates up front so the merge below can only ever fill holes.
        let mut seen_ids = std::collections::HashSet::new();
        for span in spans {
            if !seen_ids.insert(span.id) {
                return Err(anyhow!("Duplicate span ID detected: {}", span.id));
            }
        }

        let predictor = self.lexicon_predictor()?;
        let mut lexical: HashMap<u32, AutoLanguage> = HashMap::new();
        let mut pending: Vec<AutoInputSpan> = Vec::new();
        for span in spans {
            match lexicon::lexicon_choice(&predictor, span) {
                Some(language) => {
                    lexical.insert(span.id, language);
                }
                None => pending.push(span.clone()),
            }
        }

        if !pending.is_empty() {
            let (port, token, epoch) = {
                let owner = self.process.lock();
                let process = owner.process.as_ref().filter(|p| p.ready).ok_or_else(|| anyhow!(
                    "{} word(s) cannot be decided by the dictionary alone. Install and load a local text model to resolve ambiguous words.",
                    pending.len(),
                ))?;
                (process.port, process.token.clone(), owner.current_epoch())
            };
            let decisions =
                resolve_spans_via_runtime(&self.inference_client, port, &token, context, &pending)
                    .await?;
            if !self.process.lock().owns(epoch) {
                return Err(anyhow!("Model changed during inference"));
            }
            for decision in decisions {
                if lexical.insert(decision.id, decision.language).is_some() {
                    return Err(anyhow!("Duplicate decision for span {}", decision.id));
                }
            }
        }

        spans
            .iter()
            .map(|span| {
                lexical
                    .get(&span.id)
                    .map(|language| AutoInputDecision {
                        id: span.id,
                        language: *language,
                    })
                    .ok_or_else(|| anyhow!("No language decision for span {}", span.id))
            })
            .collect()
    }

    pub async fn download_model(self: &Arc<Self>, model_id: String) -> Result<()> {
        let model = self
            .catalog_models
            .iter()
            .find(|m| m.id == model_id)
            .cloned()
            .ok_or_else(|| anyhow!("Model '{}' not found in catalog", model_id))?;
        let (id, _, cancel) = self.active_downloads.lock().reserve(&model_id)?;
        {
            let mut models = self.models.lock();
            if let Some(info) = models.get_mut(&model_id) {
                info.downloading = true;
                info.downloaded_bytes = 0;
                info.error = None;
            }
        }
        self.emit_models_changed();
        let operation = DownloadOperation {
            manager: self.clone(),
            model: model_id,
            id,
            finished: false,
        };
        tokio::spawn(async move {
            let mut operation = operation;
            let this = operation.manager.clone();
            let mut result = this.download_model_files(&model, &cancel).await;
            // Terminal publication is still owned by this operation. Cancellation
            // at this point stops autoload but does not misreport verified files.
            {
                let mut models = this.models.lock();
                if let Some(info) = models.get_mut(&model.id) {
                    info.downloading = false;
                    let bytes = fs::metadata(this.models_dir.join(&model.filename))
                        .ok().filter(|m| m.is_file()).map_or(0, |m| m.len());
                    info.downloaded = bytes == model.size_bytes;
                    info.downloaded_bytes = bytes;
                    info.error = match &result {
                        Err(DownloadError::Cancelled) | Ok(()) => None,
                        Err(error) => Some(error.to_string()),
                    };
                }
            }
            this.emit_models_changed();
            if result.is_ok() && !cancel.is_cancelled() {
                let selected = this.state.lock().selected_model.as_deref() == Some(&model.id);
                if selected {
                    let load = tokio::select! {
                        biased;
                        _ = cancel.cancelled() => Err(anyhow!("Download cancelled before autoload finished")),
                        result = this.load_model_internal(&model.id) => result,
                    };
                    if let Err(error) = load { result = Err(DownloadError::Other(error.to_string())); }
                }
            }
            // No side effect is permitted after release or the completion signal.
            operation.finish();
            result.map_err(|error| anyhow!(error))
        }).await.map_err(|error| anyhow!("Model operation failed: {}", error))?
    }

    async fn download_model_files(
        &self,
        model: &CatalogModel,
        cancel: &DownloadCancellationToken,
    ) -> Result<(), DownloadError> {
        let _install = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(DownloadError::Cancelled),
            lock = self.runtime_install.lock() => lock,
        };
        if locate_llama_server(&self.runtime_dir).is_none() {
            self.download_runtime_internal(model, cancel).await?;
        }
        drop(_install);
        let app = self.app.clone();
        let id = model.id.clone();
        download_file_verified(
            &self.http_client,
            &model.urls,
            &self.models_dir.join(&model.filename),
            model.size_bytes,
            &model.sha256,
            cancel.clone(),
            move |downloaded, total| {
                let _ = AutoInputModelProgressPayload {
                    model_id: id.clone(),
                    phase: "model".into(),
                    downloaded,
                    total,
                }
                .emit(&app);
            },
        )
        .await
    }

    async fn download_runtime_internal(
        &self,
        model: &CatalogModel,
        cancel: &DownloadCancellationToken,
    ) -> Result<(), DownloadError> {
        let asset =
            get_current_platform_asset().map_err(|e| DownloadError::Other(e.to_string()))?;
        let archive = self
            .runtime_dir
            .parent()
            .ok_or_else(|| DownloadError::Other("Runtime directory has no parent".into()))?
            .join(format!(
                "runtime-{}.{}",
                uuid::Uuid::new_v4(),
                if asset.is_zip { "zip" } else { "tar.gz" }
            ));
        let app = self.app.clone();
        let id = model.id.clone();
        let result = download_file_verified(
            &self.http_client,
            &[asset.url.to_owned()],
            &archive,
            asset.size_bytes,
            asset.sha256,
            cancel.clone(),
            move |downloaded, total| {
                let _ = AutoInputModelProgressPayload {
                    model_id: id.clone(),
                    phase: "runtime".into(),
                    downloaded,
                    total,
                }
                .emit(&app);
            },
        )
        .await;
        let result = result.and_then(|()| {
            if cancel.is_cancelled() {
                return Err(DownloadError::Cancelled);
            }
            extract_runtime_archive(&archive, &self.runtime_dir, asset.is_zip)
                .map_err(|e| DownloadError::Other(format!("Failed to install runtime: {}", e)))
        });
        let _ = fs::remove_file(&archive);
        result
    }

    pub async fn cancel_model_download(&self, model: &str) -> Result<()> {
        let receiver = self.active_downloads.lock().0.get(model).map(|entry| {
            entry.cancel.cancel();
            entry.done.subscribe()
        });
        if let Some(mut receiver) = receiver {
            let _ = receiver.wait_for(|done| *done).await;
        }
        Ok(())
    }

    pub async fn delete_model(self: &Arc<Self>, model_id: &str) -> Result<()> {
        let model = self
            .catalog_models
            .iter()
            .find(|m| m.id == model_id)
            .ok_or_else(|| anyhow!("Model '{}' not found in catalog", model_id))?;
        // Reserve deletion too: D2 cannot race the cancel/delete barrier and
        // publish a newly downloaded file while deletion is removing it.
        let id = loop {
            let pending = {
                let mut operations = self.active_downloads.lock();
                if let Some(entry) = operations.0.get(model_id) {
                    entry.cancel.cancel();
                    Some(entry.done.subscribe())
                } else {
                    break operations.reserve(model_id)?.0;
                }
            };
            if let Some(mut receiver) = pending {
                let _ = receiver.wait_for(|done| *done).await;
            }
        };
        let mut operation = DownloadOperation {
            manager: self.clone(),
            model: model_id.to_owned(),
            id,
            finished: false,
        };
        let result = (|| -> Result<()> {
            let mut owner = self.process.lock();
            if self.state.lock().selected_model.as_deref() == Some(model_id) {
                owner.begin()?;
                self.state.lock().selected_model = None;
                let mut settings = crate::settings::get_settings(&self.app);
                settings.auto_input_model = None;
                crate::settings::write_settings(&self.app, settings);
                self.publish_load_result(None, None);
            }
            let file = self.models_dir.join(&model.filename);
            for path in [
                file.clone(),
                file.with_file_name(format!("{}.part", model.filename)),
            ] {
                match fs::remove_file(path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
            if let Some(info) = self.models.lock().get_mut(model_id) {
                info.downloaded = false;
                info.downloading = false;
                info.downloaded_bytes = 0;
                info.loaded = false;
                info.error = None;
            }
            self.emit_models_changed();
            Ok(())
        })();
        operation.finish();
        result
    }

    fn emit_state(&self) {
        let state = self.state.lock().clone();
        let _ = AutoInputModelStatePayload {
            enabled: state.enabled,
            selected_model: state.selected_model,
            loading: state.loading,
            loaded_model: state.loaded_model,
            error: state.error,
        }
        .emit(&self.app);
    }

    fn emit_models_changed(&self) {
        let _ = AutoInputModelsChangedPayload {}.emit(&self.app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_disable_intent_rejects_old_enable_publication() {
        let mut intent = ModeIntent::default();
        let enable = intent.begin();
        let disable = intent.begin();
        let mut state = AutoInputState {
            enabled: true,
            selected_model: None,
            loading: false,
            loaded_model: Some("warm-manual-model".into()),
            error: None,
        };
        assert!(intent.apply(disable, false, &mut state));
        assert!(!intent.apply(enable, true, &mut state));
        assert!(!state.enabled);
        assert_eq!(state.loaded_model.as_deref(), Some("warm-manual-model"));
    }

    #[test]
    fn download_reservation_and_completion_belong_to_the_same_operation() {
        let mut reservations = DownloadReservations::default();
        let (first, receiver, _) = reservations.reserve("model").unwrap();
        assert!(reservations.reserve("model").is_err());
        assert!(!*receiver.borrow());
        assert!(reservations.finish("model", first));
        assert!(*receiver.borrow());
        let (second, receiver, _) = reservations.reserve("model").unwrap();
        assert!(!reservations.finish("model", first));
        assert!(!*receiver.borrow());
        assert!(reservations.reserve("model").is_err());
        assert!(reservations.finish("model", second));
        assert!(*receiver.borrow());
    }
}
