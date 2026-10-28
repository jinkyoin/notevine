mod commands;
mod error;
mod paths;
mod recent;
mod vault;

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
            app.manage(AppState { vault: Mutex::new(None), recent: RecentStore::new(&config_dir) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_vault,
            commands::close_vault,
            commands::recent_vaults,
            commands::forget_vault,
            commands::list_tree,
            commands::read_note,
            commands::write_note,
            commands::create_note,
            commands::create_folder,
            commands::rename_entry,
            commands::move_entry,
            commands::delete_entry,
            commands::reveal_entry,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
