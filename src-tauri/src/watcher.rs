//! Watches the vault folder for changes made by other programs (FR-VLT-04) and
//! tells the frontend through the `vault-changed` event.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{DebounceEventResult, Debouncer, RecommendedCache, new_debouncer};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::AppState;
use crate::error::{AppError, AppResult};
use crate::paths::{is_hidden, is_note, to_rel};

/// Short enough that an external save shows up well within 1 second.
const DEBOUNCE: Duration = Duration::from_millis(250);

pub type VaultWatcher = Debouncer<RecommendedWatcher, RecommendedCache>;

#[derive(Debug, Clone, Serialize)]
pub struct VaultChanged {
    /// Vault-relative paths that were added, removed or changed by another program.
    pub changed: Vec<String>,
    /// Notes whose content another program changed.
    pub external: Vec<String>,
}

pub fn start(app: AppHandle, root: PathBuf) -> AppResult<VaultWatcher> {
    let watch_root = root.clone();
    let mut debouncer = new_debouncer(DEBOUNCE, None, move |res: DebounceEventResult| {
        if let Ok(events) = res {
            let paths: BTreeSet<PathBuf> = events.into_iter().flat_map(|e| e.event.paths).collect();
            handle(&app, &root, paths);
        }
    })
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
                if is_note(&rel) {
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
