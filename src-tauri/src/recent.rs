//! Recently opened vaults (SCR-01), stored outside any vault in the app config dir.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::AppResult;

const MAX_RECENT: usize = 10;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentVault {
    pub path: String,
    pub name: String,
    /// ms since epoch
    pub opened_at: u64,
}

pub struct RecentStore {
    file: PathBuf,
}

impl RecentStore {
    pub fn new(config_dir: &Path) -> Self {
        Self { file: config_dir.join("recent-vaults.json") }
    }

    fn load(&self) -> Vec<RecentVault> {
        fs::read_to_string(&self.file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }

    fn save(&self, list: &[RecentVault]) -> AppResult<()> {
        if let Some(dir) = self.file.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::write(&self.file, serde_json::to_string_pretty(list)?)?;
        Ok(())
    }

    /// The list as saved. It doesn't touch the folders: one on a network can take over 30
    /// seconds to answer, so a folder is checked only when it is chosen.
    pub fn list(&self) -> Vec<RecentVault> {
        self.load()
    }

    pub fn touch(&self, path: &str, name: &str) -> AppResult<()> {
        let mut list = self.load();
        list.retain(|v| !v.path.eq_ignore_ascii_case(path));
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        list.insert(0, RecentVault { path: path.into(), name: name.into(), opened_at: now });
        list.truncate(MAX_RECENT);
        self.save(&list)
    }

    pub fn forget(&self, path: &str) -> AppResult<()> {
        let mut list = self.load();
        list.retain(|v| !v.path.eq_ignore_ascii_case(path));
        self.save(&list)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn touch_moves_to_front_and_forget_removes() {
        let dir = tempfile::tempdir().unwrap();
        let s = RecentStore::new(dir.path());
        s.touch("C:\\a", "a").unwrap();
        s.touch("C:\\b", "b").unwrap();
        s.touch("c:\\A", "a").unwrap();
        let l = s.list();
        assert_eq!(l.iter().map(|v| v.name.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        s.forget("C:\\B").unwrap();
        assert_eq!(s.list().len(), 1);
    }

    #[test]
    fn reads_a_list_saved_with_the_old_exists_field() {
        let dir = tempfile::tempdir().unwrap();
        let s = RecentStore::new(dir.path());
        fs::write(
            dir.path().join("recent-vaults.json"),
            r#"[{"path":"C:\\a","name":"a","opened_at":1,"exists":true}]"#,
        )
        .unwrap();
        assert_eq!(s.list().len(), 1);
    }
}
