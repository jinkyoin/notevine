mod ai;
mod commands;
mod error;
mod extras;
mod history;
mod index;
mod parse;
mod paths;
mod recent;
mod rewrite;
mod search;
mod vault;
mod watcher;
mod workspace;

use std::sync::Mutex;

use tauri::Manager;

use commands::AppState;
use recent::RecentStore;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            app.manage(AppState {
                vault: Mutex::new(None),
                watcher: Mutex::new(None),
                recent: RecentStore::new(&config_dir),
            });
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
            commands::property_values,
            commands::all_tags,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
