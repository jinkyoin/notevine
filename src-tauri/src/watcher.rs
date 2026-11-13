//! Watches the vault folder for changes made by other programs (FR-VLT-04) and
//! tells the frontend through the `vault-changed` event.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use notify_debouncer_full::notify::{Config, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{DebounceEventResult, Debouncer, NoCache, new_debouncer_opt};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::AppState;
use crate::error::{AppError, AppResult};
use crate::paths::{is_hidden, is_note, to_rel};

/// Short enough that an external save shows up well within 1 second.
const DEBOUNCE: Duration = Duration::from_millis(250);

/// No file-id cache: the default one looks up the id of every file in the folder when the watch
/// starts, which took seconds in a folder of tens of thousands of files, and each switch to
/// that folder waited for it. The cache only helps match a rename's two events, and `handle`
/// works on the changed paths alone (an old path that is gone is a removal, a new one a change).
pub type VaultWatcher = Debouncer<RecommendedWatcher, NoCache>;

#[derive(Debug, Clone, Serialize)]
pub struct VaultChanged {
    /// Vault-relative paths that were added, removed or changed by another program.
    pub changed: Vec<String>,
    /// Notes whose content another program changed.
    pub external: Vec<String>,
}

pub fn start(app: AppHandle, root: PathBuf) -> AppResult<VaultWatcher> {
    let watch_root = root.clone();
    let mut debouncer = new_debouncer_opt::<_, RecommendedWatcher, NoCache>(
        DEBOUNCE,
        None,
        move |res: DebounceEventResult| {
            if let Ok(events) = res {
                let paths: BTreeSet<PathBuf> = events.into_iter().flat_map(|e| e.event.paths).collect();
                handle(&app, &root, paths);
            }
        },
        NoCache,
        Config::default(),
    )
    .map_err(|e| AppError::Io(std::io::Error::other(e)))?;
    debouncer.watch(&watch_root, RecursiveMode::Recursive).map_err(|e| AppError::Io(std::io::Error::other(e)))?;
    Ok(debouncer)
}

fn handle(app: &AppHandle, root: &Path, paths: BTreeSet<PathBuf>) {
    let state = app.state::<AppState>();
    let mut changed = Vec::new();
    let mut external = Vec::new();
    let mut rescan = false;
    {
        let guard = state.vault.lock().expect("vault lock poisoned");
        let Some(vault) = guard.as_ref() else { return };
        if vault.root() != root {
            return; // a vault that has since been closed
        }
        for abs in paths {
            let Some(rel) = to_rel(root, &abs) else {
                continue;
            };
            if rel.is_empty() || rel.split('/').any(is_hidden) {
                continue; // .app/, temp files, .git, ...
            }
            if abs.is_file() {
                if is_note(&rel) && vault.is_online_only(&rel) {
                    let _ = vault.index().upsert_file(root, &rel); // listed, not downloaded
                } else if is_note(&rel) {
                    match vault.on_external_change(&rel) {
                        Ok(true) => external.push(rel.clone()),
                        Ok(false) => continue, // the app's own save
                        Err(_) => {}           // locked or mid-write; the next event retries
                    }
                }
            } else if abs.is_dir() {
                rescan = true; // a folder appeared or was renamed: pick up the notes inside
            } else {
                let _ = vault.on_external_remove(&rel);
            }
            changed.push(rel);
        }
        if rescan {
            let _ = vault.index().scan(root);
        }
    }
    if !changed.is_empty() {
        let _ = app.emit("vault-changed", VaultChanged { changed, external });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::mpsc;
    use std::time::Instant;

    /// `handle` needs only the changed paths, so the watcher can run without the file-id cache:
    /// a save, and both ends of a rename, still arrive as paths.
    #[test]
    fn without_the_cache_a_save_and_a_rename_still_arrive_as_paths() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::channel();
        let mut d = new_debouncer_opt::<_, RecommendedWatcher, NoCache>(
            DEBOUNCE,
            None,
            move |res: DebounceEventResult| {
                if let Ok(events) = res {
                    for p in events.into_iter().flat_map(|e| e.event.paths) {
                        let _ = tx.send(p);
                    }
                }
            },
            NoCache,
            Config::default(),
        )
        .unwrap();
        d.watch(dir.path(), RecursiveMode::Recursive).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        fs::write(dir.path().join("a.md"), "x").unwrap();
        fs::rename(dir.path().join("a.md"), dir.path().join("b.md")).unwrap();
        let mut names = BTreeSet::new();
        let end = Instant::now() + Duration::from_secs(5);
        while Instant::now() < end && !(names.contains("a.md") && names.contains("b.md")) {
            if let Ok(p) = rx.recv_timeout(Duration::from_millis(300)) {
                names.insert(p.file_name().unwrap().to_string_lossy().into_owned());
            }
        }
        assert!(names.contains("a.md"), "the old name of a rename: {names:?}");
        assert!(names.contains("b.md"), "the new name of a rename: {names:?}");
    }
}
