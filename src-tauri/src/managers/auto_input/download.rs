//! Verified, cancellable streaming downloader with on-the-fly SHA256 calculation.

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum DownloadError {
    #[error("Download was cancelled")]
    Cancelled,

    #[error("HTTP request failed: {0}")]
    Http(#[from] reqwest::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("SHA256 mismatch: expected {expected}, computed {actual}")]
    HashMismatch { expected: String, actual: String },

    #[error("Size mismatch: expected {expected} bytes, got {actual} bytes")]
    SizeMismatch { expected: u64, actual: u64 },

    #[error("Download failed: {0}")]
    Other(String),
}

/// Awaitable cancellation shared by the downloader and command completion barrier.
#[derive(Clone)]
pub struct DownloadCancellationToken {
    cancelled: tokio::sync::watch::Sender<bool>,
}

impl Default for DownloadCancellationToken {
    fn default() -> Self {
        Self::new()
    }
}

impl DownloadCancellationToken {
    pub fn new() -> Self {
        let (cancelled, _) = tokio::sync::watch::channel(false);
        Self { cancelled }
    }

    pub fn cancel(&self) {
        self.cancelled.send_replace(true);
    }

    pub fn is_cancelled(&self) -> bool {
        *self.cancelled.borrow()
    }

    pub async fn cancelled(&self) {
        let mut receiver = self.cancelled.subscribe();
        let _ = receiver.wait_for(|cancelled| *cancelled).await;
    }
}

/// Downloads a file from `url` to `dest_path`.
/// Writes to `<dest_path>.part` during download, verifies size and SHA256,
/// and renames to `dest_path` only on success.
/// On cancellation, hash mismatch, or IO error, the `.part` file is deleted.
pub async fn download_file_verified<F>(
    client: &reqwest::Client,
    urls: &[String],
    dest_path: &Path,
    expected_size: u64,
    expected_sha256: &str,
    cancel_token: DownloadCancellationToken,
    mut on_progress: F,
) -> Result<(), DownloadError>
where
    F: FnMut(u64, u64),
{
    if urls.is_empty() {
        return Err(DownloadError::Other(
            "No download URLs provided".to_string(),
        ));
    }

    // Ensure parent directory exists
    if let Some(parent) = dest_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let part_path = PathBuf::from(format!("{}.part", dest_path.to_string_lossy()));

    // Clean up any stale partial download before starting
    if part_path.exists() {
        let _ = fs::remove_file(&part_path);
    }

    let mut last_err = None;

    for url in urls {
        if cancel_token.is_cancelled() {
            return Err(DownloadError::Cancelled);
        }

        match download_single_stream(
            client,
            url,
            &part_path,
            expected_size,
            expected_sha256,
            cancel_token.clone(),
            &mut on_progress,
        )
        .await
        {
            Ok(()) => {
                // Check cancellation flag immediately before the rename/publication step
                if cancel_token.is_cancelled() {
                    let _ = fs::remove_file(&part_path);
                    return Err(DownloadError::Cancelled);
                }
                // Verification passed, atomically rename .part to dest_path
                if let Err(error) = fs::rename(&part_path, dest_path) {
                    let _ = fs::remove_file(&part_path);
                    return Err(DownloadError::Io(error));
                }
                return Ok(());
            }
            Err(DownloadError::Cancelled) => {
                let _ = fs::remove_file(&part_path);
                return Err(DownloadError::Cancelled);
            }
            Err(e) => {
                let _ = fs::remove_file(&part_path);
                log::warn!("Download attempt failed for url {}: {}", url, e);
                last_err = Some(e);
            }
        }
    }

    Err(last_err.unwrap_or_else(|| DownloadError::Other("All download URLs failed".to_string())))
}

async fn download_single_stream<F>(
    client: &reqwest::Client,
    url: &str,
    part_path: &Path,
    expected_size: u64,
    expected_sha256: &str,
    cancel_token: DownloadCancellationToken,
    on_progress: &mut F,
) -> Result<(), DownloadError>
where
    F: FnMut(u64, u64),
{
    if cancel_token.is_cancelled() {
        let _ = fs::remove_file(part_path);
        return Err(DownloadError::Cancelled);
    }

    let response = tokio::select! {
        biased;
        _ = cancel_token.cancelled() => {
            let _ = fs::remove_file(part_path);
            return Err(DownloadError::Cancelled);
        }
        res = client.get(url).send() => {
            res.map_err(DownloadError::Http)?
        }
    };

    if !response.status().is_success() {
        return Err(DownloadError::Other(format!(
            "Server returned HTTP status {}",
            response.status()
        )));
    }

    let total_size = response.content_length().unwrap_or(expected_size);

    let mut file = File::create(part_path)?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();

    loop {
        let chunk_opt = tokio::select! {
            biased;
            _ = cancel_token.cancelled() => {
                drop(file);
                let _ = fs::remove_file(part_path);
                return Err(DownloadError::Cancelled);
            }
            item = stream.next() => {
                match item {
                    Some(Ok(chunk)) => Some(chunk),
                    Some(Err(e)) => return Err(DownloadError::Http(e)),
                    None => None,
                }
            }
        };

        let chunk = match chunk_opt {
            Some(c) => c,
            None => break,
        };

        file.write_all(&chunk)?;
        hasher.update(&chunk);

        downloaded += chunk.len() as u64;
        on_progress(downloaded, total_size);
    }

    file.flush()?;
    drop(file);

    if cancel_token.is_cancelled() {
        let _ = fs::remove_file(part_path);
        return Err(DownloadError::Cancelled);
    }

    // Verify size
    let metadata = fs::metadata(part_path)?;
    let actual_size = metadata.len();
    if expected_size > 0 && actual_size != expected_size {
        let _ = fs::remove_file(part_path);
        return Err(DownloadError::SizeMismatch {
            expected: expected_size,
            actual: actual_size,
        });
    }

    // Verify SHA256
    let actual_sha256 = format!("{:x}", hasher.finalize());
    if !expected_sha256.is_empty() && actual_sha256.to_lowercase() != expected_sha256.to_lowercase()
    {
        let _ = fs::remove_file(part_path);
        return Err(DownloadError::HashMismatch {
            expected: expected_sha256.to_string(),
            actual: actual_sha256,
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::time::Duration;
    use tempfile::tempdir;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn start_loopback_server(
        content: Vec<u8>,
        chunk_delay: Option<Duration>,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let url = format!("http://127.0.0.1:{}/data", port);

        let handle = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let content = content.clone();
                tokio::spawn(async move {
                    let mut req_buf = [0u8; 1024];
                    let _ = socket.read(&mut req_buf).await;

                    let header = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        content.len()
                    );
                    if socket.write_all(header.as_bytes()).await.is_err() {
                        return;
                    }

                    if let Some(delay) = chunk_delay {
                        for chunk in content.chunks(64) {
                            tokio::time::sleep(delay).await;
                            if socket.write_all(chunk).await.is_err() {
                                break;
                            }
                        }
                    } else {
                        let _ = socket.write_all(&content).await;
                    }
                });
            }
        });

        (url, handle)
    }

    #[tokio::test]
    async fn test_downloader_hash_verification() {
        let dir = tempdir().unwrap();
        let client = reqwest::Client::new();
        let content = b"verified content for auto-input downloader test".to_vec();

        let mut hasher = Sha256::new();
        hasher.update(&content);
        let correct_hash = format!("{:x}", hasher.finalize());
        let correct_size = content.len() as u64;

        let (url, server) = start_loopback_server(content, None).await;

        // 1. Success with correct hash and size
        let dest_success = dir.path().join("success.bin");
        let part_success = dir.path().join("success.bin.part");
        let cancel_token = DownloadCancellationToken::new();

        let res = download_file_verified(
            &client,
            std::slice::from_ref(&url),
            &dest_success,
            correct_size,
            &correct_hash,
            cancel_token.clone(),
            |_, _| {},
        )
        .await;

        assert!(
            res.is_ok(),
            "Download with correct hash should succeed: {:?}",
            res.err()
        );
        assert!(dest_success.exists());
        assert!(!part_success.exists());

        // 2. Failure with wrong hash and verify .part cleanup
        let dest_fail = dir.path().join("fail.bin");
        let part_fail = dir.path().join("fail.bin.part");
        let wrong_hash = "0000000000000000000000000000000000000000000000000000000000000000";

        let res_fail = download_file_verified(
            &client,
            std::slice::from_ref(&url),
            &dest_fail,
            correct_size,
            wrong_hash,
            cancel_token.clone(),
            |_, _| {},
        )
        .await;

        assert!(matches!(res_fail, Err(DownloadError::HashMismatch { .. })));
        assert!(!dest_fail.exists());
        assert!(
            !part_fail.exists(),
            ".part file must be cleaned up on hash mismatch"
        );

        server.abort();
    }

    #[tokio::test]
    async fn test_downloader_cancellation() {
        let dir = tempdir().unwrap();
        let client = reqwest::Client::new();
        let content = vec![b'x'; 2048];

        let (url, server) = start_loopback_server(content, Some(Duration::from_millis(50))).await;

        let dest = dir.path().join("cancelled.bin");
        let part = dir.path().join("cancelled.bin.part");
        let cancel_token = DownloadCancellationToken::new();

        let token_clone = cancel_token.clone();
        let dest_clone = dest.clone();
        let url_clone = url.clone();
        let download_task = tokio::spawn(async move {
            download_file_verified(
                &client,
                &[url_clone],
                &dest_clone,
                2048,
                "",
                token_clone,
                |_, _| {},
            )
            .await
        });

        // Let streaming start
        tokio::time::sleep(Duration::from_millis(100)).await;
        // Signal cancellation mid-stream
        cancel_token.cancel();

        let res = download_task.await.unwrap();
        assert!(matches!(res, Err(DownloadError::Cancelled)));
        assert!(!dest.exists());
        assert!(
            !part.exists(),
            ".part file must be cleaned up on cancellation"
        );

        server.abort();
    }

    async fn cancellation_during_stall(stall_headers: bool) {
        let dir = tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/data", listener.local_addr().unwrap());
        let (stalled_tx, stalled_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 1024];
            // The helper request is short; a partial read is enough to observe
            // that the downloader got as far as sending headers.
            let _ = socket.read(&mut request).await.unwrap();
            if !stall_headers {
                socket
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4096\r\n\r\nx")
                    .await
                    .unwrap();
            }
            stalled_tx.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        let dest = dir.path().join("stalled.bin");
        let token = DownloadCancellationToken::new();
        let download_token = token.clone();
        let download_dest = dest.clone();
        let (progress_tx, mut progress_rx) = tokio::sync::mpsc::unbounded_channel();
        let download = tokio::spawn(async move {
            download_file_verified(
                &reqwest::Client::builder().no_proxy().build().unwrap(),
                &[url],
                &download_dest,
                4096,
                "",
                download_token,
                move |_, _| {
                    let _ = progress_tx.send(());
                },
            )
            .await
        });
        stalled_rx.await.unwrap();
        if !stall_headers {
            progress_rx.recv().await.unwrap();
        }
        token.cancel();
        let result = tokio::time::timeout(Duration::from_secs(1), download)
            .await
            .expect("cancellation must interrupt the stalled HTTP await")
            .unwrap();
        assert!(matches!(result, Err(DownloadError::Cancelled)));
        assert!(!dest.exists());
        assert!(!dir.path().join("stalled.bin.part").exists());
        server.abort();
    }

    #[tokio::test]
    async fn cancellation_interrupts_stalled_headers() {
        cancellation_during_stall(true).await;
    }

    #[tokio::test]
    async fn cancellation_interrupts_stalled_body() {
        cancellation_during_stall(false).await;
    }
}
