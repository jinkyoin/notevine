//! Recently opened vaults (SCR-01), stored outside any vault in the app config dir.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::AppResult;

const MAX_RECENT: usize = 10;
/// How long the recent list waits to learn which folders are there.
const EXISTS_LIMIT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentVault {
    pub path: String,
    pub name: String,
    /// ms since epoch
    pub opened_at: u64,
    /// Filled when listing; not stored.
    #[serde(default, skip_deserializing)]
    pub exists: bool,
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

    pub fn list(&self) -> Vec<RecentVault> {
        self.list_with(EXISTS_LIMIT, |path| Path::new(path).is_dir())
    }

    /// Asks about every folder at once and stops waiting at `limit`. A network path that
    /// can't be reached takes about 20 seconds to fail; it counts as missing until then.
    fn list_with(&self, limit: Duration, is_dir: impl Fn(&str) -> bool + Clone + Send + 'static) -> Vec<RecentVault> {
        let mut list = self.load();
        let (tx, rx) = mpsc::channel();
        for (i, v) in list.iter().enumerate() {
            let (tx, path, is_dir) = (tx.clone(), v.path.clone(), is_dir.clone());
            thread::spawn(move || {
                let _ = tx.send((i, is_dir(&path)));
            });
        }
        drop(tx);
        let deadline = Instant::now() + limit;
        while let Ok((i, exists)) = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            list[i].exists = exists;
        }
        list
    }

    pub fn touch(&self, path: &str, name: &str) -> AppResult<()> {
        let mut list = self.load();
        list.retain(|v| !v.path.eq_ignore_ascii_case(path));
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        list.insert(0, RecentVault { path: path.into(), name: name.into(), opened_at: now, exists: true });
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
        assert!(!l[0].exists);
        s.forget("C:\\B").unwrap();
        assert_eq!(s.list().len(), 1);
    }

    #[test]
    fn a_folder_that_never_answers_does_not_hold_up_the_list() {
        let dir = tempfile::tempdir().unwrap();
        let s = RecentStore::new(dir.path());
        s.touch("C:\\here", "here").unwrap();
        s.touch("\\\\offline\\share", "offline").unwrap();
        s.touch("C:\\gone", "gone").unwrap();

        let started = Instant::now();
        let list = s.list_with(Duration::from_millis(200), |path| match path {
            "\\\\offline\\share" => {
                std::thread::sleep(Duration::from_secs(5));
                true
            }
            "C:\\here" => true,
            _ => false,
        });

        assert!(started.elapsed() < Duration::from_secs(2), "took {:?}", started.elapsed());
        let found: Vec<_> = list.iter().map(|v| (v.name.as_str(), v.exists)).collect();
        assert_eq!(found, [("gone", false), ("offline", false), ("here", true)]);
    }
}
