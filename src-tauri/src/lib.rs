mod ai;
mod ai_api;
mod backup;
mod canvas;
mod commands;
pub mod crypt;
pub mod crypt_key;
mod drive;
mod error;
mod extras;
mod file_open;
mod filetext;
mod history;
mod index;
mod mcp;
mod parse;
mod paths;
mod plugins;
mod rail;
mod recent;
mod rewrite;
mod search;
mod tray;
mod trust;
mod vault;
mod watcher;
mod web;
mod workspace;

use std::sync::Mutex;

use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use commands::AppState;
use recent::RecentStore;

/// Quick memo from anywhere while Notevine runs, even behind other windows (FR-PRS-08).
/// Inside the app the shortcut stays Ctrl+Shift+N.
const QUICK_MEMO_KEY: &str = "CommandOrControl+Alt+N";

/// A development build keeps its own settings, web storage and saved keys, so trying
/// things in it never touches the installed app's recent folders or preferences.
pub const DEV_BUILD: bool = cfg!(debug_assertions);

/// The app's settings folder; a development build uses `<identifier>.dev` beside it.
fn config_dir(app: &tauri::App) -> tauri::Result<std::path::PathBuf> {
    let dir = app.path().app_config_dir()?;
    Ok(if DEV_BUILD {
        let name = format!("{}.dev", dir.file_name().unwrap_or_default().to_string_lossy());
        dir.with_file_name(name)
    } else {
        dir
    })
}

/// The app window shows the app and nothing else: a page reached from a note would
/// look like the app, with no address bar to tell them apart.
fn allowed_navigation(url: &tauri::Url, dev: bool) -> bool {
    match (url.scheme(), url.host_str()) {
        ("about", _) => true, // plugin frames (about:srcdoc)
        ("http" | "https", Some("tauri.localhost")) => true,
        ("tauri", Some("localhost")) => true,
        ("http", Some("localhost")) => dev && url.port() == Some(1420),
        _ => false,
    }
}

/// `notevine --mcp`: the MCP server for AI tools on this PC, without any window.
/// `main` must check this before [`run`]: the single-instance plugin there would
/// hand the arguments to a running app and exit.
pub fn mcp_requested(args: &[String]) -> bool {
    args.iter().skip(1).any(|a| a == "--mcp")
}

/// Runs the MCP server until the AI tool closes it; returns the exit code.
pub fn run_mcp(args: &[String]) -> i32 {
    mcp::serve(args)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before any window exists: a development build gets its own WebView2 profile
    // (localStorage holds the AI choices) unless a test already chose one.
    #[cfg(windows)]
    if DEV_BUILD
        && std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_none()
        && let Some(local) = std::env::var_os("LOCALAPPDATA")
    {
        let dir = std::path::Path::new(&local).join("net.notevine.app.dev").join("EBWebView");
        // SAFETY: first thing in main, before any other thread is started.
        unsafe { std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", dir) };
    }
    tauri::Builder::default()
        // First: a second launch (e.g. while hidden in the tray) shows this window instead.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if let Some(file) = file_open::from_args(args, std::path::Path::new(&cwd))
                && let Some(state) = app.try_state::<AppState>()
            {
                *state.opened_file.lock().expect("opened file lock poisoned") = Some(file.display().to_string());
                let _ = app.emit("open-file", ());
            }
            tray::show_main(app)
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![tray::TRAY_ARG]),
        ))
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("stay-in-app")
                .on_navigation(|_webview, url| allowed_navigation(url, DEV_BUILD))
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        tray::show_quick_memo(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            // Another program may own the key already: the app still starts, without it.
            if let Err(e) = app.global_shortcut().register(QUICK_MEMO_KEY) {
                eprintln!("quick memo shortcut {QUICK_MEMO_KEY} not registered: {e}");
            }
            let config_dir = config_dir(app)?;
            let settings = tray::SettingsStore::new(&config_dir);
            let tray_on = settings.load().tray;
            let cwd = std::env::current_dir().unwrap_or_default();
            let opened_file = file_open::from_args(std::env::args(), &cwd).map(|f| f.display().to_string());
            app.manage(AppState {
                started_with_file: opened_file.is_some(),
                opened_file: Mutex::new(opened_file),
                vault: Mutex::new(None),
                watcher: Mutex::new(None),
                recent: RecentStore::new(&config_dir),
                rail: rail::RailStore::new(&config_dir),
                settings,
                trust: trust::TrustStore::new(&config_dir),
                opening: Mutex::new(()),
            });
            if tray_on && let Err(e) = tray::apply_tray(app.handle(), true) {
                eprintln!("tray icon not shown: {e}");
            }
            // The window starts hidden (tauri.conf.json); started by Windows at
            // sign-in it stays in the tray, otherwise it shows now.
            let to_tray = tray_on && std::env::args().any(|a| a == tray::TRAY_ARG);
            if !to_tray && let Some(w) = app.get_webview_window("main") {
                w.show()?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_vault,
            commands::close_vault,
            commands::get_workspace,
            commands::set_workspace,
            commands::recent_vaults,
            commands::folder_exists,
            commands::take_opened_file,
            commands::started_with_file,
            commands::locate_note_file,
            commands::forget_vault,
            commands::rail_list,
            commands::rail_add,
            commands::rail_remove,
            commands::rail_move,
            commands::rail_set_active,
            commands::list_tree,
            commands::read_note,
            commands::installed_drives,
            commands::drive_conflicts,
            commands::write_note,
            commands::list_versions,
            commands::version_content,
            commands::create_note,
            commands::create_folder,
            commands::rename_entry,
            commands::move_entry,
            commands::preview_rename,
            commands::preview_move,
            commands::list_notes,
            commands::rebuild_index,
            workspace::get_config,
            workspace::set_config,
            workspace::history_stats,
            workspace::prune_history,
            workspace::custom_css,
            tray::app_settings,
            tray::set_tray,
            tray::set_autostart,
            tray::set_ollama_url,
            tray::set_update_check,
            ai_api::ai_set_key,
            ai_api::ai_models,
            web::fetch_page,
            backup::backup_status,
            backup::backup_trust,
            backup::backup_init,
            trust::device_trust,
            trust::set_backup_minutes,
            trust::set_custom_css,
            plugins::set_plugin_grant,
            backup::backup_set_remote,
            backup::backup_now,
            canvas::create_canvas,
            canvas::save_canvas,
            plugins::list_plugins,
            plugins::plugin_source,
            plugins::plugins_folder,
            plugins::create_sample_plugin,
            workspace::apply_preset,
            workspace::list_templates,
            workspace::create_from_template,
            workspace::render_template_text,
            workspace::open_today_journal,
            workspace::open_journal_on,
            workspace::quick_memo,
            workspace::create_project,
            workspace::ideas,
            workspace::tasks,
            extras::cmd::restore_version,
            extras::cmd::version_diff,
            extras::cmd::deleted_notes,
            extras::cmd::import_attachment,
            extras::cmd::save_attachment,
            extras::cmd::save_web_image,
            extras::cmd::resolve_attachment,
            extras::cmd::attachment_path,
            ai::ai_providers,
            ai::ai_context,
            ai::ai_run,
            ai::ai_cancel,
            ai::ai_login,
            ai::ai_private_notes,
            mcp::cmd::mcp_status,
            mcp::cmd::set_mcp,
            filetext::ai_file_text,
            commands::resolve_link,
            commands::backlinks,
            commands::delete_entry,
            commands::reveal_entry,
            commands::search,
            commands::property_keys,
            commands::folder_table,
            commands::link_graph,
            commands::note_tags,
            commands::property_values,
            commands::all_tags,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(url: &str, dev: bool) -> bool {
        allowed_navigation(&url.parse().unwrap(), dev)
    }

    #[test]
    fn the_app_window_stays_on_the_app() {
        assert!(allowed("http://tauri.localhost/index.html", false));
        assert!(allowed("about:srcdoc", false));
        assert!(allowed("http://localhost:1420/", true));
    }

    #[test]
    fn the_app_window_does_not_go_elsewhere() {
        assert!(!allowed("https://evil.example/x", false));
        assert!(!allowed("https://tauri.localhost.evil.example/", false));
        assert!(!allowed("http://localhost:1420/", false), "the dev server is for development");
        assert!(!allowed("http://localhost:8080/", true));
        assert!(!allowed("file:///C:/x.html", false));
    }
}
