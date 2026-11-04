//! What this PC's user has allowed each vault to do. A vault's own files travel with
//! it (a folder received from someone, a Git pull), so nothing in them may decide
//! what runs here: running Git in its `.git`, its plugins, its CSS, the backup timer.
//! Those choices live outside the vault, in the app config dir (`vault-trust.json`).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::{AppState, with_vault};
use crate::error::{AppError, AppResult};

/// The intervals the settings screen offers; 0 = only by hand.
pub const BACKUP_MINUTES: [u32; 5] = [0, 15, 30, 60, 180];

/// Permissions granted to one plugin, for the exact code the user turned on.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PluginGrant {
    pub permissions: Vec<String>,
    pub hash: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct VaultTrust {
    /// Git may run in the vault's existing `.git`.
    pub git: bool,
    pub backup_minutes: u32,
    pub custom_css: bool,
    pub plugins: BTreeMap<String, PluginGrant>,
}

pub struct TrustStore {
    file: PathBuf,
    /// Read-change-write of the file is one step.
    lock: Mutex<()>,
}

/// One entry per folder however its path is capitalized (Windows paths ignore case).
fn key(root: &Path) -> String {
    root.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase()
}

impl TrustStore {
    pub fn new(config_dir: &Path) -> Self {
        Self { file: config_dir.join("vault-trust.json"), lock: Mutex::new(()) }
    }

    fn read_all(&self) -> BTreeMap<String, VaultTrust> {
        fs::read_to_string(&self.file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }

    /// An unknown vault is allowed nothing.
    pub fn get(&self, root: &Path) -> VaultTrust {
        let _guard = self.lock.lock().expect("trust lock poisoned");
        self.read_all().remove(&key(root)).unwrap_or_default()
    }

    pub fn update(&self, root: &Path, f: impl FnOnce(&mut VaultTrust)) -> AppResult<VaultTrust> {
        let _guard = self.lock.lock().expect("trust lock poisoned");
        let mut all = self.read_all();
        let entry = all.entry(key(root)).or_default();
        f(entry);
        let out = entry.clone();
        if let Some(dir) = self.file.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::write(&self.file, serde_json::to_string_pretty(&all)?)?;
        Ok(out)
    }

    pub fn set_backup_minutes(&self, root: &Path, minutes: u32) -> AppResult<VaultTrust> {
        if !BACKUP_MINUTES.contains(&minutes) {
            return Err(AppError::System(format!("자동 백업 간격이 올바르지 않습니다: {minutes}")));
        }
        self.update(root, |t| t.backup_minutes = minutes)
    }
}

/// What the page needs to know; plugin grants come with `list_plugins`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct DeviceTrust {
    pub git: bool,
    pub backup_minutes: u32,
    pub custom_css: bool,
}

impl From<VaultTrust> for DeviceTrust {
    fn from(t: VaultTrust) -> Self {
        Self { git: t.git, backup_minutes: t.backup_minutes, custom_css: t.custom_css }
    }
}

pub(crate) fn vault_root(state: &State<AppState>) -> AppResult<PathBuf> {
    with_vault(state, |v| Ok(v.root().to_path_buf()))
}

#[tauri::command]
pub fn device_trust(state: State<AppState>) -> AppResult<DeviceTrust> {
    Ok(state.trust.get(&vault_root(&state)?).into())
}

#[tauri::command]
pub fn set_backup_minutes(state: State<AppState>, minutes: u32) -> AppResult<DeviceTrust> {
    Ok(state.trust.set_backup_minutes(&vault_root(&state)?, minutes)?.into())
}

#[tauri::command]
pub fn set_custom_css(state: State<AppState>, on: bool) -> AppResult<DeviceTrust> {
    Ok(state.trust.update(&vault_root(&state)?, |t| t.custom_css = on)?.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unknown_vault_is_allowed_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = TrustStore::new(dir.path());
        assert_eq!(store.get(Path::new("D:/받은 폴더")), VaultTrust::default());
    }

    #[test]
    fn choices_are_kept_per_vault_whatever_the_capitalization() {
        let dir = tempfile::tempdir().unwrap();
        let store = TrustStore::new(dir.path());
        store.update(Path::new(r"D:\Notes"), |t| t.git = true).unwrap();
        let again = TrustStore::new(dir.path());
        assert!(again.get(Path::new("d:/notes/")).git);
        assert!(!again.get(Path::new(r"D:\Other")).git);
    }

    #[test]
    fn backup_interval_must_be_one_the_screen_offers() {
        let dir = tempfile::tempdir().unwrap();
        let store = TrustStore::new(dir.path());
        let root = Path::new("D:/n");
        assert!(store.set_backup_minutes(root, 1).is_err());
        assert_eq!(store.set_backup_minutes(root, 30).unwrap().backup_minutes, 30);
        assert_eq!(store.get(root).backup_minutes, 30);
    }
}
