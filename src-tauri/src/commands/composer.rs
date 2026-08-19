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

use std::sync::{LazyLock, Mutex};

use log::{debug, error};
use tauri::{AppHandle, Emitter, Manager};

/// Window label for the composer webview. Also must be listed in
/// `capabilities/default.json` so the webview may invoke commands / listen.
pub const COMPOSER_WINDOW_LABEL: &str = "composer";

/// Native window size (logical points). Kept small and non-resizable for the
/// POC; the `<textarea>` fills it.
const COMPOSER_WIDTH: f64 = 540.0;
const COMPOSER_HEIGHT: f64 = 168.0;

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
}

/// macOS: capture the frontmost running application and reactivate it.
/// Uses `objc2-app-kit` (already a dependency of the reliable-paste path).
#[cfg(target_os = "macos")]
mod platform {
    use super::CapturedFocus;
    use log::debug;
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

#[tauri::command]
#[specta::specta]
pub fn commit_composer(app: AppHandle, text: String) -> Result<(), String> {
    if !should_commit(&text) {
        let _ = cancel_composer(app);
        return Ok(());
    }

    let focus = take_captured_focus();

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
        match crate::clipboard::paste(text, app_paste) {
            Ok(()) => debug!("Composer commit pasted"),
            Err(e) => error!("Composer commit paste failed: {e}"),
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
    use super::should_commit;

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
}
