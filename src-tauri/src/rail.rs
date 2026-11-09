//! The note folder rail (FR-VLT-07): folders kept open on the left edge of the window, in
//! order, and the one shown last. Stored per PC in the app config dir, beside the recent list.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::AppResult;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RailEntry {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RailFile {
    pub entries: Vec<RailEntry>,
    pub active: Option<String>,
}

pub struct RailStore {
    file: PathBuf,
}

impl RailStore {
    pub fn new(config_dir: &Path) -> Self {
        Self { file: config_dir.join("vault-rail.json") }
    }

    /// None until anything was saved: a first run after the update, told apart from a rail
    /// the user emptied.
    pub fn load(&self) -> Option<RailFile> {
        fs::read_to_string(&self.file).ok().and_then(|s| serde_json::from_str(&s).ok())
    }

    fn save(&self, f: &RailFile) -> AppResult<()> {
        if let Some(dir) = self.file.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::write(&self.file, serde_json::to_string_pretty(f)?)?;
        Ok(())
    }

    fn change(&self, edit: impl FnOnce(&mut RailFile)) -> AppResult<RailFile> {
        let mut f = self.load().unwrap_or_default();
        edit(&mut f);
        self.save(&f)?;
        Ok(f)
    }

    /// Appends the folder unless it is there already.
    pub fn add(&self, path: &str, name: &str) -> AppResult<RailFile> {
        self.change(|f| {
            if !f.entries.iter().any(|e| e.path.eq_ignore_ascii_case(path)) {
                f.entries.push(RailEntry { path: path.into(), name: name.into() });
            }
        })
    }

    pub fn remove(&self, path: &str) -> AppResult<RailFile> {
        self.change(|f| {
            f.entries.retain(|e| !e.path.eq_ignore_ascii_case(path));
            if f.active.as_deref().is_some_and(|a| a.eq_ignore_ascii_case(path)) {
                f.active = None;
            }
        })
    }

    /// Moves the folder `delta` places down (negative: up), stopping at either end.
    pub fn move_by(&self, path: &str, delta: i32) -> AppResult<RailFile> {
        self.change(|f| {
            let Some(i) = f.entries.iter().position(|e| e.path.eq_ignore_ascii_case(path)) else { return };
            let to = (i as i64 + delta as i64).clamp(0, f.entries.len() as i64 - 1) as usize;
            let e = f.entries.remove(i);
            f.entries.insert(to, e);
        })
    }

    /// Remembers the folder shown, so the app opens it next time. Unknown folders are ignored.
    pub fn set_active(&self, path: &str) -> AppResult<()> {
        let Some(mut f) = self.load() else { return Ok(()) };
        let Some(e) = f.entries.iter().find(|e| e.path.eq_ignore_ascii_case(path)) else { return Ok(()) };
        f.active = Some(e.path.clone());
        self.save(&f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(f: &RailFile) -> Vec<&str> {
        f.entries.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn load_is_none_until_saved_then_empty_list_stays() {
        let d = tempfile::tempdir().unwrap();
        let s = RailStore::new(d.path());
        assert_eq!(s.load(), None);
        s.add("C:\\a", "a").unwrap();
        s.remove("c:\\A").unwrap();
        assert_eq!(s.load(), Some(RailFile::default()));
    }

    #[test]
    fn add_appends_once_ignoring_case() {
        let d = tempfile::tempdir().unwrap();
        let s = RailStore::new(d.path());
        s.add("C:\\a", "a").unwrap();
        s.add("C:\\b", "b").unwrap();
        let f = s.add("c:\\A", "a").unwrap();
        assert_eq!(names(&f), ["a", "b"]);
        assert_eq!(s.load().unwrap(), f);
    }

    #[test]
    fn move_by_clamps_and_keeps_others() {
        let d = tempfile::tempdir().unwrap();
        let s = RailStore::new(d.path());
        for n in ["a", "b", "c"] {
            s.add(&format!("C:\\{n}"), n).unwrap();
        }
        assert_eq!(names(&s.move_by("C:\\c", -1).unwrap()), ["a", "c", "b"]);
        assert_eq!(names(&s.move_by("C:\\a", -5).unwrap()), ["a", "c", "b"]);
        assert_eq!(names(&s.move_by("C:\\a", 9).unwrap()), ["c", "b", "a"]);
        assert_eq!(names(&s.load().unwrap()), ["c", "b", "a"]);
    }

    #[test]
    fn removing_the_active_clears_it_and_set_active_ignores_unknown() {
        let d = tempfile::tempdir().unwrap();
        let s = RailStore::new(d.path());
        s.add("C:\\a", "a").unwrap();
        s.add("C:\\b", "b").unwrap();
        s.set_active("c:\\b").unwrap();
        assert_eq!(s.load().unwrap().active.as_deref(), Some("C:\\b"));
        s.set_active("C:\\z").unwrap();
        assert_eq!(s.load().unwrap().active.as_deref(), Some("C:\\b"));
        let f = s.remove("C:\\B").unwrap();
        assert_eq!(f.active, None);
        assert_eq!(names(&f), ["a"]);
    }
}
