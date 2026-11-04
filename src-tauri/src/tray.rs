//! Tray icon and app-wide settings (FR-PRS-08): with the tray on, closing the window
//! only hides it, so the quick memo shortcut keeps working; the app can also start
//! with Windows straight into the tray.
//!
//! These settings belong to the app, not to a vault, so they live in the app config
//! dir (`app-settings.json`) next to the recent vaults.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt;

use crate::commands::AppState;
use crate::error::{AppError, AppResult};

const TRAY_ID: &str = "main";
/// Passed by the Windows start-up entry: start hidden in the tray.
pub const TRAY_ARG: &str = "--tray";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    /// Keep running in the tray when the window is closed.
    pub tray: bool,
    /// Where Ollama answers on this PC; empty = its default (FR-AI-07).
    pub ollama_url: String,
    /// Look for a new version at start-up. Off until the user turns it on (NFR-SEC-02).
    pub update_check: bool,
    /// Filled when read: whether Windows starts Notevine at sign-in (not stored here).
    #[serde(skip_deserializing)]
    pub autostart: bool,
}

pub struct SettingsStore {
    file: PathBuf,
}

impl SettingsStore {
    pub fn new(config_dir: &Path) -> Self {
        Self { file: config_dir.join("app-settings.json") }
    }

    pub fn load(&self) -> AppSettings {
        fs::read_to_string(&self.file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }

    pub fn save(&self, s: &AppSettings) -> AppResult<()> {
        if let Some(dir) = self.file.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::write(&self.file, serde_json::to_string_pretty(s)?)?;
        Ok(())
    }
}

/// Brings the main window back: from the tray, the taskbar or behind other windows.
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        // Windows may refuse to hand focus to a background window; briefly being
        // topmost brings it to the front.
        let _ = w.set_always_on_top(true);
        let _ = w.set_focus();
        let _ = w.set_always_on_top(false);
    }
}

/// Shows the window and asks it to open the quick memo.
pub fn show_quick_memo(app: &AppHandle) {
    show_main(app);
    let _ = app.emit("quick-memo", ());
}

/// Puts the tray icon up or takes it down.
pub fn apply_tray(app: &AppHandle, on: bool) -> tauri::Result<()> {
    if !on {
        app.remove_tray_by_id(TRAY_ID);
        return Ok(());
    }
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }
    let open = MenuItem::with_id(app, "open", "Notevine 열기", true, None::<&str>)?;
    let memo = MenuItem::with_id(app, "memo", "빠른 메모 (Ctrl+Alt+N)", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &memo, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Notevine")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "open" => show_main(app),
            "memo" => show_quick_memo(app),
            // The window saves the open note, then closes for good (see App.tsx).
            "quit" => {
                let _ = app.emit("app-quit", ());
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

// ---------- commands ----------

#[tauri::command]
pub fn app_settings(app: AppHandle, state: State<AppState>) -> AppSettings {
    let mut s = state.settings.load();
    s.autostart = app.autolaunch().is_enabled().unwrap_or(false);
    s
}

#[tauri::command]
pub fn set_tray(app: AppHandle, state: State<AppState>, on: bool) -> AppResult<()> {
    let mut s = state.settings.load();
    s.tray = on;
    state.settings.save(&s)?;
    apply_tray(&app, on).map_err(|e| AppError::System(e.to_string()))?;
    // Starting with Windows only makes sense into the tray.
    // The start-up entry is the installed app's; a development build leaves it alone.
    if !on && !crate::DEV_BUILD && app.autolaunch().is_enabled().unwrap_or(false) {
        let _ = app.autolaunch().disable();
    }
    Ok(())
}

#[tauri::command]
pub fn set_ollama_url(state: State<AppState>, url: String) -> AppResult<()> {
    let mut s = state.settings.load();
    s.ollama_url = url.trim().to_string();
    state.settings.save(&s)?;
    crate::ai::clear_provider_cache();
    Ok(())
}

#[tauri::command]
pub fn set_update_check(state: State<AppState>, on: bool) -> AppResult<()> {
    let mut s = state.settings.load();
    s.update_check = on;
    state.settings.save(&s)
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, on: bool) -> AppResult<()> {
    if crate::DEV_BUILD {
        return Err(AppError::System("개발용 빌드는 Windows 시작 프로그램에 등록하지 않습니다".into()));
    }
    let auto = app.autolaunch();
    let r = if on { auto.enable() } else { auto.disable() };
    r.map_err(|e| AppError::System(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_default_off_and_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(dir.path());
        assert_eq!(store.load(), AppSettings::default());
        store.save(&AppSettings { tray: true, autostart: true, ..Default::default() }).unwrap();
        let back = store.load();
        assert!(back.tray);
        assert!(!back.autostart, "autostart is read from Windows, not stored");
    }

    #[test]
    fn update_check_stays_off_until_the_user_turns_it_on() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(dir.path());
        assert!(!store.load().update_check, "no network request unless asked (NFR-SEC-02)");
        store.save(&AppSettings { update_check: true, ..Default::default() }).unwrap();
        assert!(store.load().update_check);
    }
}
