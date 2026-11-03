mod ai;
mod ai_api;
mod canvas;
mod commands;
mod error;
mod extras;
mod history;
mod index;
mod parse;
mod paths;
mod plugins;
mod recent;
mod rewrite;
mod search;
mod tray;
mod vault;
mod watcher;
mod web;
mod workspace;

use std::sync::Mutex;

use tauri::Manager;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use commands::AppState;
use recent::RecentStore;

/// Quick memo from anywhere while Notevine runs, even behind other windows (FR-PRS-08).
/// Inside the app the shortcut stays Ctrl+Shift+N.
const QUICK_MEMO_KEY: &str = "CommandOrControl+Alt+N";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // First: a second launch (e.g. while hidden in the tray) shows this window instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| tray::show_main(app)))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![tray::TRAY_ARG]),
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
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
            let config_dir = app.path().app_config_dir()?;
            let settings = tray::SettingsStore::new(&config_dir);
            let tray_on = settings.load().tray;
            app.manage(AppState {
                vault: Mutex::new(None),
                watcher: Mutex::new(None),
                recent: RecentStore::new(&config_dir),
                settings,
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
            commands::forget_vault,
            commands::list_tree,
            commands::read_note,
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
            ai_api::ai_set_key,
            ai_api::ai_models,
            web::fetch_page,
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
            extras::cmd::restore_version,
            extras::cmd::version_diff,
            extras::cmd::deleted_notes,
            extras::cmd::import_attachment,
            extras::cmd::save_attachment,
            extras::cmd::resolve_attachment,
            extras::cmd::attachment_path,
            ai::ai_providers,
            ai::ai_context,
            ai::ai_run,
            ai::ai_cancel,
            ai::ai_login,
            ai::ai_private_notes,
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
