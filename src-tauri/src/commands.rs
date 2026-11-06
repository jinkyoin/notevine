//! Tauri commands. The TypeScript side mirrors these in `src/api.ts`;
//! keep names and argument shapes in sync.

use std::path::Path;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::drive::{self, DriveConflict, DriveRoot};
use crate::error::{AppError, AppResult};
use crate::history::VersionMeta;
use crate::index::Index;
use crate::index::NoteRef;
use crate::recent::{RecentStore, RecentVault};
use crate::search::{SearchQuery, SearchResult, TagCount};
use crate::vault::{Backlink, LinkChange, SaveOutcome, TreeNode, Vault, VaultInfo, Workspace};
use crate::watcher::{self, VaultWatcher};

pub struct AppState {
    pub vault: Mutex<Option<Vault>>,
    pub watcher: Mutex<Option<VaultWatcher>>,
    pub recent: RecentStore,
    pub settings: crate::tray::SettingsStore,
    pub trust: crate::trust::TrustStore,
}

pub(crate) fn with_vault<T>(state: &State<AppState>, f: impl FnOnce(&Vault) -> AppResult<T>) -> AppResult<T> {
    let guard = state.vault.lock().expect("vault lock poisoned");
    let v = guard.as_ref().ok_or(AppError::NoVault)?;
    f(v)
}

#[tauri::command]
pub fn open_vault(app: AppHandle, state: State<AppState>, path: String) -> AppResult<VaultInfo> {
    // Close the current vault first: reopening the same vault must not find its
    // database files still held open (Windows refuses to replace them then).
    *state.watcher.lock().expect("watcher lock poisoned") = None;
    *state.vault.lock().expect("vault lock poisoned") = None;
    let local_base = app.path().app_local_data_dir().map_err(|e| AppError::System(e.to_string()))?;
    let v = Vault::open_placed(Path::new(&path), &local_base, &drive::installed())?;
    let info = v.info();
    let root = v.root().to_path_buf();
    let store = v.store_dir();
    // A broken recent list must not block opening the vault.
    let _ = state.recent.touch(&info.root, &info.name);
    *state.vault.lock().expect("vault lock poisoned") = Some(v);
    // Without a watcher the app still works; external edits just show up later.
    *state.watcher.lock().expect("watcher lock poisoned") = watcher::start(app.clone(), root.clone()).ok();

    // Bring the index up to date in the background on its own connection,
    // so a large vault doesn't block the UI (NFR-PRF-01).
    std::thread::spawn(move || {
        let result = Index::open(&store.join("index.db")).and_then(|ix| ix.scan(&root));
        let _ = app.emit("index-ready", result.map(|s| s.indexed + s.unchanged).map_err(|e| e.to_string()));
    });
    Ok(info)
}

/// Drive folders on this PC, for the start screen. Off the main thread: it asks each
/// volume for its name.
#[tauri::command(async)]
pub fn installed_drives() -> Vec<DriveRoot> {
    drive::installed()
}

#[tauri::command]
pub fn drive_conflicts(state: State<AppState>) -> AppResult<Vec<DriveConflict>> {
    with_vault(&state, |v| v.drive_conflicts())
}

#[tauri::command]
pub fn close_vault(state: State<AppState>) {
    *state.watcher.lock().expect("watcher lock poisoned") = None;
    *state.vault.lock().expect("vault lock poisoned") = None;
}

#[tauri::command]
pub fn get_workspace(state: State<AppState>) -> AppResult<Workspace> {
    with_vault(&state, |v| Ok(v.workspace()))
}

#[tauri::command]
pub fn set_workspace(state: State<AppState>, open_path: Option<String>, tabs: Option<Vec<String>>) -> AppResult<()> {
    with_vault(&state, |v| v.set_workspace(&Workspace { open_path, tabs: tabs.unwrap_or_default() }))
}

/// Off the main thread: it waits on folders that may be on a network. A window that stops
/// answering for 5 seconds also loses its taskbar icon until the app restarts.
#[tauri::command(async)]
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

/// Off the main thread, and in a drive vault the download happens without holding the
/// vault: a note that has to come from the network mustn't freeze the window.
#[tauri::command(async)]
pub fn read_note(state: State<AppState>, path: String) -> AppResult<String> {
    let target = with_vault(&state, |v| Ok(v.fetch_target(&path)?.map(|abs| (abs, v.is_online_only(&path)))))?;
    let was_online_only = match target {
        Some((abs, online_only)) => {
            drive::fetch(&abs, &path)?;
            online_only
        }
        None => false,
    };
    with_vault(&state, |v| {
        let content = v.read_note(&path)?;
        if was_online_only {
            // It was only listed by name until now.
            let _ = v.index().upsert_file(v.root(), &crate::paths::normalize_rel(&path));
        }
        Ok(content)
    })
}

/// Saves a note. `force` = manual save or app exit: always lands in a history
/// version. See [`SaveOutcome`] for warnings and conflicts.
#[tauri::command]
pub fn write_note(
    state: State<AppState>,
    path: String,
    content: String,
    force: Option<bool>,
) -> AppResult<SaveOutcome> {
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
pub fn rename_entry(
    state: State<AppState>,
    path: String,
    new_name: String,
    update_links: Option<bool>,
) -> AppResult<String> {
    with_vault(&state, |v| v.rename(&path, &new_name, update_links.unwrap_or(true)))
}

#[tauri::command]
pub fn move_entry(
    state: State<AppState>,
    path: String,
    new_parent: String,
    update_links: Option<bool>,
) -> AppResult<String> {
    with_vault(&state, |v| v.move_to(&path, &new_parent, update_links.unwrap_or(true)))
}

/// Notes whose links a rename would rewrite, before doing it (SCR-15).
#[tauri::command]
pub fn preview_rename(state: State<AppState>, path: String, new_name: String) -> AppResult<Vec<LinkChange>> {
    with_vault(&state, |v| v.preview_relocate(&path, &v.rename_target(&path, &new_name)?))
}

#[tauri::command]
pub fn preview_move(state: State<AppState>, path: String, new_parent: String) -> AppResult<Vec<LinkChange>> {
    with_vault(&state, |v| v.preview_relocate(&path, &v.move_target(&path, &new_parent)?))
}

/// Rebuilds the search index from the files (NFR-REL-03). Returns the note count.
#[tauri::command]
pub fn rebuild_index(state: State<AppState>) -> AppResult<usize> {
    with_vault(&state, |v| {
        v.index().clear()?;
        let s = v.index().scan(v.root())?;
        Ok(s.indexed + s.unchanged)
    })
}

#[tauri::command]
pub fn list_notes(state: State<AppState>) -> AppResult<Vec<NoteRef>> {
    with_vault(&state, |v| v.index().notes())
}

/// Note a `[[target]]` opens, or null when no such note exists yet.
#[tauri::command]
pub fn resolve_link(state: State<AppState>, target: String) -> AppResult<Option<String>> {
    with_vault(&state, |v| v.index().resolve(&target))
}

#[tauri::command]
pub fn backlinks(state: State<AppState>, path: String) -> AppResult<Vec<Backlink>> {
    with_vault(&state, |v| v.backlinks(&path))
}

#[tauri::command]
pub fn delete_entry(state: State<AppState>, path: String) -> AppResult<()> {
    with_vault(&state, |v| v.delete(&path))
}

#[tauri::command]
pub fn reveal_entry(state: State<AppState>, path: String) -> AppResult<String> {
    with_vault(&state, |v| Ok(v.abs(&path)?.display().to_string()))
}

/// Full-text search with tag/property/date filters (FR-SRC-02..05).
#[tauri::command]
pub fn search(state: State<AppState>, query: SearchQuery) -> AppResult<SearchResult> {
    with_vault(&state, |v| crate::search::search(v.index(), &query))
}

/// Distinct frontmatter property keys, for the filter UI.
#[tauri::command]
pub fn property_keys(state: State<AppState>) -> AppResult<Vec<String>> {
    with_vault(&state, |v| crate::search::property_keys(v.index()))
}

/// Notes of a folder with their properties, for the table view (FR-PRP-05).
#[tauri::command]
pub fn folder_table(state: State<AppState>, folder: String) -> AppResult<crate::search::FolderTable> {
    with_vault(&state, |v| crate::search::folder_table(v.index(), &folder))
}

/// Tags of one note, shown under it.
#[tauri::command]
pub fn note_tags(state: State<AppState>, path: String) -> AppResult<Vec<String>> {
    with_vault(&state, |v| crate::search::note_tags(v.index(), &path))
}

/// Notes of a folder and the links between them, for the graph view (FR-UI-05).
#[tauri::command]
pub fn link_graph(state: State<AppState>, folder: String) -> AppResult<crate::search::LinkGraph> {
    with_vault(&state, |v| crate::search::link_graph(v.index(), &folder))
}

/// Most frequent values of a property (key compared case-insensitively), max 50.
#[tauri::command]
pub fn property_values(state: State<AppState>, key: String) -> AppResult<Vec<String>> {
    with_vault(&state, |v| crate::search::property_values(v.index(), &key))
}

/// Every tag with its note count, most frequent first.
#[tauri::command]
pub fn all_tags(state: State<AppState>) -> AppResult<Vec<TagCount>> {
    with_vault(&state, |v| crate::search::all_tags(v.index()))
}
