//! Vault = a user folder of .md files. The files are the only source of truth
//! (DR-01); everything under `.app/` is app data.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::history::{History, Origin};
use crate::paths::{
    self, check_rel, file_name, is_hidden, is_note, join_rel, name_key, normalize_rel, parent_rel,
    validate_name, APP_DIR,
};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Folder,
    Note,
    File,
}

#[derive(Debug, Clone, Serialize)]
pub struct TreeNode {
    /// Vault-relative path (`/` separators, NFC).
    pub path: String,
    pub name: String,
    pub kind: EntryKind,
    /// Last modified time, ms since epoch.
    pub mtime: u64,
    /// Present only for folders.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeNode>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultInfo {
    pub root: String,
    pub name: String,
}

pub const UNTITLED: &str = "제목 없음";

pub struct Vault {
    root: PathBuf,
    history: History,
}

impl Vault {
    /// Opens an existing folder as a vault and makes sure `.app/` exists.
    pub fn open(root: &Path) -> AppResult<Self> {
        if !root.is_dir() {
            return Err(AppError::NotADirectory(root.display().to_string()));
        }
        let root = root.canonicalize()?;
        let root = strip_verbatim(root);
        fs::create_dir_all(root.join(APP_DIR))?;
        let history = History::open(&root.join(APP_DIR).join("history.db"))?;
        Ok(Self { root, history })
    }

    pub fn info(&self) -> VaultInfo {
        VaultInfo {
            root: self.root.display().to_string(),
            name: self
                .root
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| self.root.display().to_string()),
        }
    }

    /// Absolute path for a vault-relative path, refusing anything outside the vault.
    pub fn abs(&self, rel: &str) -> AppResult<PathBuf> {
        let rel = normalize_rel(rel);
        check_rel(&rel)?;
        if rel.split('/').next() == Some(APP_DIR) {
            return Err(AppError::OutsideVault(rel));
        }
        Ok(if rel.is_empty() {
            self.root.clone()
        } else {
            self.root.join(rel)
        })
    }

    fn existing(&self, rel: &str) -> AppResult<PathBuf> {
        let p = self.abs(rel)?;
        if !p.exists() {
            return Err(AppError::NotFound(rel.to_string()));
        }
        Ok(p)
    }

    /// Whole file tree, hiding `.app/` and every dot-entry (FR-VLT-05).
    /// Folders come first, then entries sorted by case-insensitive name.
    pub fn tree(&self) -> AppResult<Vec<TreeNode>> {
        self.read_dir_rec(&self.root)
    }

    fn read_dir_rec(&self, dir: &Path) -> AppResult<Vec<TreeNode>> {
        let mut out = Vec::new();
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_hidden(&name) {
                continue;
            }
            let path = entry.path();
            let Some(rel) = paths::to_rel(&self.root, &path) else {
                continue;
            };
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue, // vanished or unreadable; skip rather than fail the tree
            };
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let name = file_name(&rel).to_string();
            if meta.is_dir() {
                out.push(TreeNode {
                    children: Some(self.read_dir_rec(&path)?),
                    path: rel,
                    name,
                    kind: EntryKind::Folder,
                    mtime,
                });
            } else {
                let kind = if is_note(&name) { EntryKind::Note } else { EntryKind::File };
                out.push(TreeNode { path: rel, name, kind, mtime, children: None });
            }
        }
        out.sort_by(|a, b| {
            (a.kind != EntryKind::Folder)
                .cmp(&(b.kind != EntryKind::Folder))
                .then_with(|| name_key(&a.name).cmp(&name_key(&b.name)))
        });
        Ok(out)
    }

    pub fn read_note(&self, rel: &str) -> AppResult<String> {
        let p = self.existing(rel)?;
        Ok(fs::read_to_string(p)?)
    }

    /// Writes through a temp file and rename so a crash never leaves a half-written
    /// note (NFR-REL-01).
    pub fn write_note(&self, rel: &str, content: &str) -> AppResult<()> {
        let p = self.abs(rel)?;
        let dir = p.parent().ok_or_else(|| AppError::OutsideVault(rel.to_string()))?;
        fs::create_dir_all(dir)?;
        let tmp = dir.join(format!(".{}.notevine-tmp", file_name(&normalize_rel(rel))));
        fs::write(&tmp, content)?;
        if let Err(e) = fs::rename(&tmp, &p) {
            let _ = fs::remove_file(&tmp);
            return Err(e.into());
        }
        Ok(())
    }

    /// Saves a note from the editor and records a history snapshot (FR-HIS-01·02).
    /// The file write is what matters: if only the snapshot fails, the save still
    /// succeeds and the snapshot error comes back as a warning.
    pub fn save_note(&self, rel: &str, content: &str, force: bool) -> AppResult<Option<String>> {
        let rel = normalize_rel(rel);
        self.write_note(&rel, content)?;
        Ok(self.history.record(&rel, content, Origin::App, force).err().map(|e| e.to_string()))
    }

    pub fn history(&self) -> &History {
        &self.history
    }

    /// True when `dir` already has an entry whose name matches case-insensitively.
    fn sibling_exists(&self, dir_rel: &str, name: &str, except: Option<&str>) -> AppResult<bool> {
        let dir = self.abs(dir_rel)?;
        if !dir.is_dir() {
            return Ok(false);
        }
        let key = name_key(name);
        let except = except.map(name_key);
        for e in fs::read_dir(dir)? {
            let n = name_key(&e?.file_name().to_string_lossy());
            if n == key && Some(&n) != except.as_ref() {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// `base.ext`, `base 1.ext`, `base 2.ext`, ... — first name not taken in `dir`.
    pub fn unique_name(&self, dir_rel: &str, base: &str, ext: &str) -> AppResult<String> {
        let mut n = 0;
        loop {
            let name = if n == 0 { format!("{base}{ext}") } else { format!("{base} {n}{ext}") };
            if !self.sibling_exists(dir_rel, &name, None)? {
                return Ok(name);
            }
            n += 1;
        }
    }

    /// Creates a note in `dir_rel`. Without a name it uses "제목 없음", numbered if taken.
    pub fn create_note(&self, dir_rel: &str, name: Option<&str>, content: &str) -> AppResult<String> {
        let dir_rel = normalize_rel(dir_rel);
        let name = match name {
            Some(n) => {
                let n = with_md(n.trim());
                validate_name(&n)?;
                if self.sibling_exists(&dir_rel, &n, None)? {
                    return Err(AppError::AlreadyExists(join_rel(&dir_rel, &n)));
                }
                n
            }
            None => self.unique_name(&dir_rel, UNTITLED, ".md")?,
        };
        let rel = join_rel(&dir_rel, &name);
        self.save_note(&rel, content, false)?;
        Ok(rel)
    }

    pub fn create_folder(&self, parent_rel: &str, name: &str) -> AppResult<String> {
        let parent_rel = normalize_rel(parent_rel);
        let name = name.trim();
        validate_name(name)?;
        if self.sibling_exists(&parent_rel, name, None)? {
            return Err(AppError::AlreadyExists(join_rel(&parent_rel, name)));
        }
        let rel = join_rel(&parent_rel, name);
        fs::create_dir_all(self.abs(&rel)?)?;
        Ok(rel)
    }

    /// Renames in place. Notes keep the `.md` extension even if the user drops it.
    /// A case-only rename (`a.md` → `A.md`) is allowed.
    pub fn rename(&self, rel: &str, new_name: &str) -> AppResult<String> {
        let rel = normalize_rel(rel);
        let src = self.existing(&rel)?;
        let old_name = file_name(&rel).to_string();
        let new_name = new_name.trim();
        let new_name = if src.is_file() && is_note(&old_name) { with_md(new_name) } else { new_name.to_string() };
        validate_name(&new_name)?;
        let dir = parent_rel(&rel).to_string();
        if self.sibling_exists(&dir, &new_name, Some(&old_name))? {
            return Err(AppError::AlreadyExists(join_rel(&dir, &new_name)));
        }
        let new_rel = join_rel(&dir, &new_name);
        fs::rename(src, self.abs(&new_rel)?)?;
        Ok(new_rel)
    }

    /// Moves a file or folder into another folder (`""` = vault root).
    pub fn move_to(&self, rel: &str, new_parent_rel: &str) -> AppResult<String> {
        let rel = normalize_rel(rel);
        let new_parent_rel = normalize_rel(new_parent_rel);
        let src = self.existing(&rel)?;
        if new_parent_rel == rel || new_parent_rel.starts_with(&format!("{rel}/")) {
            return Err(AppError::InvalidName(new_parent_rel));
        }
        if !self.abs(&new_parent_rel)?.is_dir() {
            return Err(AppError::NotFound(new_parent_rel));
        }
        let name = file_name(&rel).to_string();
        let new_rel = join_rel(&new_parent_rel, &name);
        if new_rel == rel {
            return Ok(rel);
        }
        if self.sibling_exists(&new_parent_rel, &name, None)? {
            return Err(AppError::AlreadyExists(new_rel));
        }
        fs::rename(src, self.abs(&new_rel)?)?;
        Ok(new_rel)
    }

    /// Sends a file or folder to the OS recycle bin.
    pub fn delete(&self, rel: &str) -> AppResult<()> {
        let p = self.existing(rel)?;
        trash::delete(&p).map_err(|e| AppError::Trash(e.to_string()))
    }
}

fn with_md(name: &str) -> String {
    if is_note(name) { name.to_string() } else { format!("{name}.md") }
}

/// `canonicalize` on Windows returns `\\?\C:\...`; strip it for display and joins.
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        (dir, v)
    }

    #[test]
    fn open_creates_app_dir_and_rejects_files() {
        let (dir, _v) = vault();
        assert!(dir.path().join(APP_DIR).is_dir());
        let f = dir.path().join("x.md");
        fs::write(&f, "").unwrap();
        assert!(Vault::open(&f).is_err());
    }

    #[test]
    fn tree_hides_dot_entries_and_sorts_folders_first() {
        let (dir, v) = vault();
        fs::create_dir(dir.path().join("b 폴더")).unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join("a.md"), "").unwrap();
        fs::write(dir.path().join("B.md"), "").unwrap();
        fs::write(dir.path().join("그림.png"), "").unwrap();
        fs::write(dir.path().join("b 폴더/안.md"), "").unwrap();
        let t = v.tree().unwrap();
        let names: Vec<_> = t.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, ["b 폴더", "a.md", "B.md", "그림.png"]);
        assert_eq!(t[0].children.as_ref().unwrap()[0].path, "b 폴더/안.md");
        assert_eq!(t[3].kind, EntryKind::File);
    }

    #[test]
    fn write_and_read_roundtrip_leaves_no_temp_file() {
        let (dir, v) = vault();
        v.write_note("일지/오늘.md", "# 제목\n본문").unwrap();
        assert_eq!(v.read_note("일지/오늘.md").unwrap(), "# 제목\n본문");
        v.write_note("일지/오늘.md", "바뀜").unwrap();
        assert_eq!(v.read_note("일지/오늘.md").unwrap(), "바뀜");
        let left: Vec<_> = fs::read_dir(dir.path().join("일지")).unwrap().collect();
        assert_eq!(left.len(), 1);
    }

    #[test]
    fn refuses_paths_outside_vault_and_app_dir() {
        let (_d, v) = vault();
        assert!(matches!(v.write_note("../out.md", ""), Err(AppError::OutsideVault(_))));
        assert!(matches!(v.write_note(".app/config.json", ""), Err(AppError::OutsideVault(_))));
    }

    #[test]
    fn create_note_numbers_untitled() {
        let (_d, v) = vault();
        assert_eq!(v.create_note("", None, "").unwrap(), "제목 없음.md");
        assert_eq!(v.create_note("", None, "").unwrap(), "제목 없음 1.md");
        assert_eq!(v.create_note("", Some("회의록"), "x").unwrap(), "회의록.md");
        assert!(matches!(v.create_note("", Some("회의록.MD"), ""), Err(AppError::AlreadyExists(_))));
    }

    #[test]
    fn rename_keeps_extension_and_detects_conflicts() {
        let (_d, v) = vault();
        v.create_note("", Some("a"), "").unwrap();
        v.create_note("", Some("b"), "").unwrap();
        assert_eq!(v.rename("a.md", "새 이름").unwrap(), "새 이름.md");
        assert!(matches!(v.rename("b.md", "새 이름"), Err(AppError::AlreadyExists(_))));
        // case-only rename is allowed
        assert_eq!(v.rename("b.md", "B").unwrap(), "B.md");
        assert!(v.read_note("B.md").is_ok());
    }

    #[test]
    fn save_note_records_history() {
        let (_d, v) = vault();
        v.save_note("a.md", "1", false).unwrap();
        v.save_note("a.md", "2", true).unwrap();
        v.save_note("a.md", "3", false).unwrap();
        let versions = v.history().list("a.md").unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(v.history().content(versions[0].id).unwrap(), "3");
        assert_eq!(v.read_note("a.md").unwrap(), "3");
    }

    #[test]
    fn move_into_folder_and_refuse_self_nesting() {
        let (_d, v) = vault();
        v.create_folder("", "f").unwrap();
        v.create_folder("f", "g").unwrap();
        v.create_note("", Some("n"), "").unwrap();
        assert_eq!(v.move_to("n.md", "f/g").unwrap(), "f/g/n.md");
        assert!(v.move_to("f", "f/g").is_err());
        assert_eq!(v.move_to("f/g", "").unwrap(), "g");
    }
}
