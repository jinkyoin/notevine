//! Tauri commands. The TypeScript side mirrors these in `src/api.ts`;
//! keep names and argument shapes in sync.

use std::path::Path;
use std::sync::Mutex;

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::history::VersionMeta;
use crate::recent::{RecentStore, RecentVault};
use crate::vault::{TreeNode, Vault, VaultInfo};

pub struct AppState {
    pub vault: Mutex<Option<Vault>>,
    pub recent: RecentStore,
}

fn with_vault<T>(state: &State<AppState>, f: impl FnOnce(&Vault) -> AppResult<T>) -> AppResult<T> {
    let guard = state.vault.lock().expect("vault lock poisoned");
    let v = guard.as_ref().ok_or(AppError::NoVault)?;
    f(v)
}

#[tauri::command]
pub fn open_vault(state: State<AppState>, path: String) -> AppResult<VaultInfo> {
    let v = Vault::open(Path::new(&path))?;
    let info = v.info();
    // A broken recent list must not block opening the vault.
    let _ = state.recent.touch(&info.root, &info.name);
    *state.vault.lock().expect("vault lock poisoned") = Some(v);
    Ok(info)
}

#[tauri::command]
pub fn close_vault(state: State<AppState>) {
    *state.vault.lock().expect("vault lock poisoned") = None;
}

#[tauri::command]
pub fn recent_vaults(state: State<AppState>) -> Vec<RecentVault> {
    state.recent.list()
}

#[tauri::command]
pub fn forget_vault(state: State<AppState>, path: String) -> AppResult<()> {
    state.recent.forget(&path)
}

#[tauri::command]
pub fn list_tree(state: State<AppState>) -> AppResult<Vec<TreeNode>> {
    with_vault(&state, |v| v.tree())
}

#[tauri::command]
pub fn read_note(state: State<AppState>, path: String) -> AppResult<String> {
    with_vault(&state, |v| v.read_note(&path))
}

/// Saves a note. `force` = manual save or app exit: always lands in a history
/// version. Returns a warning when only the history snapshot failed.
#[tauri::command]
pub fn write_note(state: State<AppState>, path: String, content: String, force: Option<bool>) -> AppResult<Option<String>> {
    with_vault(&state, |v| v.save_note(&path, &content, force.unwrap_or(false)))
}

#[tauri::command]
pub fn list_versions(state: State<AppState>, path: String) -> AppResult<Vec<VersionMeta>> {
    with_vault(&state, |v| v.history().list(&crate::paths::normalize_rel(&path)))
}

#[tauri::command]
pub fn version_content(state: State<AppState>, id: i64) -> AppResult<String> {
    with_vault(&state, |v| v.history().content(id))
}

#[tauri::command]
pub fn create_note(
    state: State<AppState>,
    dir: String,
    name: Option<String>,
    content: Option<String>,
) -> AppResult<String> {
    with_vault(&state, |v| v.create_note(&dir, name.as_deref(), content.as_deref().unwrap_or("")))
}

#[tauri::command]
pub fn create_folder(state: State<AppState>, parent: String, name: String) -> AppResult<String> {
    with_vault(&state, |v| v.create_folder(&parent, &name))
}

#[tauri::command]
pub fn rename_entry(state: State<AppState>, path: String, new_name: String) -> AppResult<String> {
    with_vault(&state, |v| v.rename(&path, &new_name))
}

#[tauri::command]
pub fn move_entry(state: State<AppState>, path: String, new_parent: String) -> AppResult<String> {
    with_vault(&state, |v| v.move_to(&path, &new_parent))
}

#[tauri::command]
pub fn delete_entry(state: State<AppState>, path: String) -> AppResult<()> {
    with_vault(&state, |v| v.delete(&path))
}

#[tauri::command]
pub fn reveal_entry(state: State<AppState>, path: String) -> AppResult<String> {
    with_vault(&state, |v| Ok(v.abs(&path)?.display().to_string()))
}
