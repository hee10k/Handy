//! Bundled offline text model catalog for automatic bilingual input.

use serde::{Deserialize, Serialize};
use specta::Type;

const BUNDLED_MODELS_JSON: &str = include_str!("../../../resources/auto-input/models.json");

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CatalogRoot {
    pub models: Vec<CatalogModel>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CatalogModel {
    pub id: String,
    pub name: String,
    pub description: String,
    pub languages: Vec<String>,
    pub quantization: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub repo: String,
    pub revision: String,
    pub filename: String,
    pub urls: Vec<String>,
}

/// DTO for frontend contract (matches tajagi-auto-input-plan.md).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Type)]
pub struct AutoInputModelInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub size_bytes: u64,
    pub downloaded: bool,
    pub downloading: bool,
    pub downloaded_bytes: u64,
    pub loaded: bool,
    pub error: Option<String>,
}

impl CatalogModel {
    pub fn to_model_info(
        &self,
        downloaded: bool,
        downloading: bool,
        downloaded_bytes: u64,
        loaded: bool,
        error: Option<String>,
    ) -> AutoInputModelInfo {
        AutoInputModelInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            description: self.description.clone(),
            size_bytes: self.size_bytes,
            downloaded,
            downloading,
            downloaded_bytes,
            loaded,
            error,
        }
    }
}

/// Parse the bundled text catalog models.
pub fn load_catalog() -> Result<Vec<CatalogModel>, String> {
    let root: CatalogRoot = serde_json::from_str(BUNDLED_MODELS_JSON)
        .map_err(|e| format!("Failed to parse bundled auto-input models.json: {}", e))?;
    Ok(root.models)
}
