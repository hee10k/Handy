//! 컴포저 (composer): a global always-on-top textarea window and the commit loop.
//!
//! The composer is the typing entry point of Tajagi (POC gate). Pressing the
//! composer hotkey opens a small, always-on-top window hosting a `<textarea>`;
//! the native OS IME (한글/영문 composition) works inside it because the window
//! is a *normal, focusable* webview window — unlike the recording overlay,
//! which is intentionally a non-key window so it never steals focus while the
//! mic is live.
//!
//! On **commit** the loop is:
//!   1. hide the composer, 2. hand focus back to the window that had it before
//!   the hotkey, 3. paste the text at that window's cursor, 4. restore the
//!   clipboard.
//! Steps 3–4 are exactly `clipboard::paste` — the same save→write→chord→restore
//! path (including `paste_tx` receipt-sequenced reliable paste) that the
//! transcription pipeline already uses. No new OS paste code.
//!
//! **Esc / empty-commit** cancel with no side effects: the composer closes,
//! focus returns, and the clipboard is never touched.

use std::sync::{Arc, LazyLock, Mutex};

use log::{debug, error, warn};
use tauri::{AppHandle, Emitter, Manager};

use crate::managers::history::HistoryManager;

/// Window label for the composer webview. Also must be listed in
/// `capabilities/default.json` so the webview may invoke commands / listen.
pub const COMPOSER_WINDOW_LABEL: &str = "composer";

/// Native window size (logical points). Non-resizable; must fit the mode
/// selector row (and, in Custom mode, the instruction input) above the
/// `<textarea>`, so it is taller than the ticket-02-only build.
const COMPOSER_WIDTH: f64 = 540.0;
const COMPOSER_HEIGHT: f64 = 340.0;

/// The window that owned foreground focus right before the composer opened.
/// Stored as a plain integer so the value is `Send + Sync` for the static.
struct CapturedFocus {
    raw: isize,
}

static CAPTURED_FOCUS: LazyLock<Mutex<Option<CapturedFocus>>> =
    LazyLock::new(|| Mutex::new(None));

fn remember_focus(focus: Option<CapturedFocus>) {
    if let Ok(mut guard) = CAPTURED_FOCUS.lock() {
        *guard = focus;
    }
}

fn take_captured_focus() -> Option<CapturedFocus> {
    match CAPTURED_FOCUS.lock() {
        Ok(mut guard) => guard.take(),
        Err(poisoned) => poisoned.into_inner().take(),
    }
}

// ============================================================================
// Platform focus capture / restore
// ============================================================================

/// Windows: capture the top-level foreground HWND and restore it with
/// `SetForegroundWindow` once the composer hides.
#[cfg(target_os = "windows")]
mod platform {
    use super::CapturedFocus;
    use std::ffi::c_void;
    use tauri::AppHandle;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
    };

    /// Returns the window currently holding foreground focus, unless it belongs
    /// to this process (the composer is already open) — in which case there is
    /// nothing new to restore to, so keep whatever was captured before.
    pub(super) fn capture_focus(_app: &AppHandle) -> Option<CapturedFocus> {
        // SAFETY: these Win32 calls are trivially safe-fire on any thread.
        unsafe {
            let foreground = GetForegroundWindow();
            if foreground.is_invalid() {
                return None;
            }
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(foreground, Some(&mut pid));
            if pid == std::process::id() {
                return None;
            }
            Some(CapturedFocus {
                raw: foreground.0 as usize as isize,
            })
        }
    }

    pub(super) fn restore_focus(_app: &AppHandle, focus: &CapturedFocus) {
        let hwnd = HWND(focus.raw as usize as *mut c_void);
        unsafe {
            // SetForegroundWindow can be denied by the foreground-lock in some
            // cases; BringWindowToTop is a gentler follow-up. Because we hid the
            // composer first, Windows itself usually restores the previous
            // foreground window, so this is a reinforcement, not the sole path.
            let _ = SetForegroundWindow(hwnd);
            let _ = BringWindowToTop(hwnd);
        }
    }

    /// Windows key-window enforcement is handled by tauri's `set_focus()` +
    /// `SetForegroundWindow`, so this is a no-op placeholder for the shared
    /// open path.
    pub(super) fn ensure_key_window(_window: &tauri::WebviewWindow) {}
}

/// macOS: capture the frontmost running application and reactivate it.
/// Uses `objc2-app-kit` (already a dependency of the reliable-paste path).
#[cfg(target_os = "macos")]
mod platform {
    use super::CapturedFocus;
    use log::{debug, warn};
    use objc2::msg_send;
    use objc2_app_kit::{
        NSApplicationActivationOptions, NSRunningApplication, NSWorkspace,
    };
    use tauri::AppHandle;

    /// Requires the main thread (AppKit). `open_composer` dispatches here before
    /// calling capture, so this runs on the main thread.
    pub(super) fn capture_focus(_app: &AppHandle) -> Option<CapturedFocus> {
        let workspace = NSWorkspace::sharedWorkspace();
        let frontmost = workspace.frontmostApplication()?;
        let pid = frontmost.processIdentifier() as i32;
        if pid == std::process::id() as i32 {
            // Already in our own app (composer open): keep the earlier capture.
            return None;
        }
        Some(CapturedFocus { raw: pid as isize })
    }

    pub(super) fn restore_focus(_app: &AppHandle, focus: &CapturedFocus) {
        // Hiding our (activating) window already returns focus to the app that
        // was active before; reactivating it is a best-effort push. On macOS 14+
        // `ActivateIgnoringOtherApps` is a no-op, so empty options are correct
        // there and harmless elsewhere.
        let pid = focus.raw as i32;
        let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) else {
            debug!("Composer focus target (pid {pid}) is no longer running");
            return;
        };
        let _ = app.activateWithOptions(NSApplicationActivationOptions::empty());
    }

    /// Enforce that the composer is a key window on macOS so the keyboard IME
    /// (한글/영문 조합) routes into the webview reliably. The composer is a
    /// *normal* `NSWindow` (ticket 02), not the recording `NSPanel` which is
    /// intentionally `canBecomeKeyWindow: false`. A plain `NSWindow` already
    /// answers `canBecomeKeyWindow == YES` and tao's `set_focus` calls
    /// `makeKeyAndOrderFront:` + `activateIgnoringOtherApps:`, so this is a
    /// verification + last-resort push rather than the primary path.
    ///
    /// It reads the live `canBecomeKeyWindow` / `isKeyWindow` state and, if for
    /// any reason the window never took key (e.g. the accessory tray app is not
    /// active when the hotkey fires), forces it key again. Must run on the main
    /// thread.
    pub(super) fn ensure_key_window(window: &tauri::WebviewWindow) {
        // `WebviewWindow::ns_window()` (macOS) returns the AppKit NSWindow.
        let Ok(ns_window) = window.ns_window() else {
            warn!("Composer: could not resolve the native NSWindow to verify key status");
            return;
        };
        // SAFETY: ns_window() yields a live, retained NSWindow pointer valid for
        // the lifetime of this call; we only send idempotent leaf messages and
        // never transfer or release ownership.
        let win = ns_window as *mut objc2::runtime::NSObject;
        let can_become_key: bool = unsafe { msg_send![win, canBecomeKeyWindow] };
        let is_key: bool = unsafe { msg_send![win, isKeyWindow] };
        debug!(
            "Composer key-window check: canBecomeKeyWindow={can_become_key} isKeyWindow={is_key}"
        );
        if !is_key {
            // Make it key (and front) once more; a no-op if it just became key.
            let (): () = unsafe {
                msg_send![
                    win,
                    makeKeyAndOrderFront: std::ptr::null_mut::<objc2::runtime::NSObject>()
                ]
            };
        }
    }
}

/// No focus management on unsupported platforms: the composer is hidden and
/// focus naturally returns to the previously active app.
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod platform {
    use super::CapturedFocus;
    use tauri::AppHandle;

    pub(super) fn capture_focus(_app: &AppHandle) -> Option<CapturedFocus> {
        None
    }

    pub(super) fn restore_focus(_app: &AppHandle, _focus: &CapturedFocus) {}

    pub(super) fn ensure_key_window(_window: &tauri::WebviewWindow) {}
}

// ============================================================================
// Window lifecycle
// ============================================================================

/// Create the composer webview window (hidden). Idempotent. Must run on the
/// main thread (it builds a native window).
fn create_composer(app_handle: &AppHandle) -> Result<(), String> {
    if app_handle.get_webview_window(COMPOSER_WINDOW_LABEL).is_some() {
        return Ok(());
    }

    let mut builder = tauri::WebviewWindowBuilder::new(
        app_handle,
        COMPOSER_WINDOW_LABEL,
        tauri::WebviewUrl::App("src/composer/index.html".into()),
    )
    .title("타자기 컴포저")
    .inner_size(COMPOSER_WIDTH, COMPOSER_HEIGHT)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .closable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .accept_first_mouse(true)
    .focusable(true)
    .visible(false);

    if let Some(data_dir) = crate::portable::data_dir() {
        builder = builder.data_directory(data_dir.join("webview"));
    }

    builder.build().map(|_| ()).map_err(|e| e.to_string())
}

/// Deliver transcribed text directly into the composer webview when the
/// composer is the focused foreground window of this app (i.e. the user is
/// composing and dictates with voice). Returns `true` when delivered — the
/// caller should then skip the OS clipboard paste, which would target the
/// wrong window or race the WebView's focus. The composer webview appends the
/// text to its textarea (`composer-voice-input` event).
pub fn deliver_voice_input_to_focused_composer(app: &AppHandle, text: &str) -> bool {
    if text.trim().is_empty() {
        return false;
    }
    let focused = match app.get_webview_window(COMPOSER_WINDOW_LABEL) {
        Some(window) => {
            window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false)
        }
        None => false,
    };
    if !focused {
        return false;
    }
    let _ = app.emit_to(COMPOSER_WINDOW_LABEL, "composer-voice-input", text.to_string());
    true
}

/// Open the composer: capture the current foreground window, then show /
/// focus the composer and tell its webview to clear + focus the textarea.
pub fn open_composer(app_handle: AppHandle) {
    // Everything touches native windows / AppKit, so run on the main thread.
    let _ = app_handle.clone().run_on_main_thread(move || {
        // Capture BEFORE the composer steals focus.
        if let Some(focus) = platform::capture_focus(&app_handle) {
            remember_focus(Some(focus));
        }

        if let Err(e) = create_composer(&app_handle) {
            error!("Failed to create composer window: {e}");
            return;
        }

        if let Some(window) = app_handle.get_webview_window(COMPOSER_WINDOW_LABEL) {
            let _ = window.center();
            let _ = window.show();
            let _ = window.set_focus();
            // macOS: verify the composer actually became the key window (for
            // 한글 IME composition) and push it key if it did not.
            #[cfg(target_os = "macos")]
            platform::ensure_key_window(&window);
            // The webview clears the previous draft and focuses its <textarea>.
            let _ = app_handle.emit_to(COMPOSER_WINDOW_LABEL, "composer-open", ());
        } else {
            error!("Composer window missing after creation");
        }
    });
}

fn hide_composer(app_handle: &AppHandle) {
    if let Some(window) = app_handle.get_webview_window(COMPOSER_WINDOW_LABEL) {
        let _ = window.hide();
    }
}

// ============================================================================
// Commands (invoked by the composer webview)
// ============================================================================

/// Commit the composer text: close the window, restore focus to the pre-hotkey
/// window, then paste and restore the clipboard via the reused `clipboard::paste`
/// path. Empty text is ignored (equivalent to cancel — no paste, clipboard
/// untouched).
/// Empty text (or whitespace-only) commits nothing — the composer just closes
/// and the clipboard is never touched. Pure so the guard is unit-testable.
fn should_commit(text: &str) -> bool {
    !text.trim().is_empty()
}

/// Map a committed composer session onto the existing transcription-history
/// schema (Spec-18 / Implementation Decision "reuse 전사 히스토리 저장소").
///
/// The composer pastes its final `text` (the "to"). When a transform rewrote
/// the draft, `original` is the pre-transform snapshot (the "from"); otherwise
/// the committed text is also the origin. Returns the row fields in the same
/// order as `HistoryManager::save_entry`, so a committed composer session is
/// recorded with the same `HistoryEntry` shape as a transcription and pings
/// the same real-time listeners — without disturbing the transcription UI
/// (the origin lands in `transcription_text`, the transformed output — if any —
/// in `post_processed_text`, mirroring the transcription store's semantics).
fn composer_history_fields(
    text: &str,
    original: Option<&str>,
    mode: Option<&str>,
) -> (String, String, bool, Option<String>, Option<String>) {
    let transformed = original
        .map(|o| o.trim() != text.trim())
        .unwrap_or(false);
    let transcription_text = original.unwrap_or(text).to_string();
    let post_processed_text = transformed.then(|| text.to_string());
    (
        "composer".to_string(),            // file_name: composer sessions have no audio recording
        transcription_text,                // "from"
        transformed,                       // post_process_requested
        post_processed_text,               // "to"
        mode.map(str::to_string),          // post_process_prompt
    )
}

#[tauri::command]
#[specta::specta]
pub fn commit_composer(
    app: AppHandle,
    text: String,
    original: Option<String>,
    mode: Option<String>,
) -> Result<(), String> {
    if !should_commit(&text) {
        let _ = cancel_composer(app);
        return Ok(());
    }

    // Record the committed composer session in the existing transcription
    // history store (Spec-18). Reuses HistoryManager::save_entry so the row
    // matches the HistoryEntry schema, emits the real-time history-updated
    // event, and keeps history-limit/cleanup behavior identical. `original` /
    // `mode` are optional: the current composer webview only sends `text`, and
    // once it also sends the pre-transform snapshot a rewrite is captured as
    // from→to. A recording failure is logged but never blocks the paste.
    let (file_name, transcription_text, requested, post_processed, prompt) =
        composer_history_fields(&text, original.as_deref(), mode.as_deref());
    if let Err(e) = app
        .state::<Arc<HistoryManager>>()
        .save_entry(file_name, transcription_text, requested, post_processed, prompt)
    {
        error!("Failed to record composer commit in history: {e}");
    }

    let focus = take_captured_focus();

    // Secure Input (secure_input.rs) blocks *synthetic* keystrokes from being
    // read/applied in many apps, so the injected Cmd+V chord may be ignored.
    // The composer's own typing (normal user IME input) is never blocked, so
    // the commit is still attempted — but we surface the condition for the
    // logs and rely on the paste path's guaranteed clipboard restore + graceful
    // error handling (the exact behavior Handy's existing secure-input path
    // inherits) rather than failing silently or touching the clipboard early.
    // Cancellation (cancel_composer) is unaffected and always safe.
    #[cfg(target_os = "macos")]
    if crate::secure_input::is_enabled_now() {
        warn!("Composer commit requested while Secure Input is active: the Cmd+V paste chord may be suppressed; clipboard restore is still guaranteed");
    }

    // Hide the composer and hand focus back to the captured window before the
    // paste chord fires, so the chord lands in the original app at its cursor.
    let app_hide = app.clone();
    let _ = app.run_on_main_thread(move || {
        hide_composer(&app_hide);
        if let Some(focus) = focus {
            platform::restore_focus(&app_hide, &focus);
        }
    });

    // Paste on a worker thread: the clipboard path sleeps (paste_delay_ms,
    // modifier hold) and must not block the webview IPC.
    let app_paste = app;
    std::thread::spawn(move || {
        // Give the focus handoff a moment to land before injecting keys.
        std::thread::sleep(std::time::Duration::from_millis(80));
        // macOS: the paste path uses main-thread-only AppKit APIs — the
        // layout-aware Cmd+V resolution (input.rs TIS APIs) and, when
        // reliable_paste is on, the NSPasteboard promise (paste_tx/macos.rs).
        // Keep the 80ms settle on this worker, then dispatch the paste onto
        // the main thread exactly like the transcription paste path
        // (actions.rs). `run_on_main_thread` runs inline when already on the
        // main thread, so the non-macOS branch below is equivalent.
        #[cfg(target_os = "macos")]
        {
            let app_for_main = app_paste.clone();
            let _ = app_for_main.run_on_main_thread(move || {
                match crate::clipboard::paste(text, app_paste) {
                    Ok(()) => debug!("Composer commit pasted"),
                    Err(e) => error!("Composer commit paste failed: {e}"),
                }
            });
        }
        #[cfg(not(target_os = "macos"))]
        {
            match crate::clipboard::paste(text, app_paste) {
                Ok(()) => debug!("Composer commit pasted"),
                Err(e) => error!("Composer commit paste failed: {e}"),
            }
        }
    });

    Ok(())
}

/// Cancel the composer: close the window and return focus to the pre-hotkey
/// window. No paste and no clipboard change.
#[tauri::command]
#[specta::specta]
pub fn cancel_composer(app: AppHandle) -> Result<(), String> {
    let focus = take_captured_focus();
    let _ = app.clone().run_on_main_thread(move || {
        hide_composer(&app);
        if let Some(focus) = focus {
            platform::restore_focus(&app, &focus);
        }
    });
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::{composer_history_fields, should_commit};

    #[test]
    fn empty_and_whitespace_text_never_commits() {
        assert!(!should_commit(""));
        assert!(!should_commit("   "));
        assert!(!should_commit("\n\t\r\n"));
        assert!(!should_commit("\u{00A0}\u{3000}"));
    }

    #[test]
    fn non_blank_text_commits() {
        assert!(should_commit("안녕하세요"));
        assert!(should_commit("  hello world  "));
        assert!(should_commit("한\n글"));
    }

    #[test]
    fn composer_history_fields_plain_commit_is_the_source() {
        // No transform (no `original`): the committed text is both origin and
        // final; nothing marked as post-processed so the transcription UI is
        // untouched.
        let (file_name, from, requested, to, prompt) =
            composer_history_fields("안녕하세요", None, None);
        assert_eq!(file_name, "composer");
        assert_eq!(from, "안녕하세요");
        assert!(!requested);
        assert_eq!(to, None);
        assert_eq!(prompt, None);
    }

    #[test]
    fn composer_history_fields_transform_captures_from_to() {
        let (file_name, from, requested, to, prompt) =
            composer_history_fields("polished text", Some("raw draft"), Some("polish"));
        assert_eq!(file_name, "composer");
        assert_eq!(from, "raw draft");
        assert!(requested);
        assert_eq!(to, Some("polished text".to_string()));
        assert_eq!(prompt, Some("polish".to_string()));
    }

    #[test]
    fn composer_history_fields_identical_original_is_not_a_transform() {
        let (_, _, requested, to, _) =
            composer_history_fields("same", Some("same"), Some("polish"));
        assert!(!requested);
        assert_eq!(to, None);
    }
}
