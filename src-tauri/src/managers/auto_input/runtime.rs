//! Official pinned llama.cpp runtime management, archive extraction, and process lifecycle.

use anyhow::{anyhow, Result};
use flate2::read::GzDecoder;
use parking_lot::Mutex;
use std::fs::{self, File};
use std::io::copy;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use tar::Archive;

const MIT_LICENSE_NOTICE: &str = r#"MIT License

Copyright (c) 2023-2026 Georgi Gerganov and llama.cpp contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"#;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeAsset {
    pub os: &'static str,
    pub arch: &'static str,
    pub archive_name: &'static str,
    pub url: &'static str,
    pub size_bytes: u64,
    pub sha256: &'static str,
    pub is_zip: bool,
}

// Verified against official llama.cpp release b11429 assets (https://github.com/ggml-org/llama.cpp/releases/tag/b11429).
// Note: Official llama.cpp GitHub releases publish assets and GitHub Attestations rather than a plain SHA256SUMS file;
// all hashes below were computed and verified directly from the official b11429 release artifacts.
// (Parent verified runtime build b11429 running on 127.0.0.1:14941).
pub const RUNTIME_ASSETS: &[RuntimeAsset] = &[
    RuntimeAsset {
        os: "macos",
        arch: "aarch64",
        archive_name: "llama-b11429-bin-macos-arm64.tar.gz",
        url: "https://github.com/ggml-org/llama.cpp/releases/download/b11429/llama-b11429-bin-macos-arm64.tar.gz",
        size_bytes: 11971406,
        sha256: "740288ec6887be94280a5dfa25b5e23a78285cab104519e6c7e218904ee82459",
        is_zip: false,
    },
    RuntimeAsset {
        os: "macos",
        arch: "x86_64",
        archive_name: "llama-b11429-bin-macos-x64.tar.gz",
        url: "https://github.com/ggml-org/llama.cpp/releases/download/b11429/llama-b11429-bin-macos-x64.tar.gz",
        size_bytes: 11487431,
        sha256: "29ac3ea02be6bd143e824973f2cc5fa74bc4094393a9eaab0ff6814f19dd8522",
        is_zip: false,
    },
    RuntimeAsset {
        os: "linux",
        arch: "x86_64",
        archive_name: "llama-b11429-bin-ubuntu-x64.tar.gz",
        url: "https://github.com/ggml-org/llama.cpp/releases/download/b11429/llama-b11429-bin-ubuntu-x64.tar.gz",
        size_bytes: 17693462,
        sha256: "f6d25dde8f51133143d1453da4fd5f73b145127177612a283bf7995957af3392",
        is_zip: false,
    },
    RuntimeAsset {
        os: "linux",
        arch: "aarch64",
        archive_name: "llama-b11429-bin-ubuntu-arm64.tar.gz",
        url: "https://github.com/ggml-org/llama.cpp/releases/download/b11429/llama-b11429-bin-ubuntu-arm64.tar.gz",
        size_bytes: 13682895,
        sha256: "ed44c0f79c3d02424f62bdc87e106318b0b89f49050e2e80c5f352723d14e00b",
        is_zip: false,
    },
    RuntimeAsset {
        os: "windows",
        arch: "x86_64",
        archive_name: "llama-b11429-bin-win-cpu-x64.zip",
        url: "https://github.com/ggml-org/llama.cpp/releases/download/b11429/llama-b11429-bin-win-cpu-x64.zip",
        size_bytes: 19398918,
        sha256: "1283323272b04cd07905816a597a0da810918102de958f4ff6f7bbaa70ed2efe",
        is_zip: true,
    },
    RuntimeAsset {
        os: "windows",
        arch: "aarch64",
        archive_name: "llama-b11429-bin-win-cpu-arm64.zip",
        url: "https://github.com/ggml-org/llama.cpp/releases/download/b11429/llama-b11429-bin-win-cpu-arm64.zip",
        size_bytes: 12229035,
        sha256: "ee0f631a9e58b146ff50714099d9cb498906af3143a773b580093a9214a8d1e5",
        is_zip: true,
    },
];

pub fn get_current_platform_asset() -> Result<&'static RuntimeAsset> {
    let current_os = std::env::consts::OS;
    let current_arch = std::env::consts::ARCH;

    for asset in RUNTIME_ASSETS {
        if asset.os == current_os && asset.arch == current_arch {
            return Ok(asset);
        }
    }

    Err(anyhow!(
        "No official prebuilt llama.cpp runtime available for platform {}/{}. Prebuilt binaries are available for macOS (arm64, x64), Linux (x64, arm64), and Windows (x64, arm64).",
        current_os,
        current_arch
    ))
}

/// Locates the `llama-server` executable in `runtime_dir`.
pub fn locate_llama_server(runtime_dir: &Path) -> Option<PathBuf> {
    let exe_name = if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    };

    // Direct check in runtime_dir root
    let direct = runtime_dir.join(exe_name);
    if direct.is_file() {
        return Some(direct);
    }

    // Check bin/ subfolder
    let in_bin = runtime_dir.join("bin").join(exe_name);
    if in_bin.is_file() {
        return Some(in_bin);
    }

    // Search recursively up to 2 levels deep
    if let Ok(entries) = fs::read_dir(runtime_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let candidate = path.join(exe_name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    None
}

/// Safely extract an archive file (`.tar.gz` or `.zip`) into `dest_dir` using a unique staging directory,
/// verifying that `llama-server --version` succeeds before atomically installing to `dest_dir`.
pub fn extract_runtime_archive(archive_path: &Path, dest_dir: &Path, is_zip: bool) -> Result<()> {
    let parent_dir = dest_dir.parent().unwrap_or(dest_dir);
    fs::create_dir_all(parent_dir)?;

    let staging_dir = parent_dir.join(format!("runtime-staging-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&staging_dir)?;

    let result = (|| -> Result<()> {
        if is_zip {
            extract_zip(archive_path, &staging_dir)?;
        } else {
            extract_tar_gz(archive_path, &staging_dir)?;
        }

        // Write bundled MIT license notice
        let license_path = staging_dir.join("LICENSE");
        fs::write(license_path, MIT_LICENSE_NOTICE)?;

        // On Unix platforms, ensure executable permission on binaries and dynamic libraries
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(entries) = fs::read_dir(&staging_dir) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if let Some(file_name) = p.file_name().and_then(|f| f.to_str()) {
                        if file_name.starts_with("llama-")
                            || file_name.ends_with(".dylib")
                            || file_name.ends_with(".so")
                        {
                            let _ = fs::set_permissions(&p, fs::Permissions::from_mode(0o755));
                        }
                    }
                }
            }
        }

        // On macOS, clear Gatekeeper quarantine attribute
        #[cfg(target_os = "macos")]
        {
            let _ = Command::new("xattr")
                .args(["-rd", "com.apple.quarantine"])
                .arg(&staging_dir)
                .status();
        }

        // Verify the binary works and required libs are present before atomic install
        let server_exe = locate_llama_server(&staging_dir).ok_or_else(|| {
            anyhow!("Failed to locate llama-server executable in staging directory")
        })?;

        let mut verify_cmd = Command::new(&server_exe);
        verify_cmd.arg("--version");
        if let Some(parent) = server_exe.parent() {
            verify_cmd.current_dir(parent);
        }
        let verify_output = verify_cmd
            .output()
            .map_err(|e| anyhow!("Failed to execute llama-server --version in staging: {}", e))?;

        if !verify_output.status.success() {
            let stderr = String::from_utf8_lossy(&verify_output.stderr);
            return Err(anyhow!(
                "llama-server --version verification failed (exit status {}): {}",
                verify_output.status,
                stderr
            ));
        }

        // Atomically replace dest_dir
        if dest_dir.exists() {
            let backup_dir = parent_dir.join(format!("runtime-old-{}", uuid::Uuid::new_v4()));
            fs::rename(dest_dir, &backup_dir)?;
            if let Err(e) = fs::rename(&staging_dir, dest_dir) {
                let _ = fs::rename(&backup_dir, dest_dir);
                return Err(anyhow!(
                    "Failed to atomically install runtime directory: {}",
                    e
                ));
            }
            let _ = fs::remove_dir_all(&backup_dir);
        } else {
            fs::rename(&staging_dir, dest_dir)?;
        }

        Ok(())
    })();

    if result.is_err() && staging_dir.exists() {
        let _ = fs::remove_dir_all(&staging_dir);
    }

    result
}

fn validate_entry_path(path: &Path) -> Result<()> {
    if path.as_os_str().is_empty()
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::Prefix(_)
                    | std::path::Component::RootDir
                    | std::path::Component::ParentDir,
            )
        })
    {
        return Err(anyhow!("Unsafe archive entry path: {:?}", path));
    }
    Ok(())
}

/// Resolve existing links before processing the next component (especially
/// `..`). Missing leaves are allowed for forward library symlinks, but every
/// resolved component must remain inside the unique staging directory.
fn resolve_link_target(root: &Path, base: &Path, target: &Path, depth: usize) -> Result<PathBuf> {
    if depth > 40 {
        return Err(anyhow!("Archive symlink cycle or excessive chain"));
    }
    let mut cursor = base.to_path_buf();
    for component in target.components() {
        match component {
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                return Err(anyhow!("Absolute archive link target: {:?}", target));
            }
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if cursor == root || !cursor.pop() {
                    return Err(anyhow!("Archive link target escapes staging: {:?}", target));
                }
            }
            std::path::Component::Normal(name) => {
                let next = cursor.join(name);
                match fs::symlink_metadata(&next) {
                    Ok(metadata) if metadata.file_type().is_symlink() => {
                        cursor =
                            resolve_link_target(root, &cursor, &fs::read_link(&next)?, depth + 1)?;
                    }
                    Ok(_) => {
                        cursor = fs::canonicalize(next)?;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        cursor = next;
                    }
                    Err(error) => return Err(error.into()),
                }
            }
        }
        if !cursor.starts_with(root) {
            return Err(anyhow!("Archive link target escapes staging: {:?}", target));
        }
    }
    Ok(cursor)
}

fn archive_output_path(root: &Path, entry: &Path) -> Result<PathBuf> {
    validate_entry_path(entry)?;
    let mut parent = root.to_path_buf();
    if let Some(relative_parent) = entry.parent() {
        for component in relative_parent.components() {
            if let std::path::Component::Normal(name) = component {
                parent = resolve_link_target(root, &parent, Path::new(name), 0)?;
                fs::create_dir_all(&parent)?;
                parent = fs::canonicalize(&parent)?;
                if !parent.starts_with(root) {
                    return Err(anyhow!("Archive parent escapes staging: {:?}", entry));
                }
            }
        }
    }
    Ok(parent.join(
        entry
            .file_name()
            .ok_or_else(|| anyhow!("Invalid archive leaf: {:?}", entry))?,
    ))
}

fn remove_existing_leaf(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => fs::remove_file(path)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

pub fn extract_tar_gz(archive_path: &Path, dest_dir: &Path) -> Result<()> {
    fs::create_dir_all(dest_dir)?;
    let root = fs::canonicalize(dest_dir)?;
    let mut archive = Archive::new(GzDecoder::new(File::open(archive_path)?));
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        validate_entry_path(&path)?;
        let kind = entry.header().entry_type();
        if path == Path::new(".") && kind.is_dir() {
            continue;
        }
        let output = archive_output_path(&root, &path)?;
        if kind.is_dir() {
            let resolved = resolve_link_target(&root, &root, &path, 0)?;
            fs::create_dir_all(&resolved)?;
            if !fs::canonicalize(resolved)?.starts_with(&root) {
                return Err(anyhow!("Archive directory escapes staging: {:?}", path));
            }
        } else if kind.is_symlink() {
            let target = entry
                .link_name()?
                .ok_or_else(|| anyhow!("Archive link has no target"))?
                .into_owned();
            let parent = output
                .parent()
                .ok_or_else(|| anyhow!("Archive link has no parent"))?;
            let resolved = resolve_link_target(&root, parent, &target, 0)?;
            if resolved == output {
                return Err(anyhow!("Archive symlink refers to itself: {:?}", path));
            }
            remove_existing_leaf(&output)?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(&target, &output)?;
            #[cfg(windows)]
            std::os::windows::fs::symlink_file(&target, &output)?;
        } else if kind == tar::EntryType::Link {
            let target = entry
                .link_name()?
                .ok_or_else(|| anyhow!("Archive hardlink has no target"))?
                .into_owned();
            let source = fs::canonicalize(resolve_link_target(&root, &root, &target, 0)?)?;
            if !source.starts_with(&root) || !source.is_file() {
                return Err(anyhow!("Unsafe archive hardlink target: {:?}", target));
            }
            remove_existing_leaf(&output)?;
            fs::hard_link(source, output)?;
        } else if kind.is_file() {
            remove_existing_leaf(&output)?;
            copy(&mut entry, &mut File::create(&output)?)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(
                    &output,
                    fs::Permissions::from_mode(entry.header().mode()? & 0o777),
                )?;
            }
        } else {
            return Err(anyhow!("Unsupported archive entry type for {:?}", path));
        }
    }
    Ok(())
}

pub fn extract_zip(archive_path: &Path, dest_dir: &Path) -> Result<()> {
    fs::create_dir_all(dest_dir)?;
    let root = fs::canonicalize(dest_dir)?;
    let mut archive = zip::ZipArchive::new(File::open(archive_path)?)?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let path = entry
            .enclosed_name()
            .ok_or_else(|| anyhow!("Unsafe ZIP entry: {}", entry.name()))?;
        validate_entry_path(&path)?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(anyhow!("Unsupported ZIP symlink entry: {}", entry.name()));
        }
        let output = archive_output_path(&root, &path)?;
        if entry.is_dir() {
            fs::create_dir_all(&output)?;
            if !fs::canonicalize(&output)?.starts_with(&root) {
                return Err(anyhow!("ZIP directory escapes staging"));
            }
        } else {
            remove_existing_leaf(&output)?;
            copy(&mut entry, &mut File::create(&output)?)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Some(mode) = entry.unix_mode() {
                    fs::set_permissions(&output, fs::Permissions::from_mode(mode & 0o777))?;
                }
            }
        }
    }
    Ok(())
}

/// Synchronous ownership of every starting or ready child. Generation changes,
/// replacement, and shutdown all occur while holding the same mutex.
#[derive(Default)]
pub struct RuntimeProcesses {
    epoch: u64,
    shutting_down: bool,
    pub process: Option<LlamaServerProcess>,
}

impl RuntimeProcesses {
    pub fn current_epoch(&self) -> u64 {
        self.epoch
    }
    pub fn begin(&mut self) -> Result<u64> {
        if self.shutting_down {
            return Err(anyhow!("Auto-input runtime is shutting down"));
        }
        self.epoch += 1;
        self.process = None;
        Ok(self.epoch)
    }

    pub fn owns(&self, epoch: u64) -> bool {
        !self.shutting_down && self.epoch == epoch
    }

    pub fn spawn(&mut self, epoch: u64, server: &Path, model: &Path, model_id: &str) -> Result<()> {
        if !self.owns(epoch) {
            return Err(anyhow!("Model load superseded"));
        }
        // Child creation and registration are one synchronous critical section.
        self.process = Some(LlamaServerProcess::spawn(server, model, model_id)?);
        Ok(())
    }

    pub fn kill_owned(&mut self, epoch: u64) {
        if self.owns(epoch) {
            self.process = None;
        }
    }

    pub fn shutdown(&mut self) {
        self.shutting_down = true;
        self.epoch += 1;
        self.process = None;
    }
}

/// Managed child remains in RuntimeProcesses during the entire readiness wait.
pub struct LlamaServerProcess {
    child: Option<Child>,
    pub port: u16,
    pub token: String,
    pub model_id: String,
    pub ready: bool,
}

impl Drop for LlamaServerProcess {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl LlamaServerProcess {
    fn spawn(server_exe: &Path, model_path: &Path, model_id: &str) -> Result<Self> {
        if !server_exe.is_file() || !model_path.is_file() {
            return Err(anyhow!(
                "Runtime executable or selected model file is missing"
            ));
        }
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        drop(listener);
        let token = uuid::Uuid::new_v4().to_string();
        let mut cmd = Command::new(server_exe);
        cmd.args([
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--api-key",
            &token,
            "-m",
            &model_path.to_string_lossy(),
            "-c",
            &super::resolver::RUNTIME_CONTEXT_LIMIT.to_string(),
            "--parallel",
            "1",
            "--jinja",
            "-ngl",
            "99",
            "--no-webui",
        ]);
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
        if let Some(parent) = server_exe.parent() {
            cmd.current_dir(parent);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        let child = cmd
            .spawn()
            .map_err(|e| anyhow!("Failed to spawn llama-server: {}", e))?;
        Ok(Self {
            child: Some(child),
            port,
            token,
            model_id: model_id.to_owned(),
            ready: false,
        })
    }
}

pub async fn wait_for_readiness(processes: &Mutex<RuntimeProcesses>, epoch: u64) -> Result<()> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(600))
        .build()?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let (port, token) = {
            let mut owner = processes.lock();
            if !owner.owns(epoch) {
                return Err(anyhow!("Model load superseded"));
            }
            let process = owner
                .process
                .as_mut()
                .ok_or_else(|| anyhow!("llama-server was terminated during startup"))?;
            if let Some(status) = process
                .child
                .as_mut()
                .ok_or_else(|| anyhow!("llama-server child is missing"))?
                .try_wait()?
            {
                return Err(anyhow!("llama-server exited during startup: {}", status));
            }
            (process.port, process.token.clone())
        };
        if Instant::now() >= deadline {
            return Err(anyhow!(
                "Timed out waiting for llama-server readiness on port {}",
                port
            ));
        }
        let response = client
            .get(format!("http://127.0.0.1:{}/health", port))
            .bearer_auth(&token)
            .send()
            .await;
        if !processes.lock().owns(epoch) {
            return Err(anyhow!("Model load superseded"));
        }
        if let Ok(response) = response {
            if response.status().is_success() {
                if let Ok(body) = response.json::<serde_json::Value>().await {
                    if body.get("status").and_then(|s| s.as_str()) == Some("ok") {
                        // Publication happens in the manager under the same owner lock.
                        return Ok(());
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_extraction_safe_links() {
        let dir = tempdir().unwrap();
        let valid_tar_gz = dir.path().join("valid.tar.gz");

        // 1. Valid archive with relative symlink
        {
            let file = File::create(&valid_tar_gz).unwrap();
            let enc = flate2::write::GzEncoder::new(file, flate2::Compression::default());
            let mut tar = tar::Builder::new(enc);

            let mut header = tar::Header::new_gnu();
            header.set_path("libfoo.so.1").unwrap();
            header.set_size(5);
            header.set_entry_type(tar::EntryType::Regular);
            header.set_mode(0o644);
            header.set_cksum();
            tar.append(&header, &b"dummy"[..]).unwrap();

            let mut sym_header = tar::Header::new_gnu();
            sym_header.set_path("libfoo.so").unwrap();
            sym_header.set_entry_type(tar::EntryType::Symlink);
            sym_header.set_link_name("libfoo.so.1").unwrap();
            sym_header.set_size(0);
            sym_header.set_mode(0o777);
            sym_header.set_cksum();
            tar.append(&sym_header, std::io::empty()).unwrap();

            tar.finish().unwrap();
        }

        let extract_valid_dir = dir.path().join("extracted_valid");
        assert!(extract_tar_gz(&valid_tar_gz, &extract_valid_dir).is_ok());
        let symlink_path = extract_valid_dir.join("libfoo.so");
        #[cfg(unix)]
        {
            assert!(symlink_path.is_symlink());
        }

        // 2. Dangerous archive with absolute symlink
        let bad_tar_gz = dir.path().join("bad.tar.gz");
        {
            let file = File::create(&bad_tar_gz).unwrap();
            let enc = flate2::write::GzEncoder::new(file, flate2::Compression::default());
            let mut tar = tar::Builder::new(enc);

            let mut sym_header = tar::Header::new_gnu();
            sym_header.set_path("bad_symlink").unwrap();
            sym_header.set_entry_type(tar::EntryType::Symlink);
            sym_header.set_link_name("/etc/passwd").unwrap();
            sym_header.set_size(0);
            sym_header.set_mode(0o777);
            sym_header.set_cksum();
            tar.append(&sym_header, std::io::empty()).unwrap();

            tar.finish().unwrap();
        }

        let extract_bad_dir = dir.path().join("extracted_bad");
        assert!(extract_tar_gz(&bad_tar_gz, &extract_bad_dir).is_err());
    }

    #[test]
    fn test_extraction_symlink_parent_chain_escape_blocked() {
        let dir = tempdir().unwrap();
        let bad_tar_gz = dir.path().join("parent_chain_escape.tar.gz");

        {
            let file = File::create(&bad_tar_gz).unwrap();
            let enc = flate2::write::GzEncoder::new(file, flate2::Compression::default());
            let mut tar = tar::Builder::new(enc);

            // 1. Dir a/b
            let mut dir_header = tar::Header::new_gnu();
            dir_header.set_path("a/b").unwrap();
            dir_header.set_entry_type(tar::EntryType::Directory);
            dir_header.set_size(0);
            dir_header.set_mode(0o755);
            dir_header.set_cksum();
            tar.append(&dir_header, std::io::empty()).unwrap();

            // 2. Symlink a/b/c -> ../.. (points to staging root)
            let mut sym1 = tar::Header::new_gnu();
            sym1.set_path("a/b/c").unwrap();
            sym1.set_entry_type(tar::EntryType::Symlink);
            sym1.set_link_name("../..").unwrap();
            sym1.set_size(0);
            sym1.set_mode(0o777);
            sym1.set_cksum();
            tar.append(&sym1, std::io::empty()).unwrap();

            // 3. Symlink a/b/c/escape -> ../../.. (attempts escape via symlink c)
            let mut sym2 = tar::Header::new_gnu();
            sym2.set_path("a/b/c/escape").unwrap();
            sym2.set_entry_type(tar::EntryType::Symlink);
            sym2.set_link_name("../../..").unwrap();
            sym2.set_size(0);
            sym2.set_mode(0o777);
            sym2.set_cksum();
            tar.append(&sym2, std::io::empty()).unwrap();

            // 4. File a/b/c/escape/pwned.txt
            let mut file_header = tar::Header::new_gnu();
            file_header.set_path("a/b/c/escape/pwned.txt").unwrap();
            file_header.set_entry_type(tar::EntryType::Regular);
            file_header.set_size(6);
            file_header.set_mode(0o644);
            file_header.set_cksum();
            tar.append(&file_header, &b"pwned!"[..]).unwrap();

            tar.finish().unwrap();
        }

        let extract_dir = dir.path().join("staging");
        fs::create_dir_all(&extract_dir).unwrap();
        let res = extract_tar_gz(&bad_tar_gz, &extract_dir);
        assert!(res.is_err(), "Symlink parent chain escape must be blocked");
        assert!(
            !dir.path().join("pwned.txt").exists(),
            "Must not write escaped file outside destination"
        );
    }

    #[test]
    fn test_extraction_zip_rejection() {
        let dir = tempdir().unwrap();
        let zip_path = dir.path().join("traversal.zip");

        {
            let file = File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("../../evil.txt", options).unwrap();
            std::io::Write::write_all(&mut zip, b"evil payload").unwrap();
            zip.finish().unwrap();
        }

        let extract_dir = dir.path().join("extracted_zip");
        let res = extract_zip(&zip_path, &extract_dir);
        assert!(
            res.is_err(),
            "Zip entry with path traversal must be rejected"
        );
    }

    #[cfg(unix)]
    fn sleeping_server(dir: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let server = dir.join("llama-server");
        fs::write(&server, "#!/bin/sh\nexec sleep 60\n").unwrap();
        fs::set_permissions(&server, fs::Permissions::from_mode(0o755)).unwrap();
        server
    }

    #[cfg(unix)]
    #[test]
    fn stale_start_cannot_replace_newer_owned_child() {
        let dir = tempdir().unwrap();
        let server = sleeping_server(dir.path());
        let model = dir.path().join("model.gguf");
        fs::write(&model, b"fixture").unwrap();
        let mut processes = RuntimeProcesses::default();
        let old = processes.begin().unwrap();
        let new = processes.begin().unwrap();
        processes.spawn(new, &server, &model, "new").unwrap();
        let pid = processes
            .process
            .as_ref()
            .unwrap()
            .child
            .as_ref()
            .unwrap()
            .id();
        assert!(processes.spawn(old, &server, &model, "old").is_err());
        assert_eq!(
            processes
                .process
                .as_ref()
                .unwrap()
                .child
                .as_ref()
                .unwrap()
                .id(),
            pid
        );
        assert_eq!(processes.process.as_ref().unwrap().model_id, "new");
        processes.shutdown();
    }

    #[cfg(unix)]
    #[test]
    fn shutdown_reaps_starting_child_and_blocks_late_spawn() {
        let dir = tempdir().unwrap();
        let server = sleeping_server(dir.path());
        let model = dir.path().join("model.gguf");
        fs::write(&model, b"fixture").unwrap();
        let mut processes = RuntimeProcesses::default();
        let epoch = processes.begin().unwrap();
        processes.spawn(epoch, &server, &model, "starting").unwrap();
        let pid = processes
            .process
            .as_ref()
            .unwrap()
            .child
            .as_ref()
            .unwrap()
            .id();
        processes.shutdown();
        assert!(processes.process.is_none());
        assert!(processes.spawn(epoch, &server, &model, "late").is_err());
        assert!(processes.begin().is_err());
        assert!(!Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn aborting_readiness_reaps_owned_child() {
        let dir = tempdir().unwrap();
        let server = sleeping_server(dir.path());
        let model = dir.path().join("model.gguf");
        fs::write(&model, b"fixture").unwrap();
        let processes = std::sync::Arc::new(Mutex::new(RuntimeProcesses::default()));
        let epoch = processes.lock().begin().unwrap();
        processes
            .lock()
            .spawn(epoch, &server, &model, "starting")
            .unwrap();
        let pid = processes
            .lock()
            .process
            .as_ref()
            .unwrap()
            .child
            .as_ref()
            .unwrap()
            .id();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let worker_processes = processes.clone();
        let worker = tokio::spawn(async move {
            let _guard = crate::managers::auto_input::ModelLoadGuard::new(&worker_processes, epoch);
            started_tx.send(()).unwrap();
            wait_for_readiness(&worker_processes, epoch).await
        });
        started_rx.await.unwrap();
        worker.abort();
        assert!(worker.await.unwrap_err().is_cancelled());
        assert!(processes.lock().process.is_none());
        assert!(!Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success());
    }

    fn write_tar(path: &Path, entries: &[(&str, tar::EntryType, &str, &[u8])]) {
        let encoder = flate2::write::GzEncoder::new(
            File::create(path).unwrap(),
            flate2::Compression::default(),
        );
        let mut archive = tar::Builder::new(encoder);
        for (name, kind, target, body) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_path(name).unwrap();
            header.set_entry_type(*kind);
            header.set_size(body.len() as u64);
            header.set_mode(0o755);
            if !target.is_empty() {
                header.set_link_name(target).unwrap();
            }
            header.set_cksum();
            archive.append(&header, *body).unwrap();
        }
        archive.into_inner().unwrap().finish().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn safe_directory_symlinks_and_hardlinks_survive_extraction() {
        let dir = tempdir().unwrap();
        let archive = dir.path().join("safe.tar.gz");
        write_tar(
            &archive,
            &[
                ("lib/payload", tar::EntryType::Regular, "", b"library"),
                ("alias", tar::EntryType::Symlink, "lib", b""),
                ("alias/extra", tar::EntryType::Regular, "", b"extra"),
                ("lib/hard", tar::EntryType::Link, "lib/payload", b""),
            ],
        );
        let staging = dir.path().join("staging");
        extract_tar_gz(&archive, &staging).unwrap();
        assert_eq!(fs::read(staging.join("alias/payload")).unwrap(), b"library");
        assert_eq!(fs::read(staging.join("lib/extra")).unwrap(), b"extra");
        assert_eq!(fs::read(staging.join("lib/hard")).unwrap(), b"library");
    }

    #[cfg(unix)]
    #[test]
    fn executable_verification_precedes_runtime_publication() {
        let dir = tempdir().unwrap();
        let destination = dir.path().join("runtime");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("old-installation"), b"keep").unwrap();
        let archive = dir.path().join("broken.tar.gz");
        write_tar(
            &archive,
            &[(
                "llama-server",
                tar::EntryType::Regular,
                "",
                b"#!/bin/sh\nexit 1\n",
            )],
        );
        assert!(extract_runtime_archive(&archive, &destination, false).is_err());
        assert_eq!(
            fs::read(destination.join("old-installation")).unwrap(),
            b"keep"
        );
        assert!(!destination.join("llama-server").exists());

        write_tar(
            &archive,
            &[(
                "llama-server",
                tar::EntryType::Regular,
                "",
                b"#!/bin/sh\n[ \"$1\" = --version ]\n",
            )],
        );
        extract_runtime_archive(&archive, &destination, false).unwrap();
        assert!(destination.join("llama-server").is_file());
        assert!(!destination.join("old-installation").exists());
    }
}
