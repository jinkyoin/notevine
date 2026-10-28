//! Vault = a user folder of .md files. The files are the only source of truth
//! (DR-01); everything under `.app/` is app data.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::history::{History, Origin};
use crate::index::{Index, LinkRef};
use crate::rewrite::{rebase_own_links, rewrite_links, Move};
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

#[derive(Debug, Clone, Default, Serialize, serde::Deserialize)]
pub struct Workspace {
    pub open_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultInfo {
    pub root: String,
    pub name: String,
}

pub const UNTITLED: &str = "제목 없음";

/// Result of saving from the editor.
#[derive(Debug, Clone, Default, Serialize)]
pub struct SaveOutcome {
    /// The note was saved but its history snapshot or index update failed.
    pub warning: Option<String>,
    /// Another program changed the file since the editor loaded it. The disk
    /// version was kept and the editor's text went to this new file (NFR-REL-02).
    pub conflict: Option<String>,
}

/// A note whose links a rename/move would rewrite (SCR-15).
#[derive(Debug, Clone, Serialize)]
pub struct LinkChange {
    /// Path of the note after the move.
    pub path: String,
    pub title: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct Backlink {
    pub path: String,
    pub title: String,
    pub line: u32,
    /// The linking line, trimmed.
    pub context: String,
}

pub struct Vault {
    root: PathBuf,
    history: History,
    index: Index,
    /// Content hash of each note as the app last read or wrote it. A different
    /// hash on disk means someone else changed the file.
    known: Mutex<HashMap<String, String>>,
}

pub fn content_hash(content: &str) -> String {
    blake3::hash(content.as_bytes()).to_hex().to_string()
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
        let index = Index::open(&root.join(APP_DIR).join("index.db"))?;
        Ok(Self { root, history, index, known: Mutex::new(HashMap::new()) })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Note open when the vault was last used (FR-VLT-02), from `.app/workspace.json`.
    pub fn workspace(&self) -> Workspace {
        fs::read_to_string(self.root.join(APP_DIR).join("workspace.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn set_workspace(&self, ws: &Workspace) -> AppResult<()> {
        fs::write(self.root.join(APP_DIR).join("workspace.json"), serde_json::to_string_pretty(ws)?)?;
        Ok(())
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
        let content = fs::read_to_string(p)?;
        self.known().insert(normalize_rel(rel), content_hash(&content));
        Ok(content)
    }

    fn known(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.known.lock().expect("known-hash lock poisoned")
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
    pub fn save_note(&self, rel: &str, content: &str, force: bool) -> AppResult<SaveOutcome> {
        let rel = normalize_rel(rel);
        let abs = self.abs(&rel)?;
        let expected = self.known().get(&rel).cloned();
        if let Some(expected) = expected
            && abs.is_file()
            && content_hash(&fs::read_to_string(&abs)?) != expected
        {
            let conflict = self.conflict_copy(&rel, content)?;
            return Ok(SaveOutcome { warning: None, conflict: Some(conflict) });
        }
        self.write_note(&rel, content)?;
        self.known().insert(rel.clone(), content_hash(content));
        let mut warnings = Vec::new();
        if let Err(e) = self.history.record(&rel, content, Origin::App, force) {
            warnings.push(e.to_string());
        }
        if let Err(e) = self.index.upsert_file(&self.root, &rel) {
            warnings.push(format!("검색 인덱스: {e}"));
        }
        Ok(SaveOutcome { warning: (!warnings.is_empty()).then(|| warnings.join("; ")), conflict: None })
    }

    /// Writes `content` next to `rel` as "이름 (충돌 2026-10-28 1432).md".
    fn conflict_copy(&self, rel: &str, content: &str) -> AppResult<String> {
        let dir = parent_rel(rel).to_string();
        let name = file_name(rel);
        let stem = if is_note(name) { &name[..name.len() - 3] } else { name };
        let stamp = chrono::Local::now().format("%Y-%m-%d %H%M");
        let new_name = self.unique_name(&dir, &format!("{stem} (충돌 {stamp})"), ".md")?;
        let conflict = join_rel(&dir, &new_name);
        self.save_note(&conflict, content, true)?;
        Ok(conflict)
    }

    /// Handles a note changed on disk by another program (FR-VLT-04, FR-HIS-03).
    /// Returns false when the change is the app's own save.
    pub fn on_external_change(&self, rel: &str) -> AppResult<bool> {
        let rel = normalize_rel(rel);
        let content = fs::read_to_string(self.abs(&rel)?)?;
        if self.known().get(&rel) == Some(&content_hash(&content)) {
            return Ok(false);
        }
        self.history.record(&rel, &content, Origin::External, false)?;
        self.index.upsert_file(&self.root, &rel)?;
        Ok(true)
    }

    /// Handles a note or folder removed by another program.
    pub fn on_external_remove(&self, rel: &str) -> AppResult<()> {
        let rel = normalize_rel(rel);
        self.forget_known(&rel);
        self.index.remove(&rel)
    }

    fn forget_known(&self, rel: &str) {
        let prefix = format!("{rel}/");
        self.known().retain(|k, _| k != rel && !k.starts_with(&prefix));
    }

    /// Keeps history, index and known hashes attached to a moved note or folder (FR-HIS-07).
    fn after_move(&self, from: &str, to: &str) -> AppResult<()> {
        {
            let mut known = self.known();
            let prefix = format!("{from}/");
            let moved: Vec<_> = known.keys().filter(|k| *k == from || k.starts_with(&prefix)).cloned().collect();
            for k in moved {
                if let Some(h) = known.remove(&k) {
                    known.insert(format!("{to}{}", &k[from.len()..]), h);
                }
            }
        }
        self.history.rename_path(from, to)?;
        self.index.rename(from, to)?;
        // Re-read moved notes: their relative markdown links now resolve from a new
        // folder, and a file renamed to .md only now becomes a note.
        if self.abs(to)?.is_dir() {
            for rel in self.index.notes_under(to)? {
                self.index.upsert_file(&self.root, &rel)?;
            }
        } else if is_note(to) {
            self.index.upsert_file(&self.root, to)?;
        }
        Ok(())
    }

    pub fn history(&self) -> &History {
        &self.history
    }

    pub fn index(&self) -> &Index {
        &self.index
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

    /// Where a rename would put `rel`. Notes keep the `.md` extension even if the
    /// user drops it; a case-only rename (`a.md` → `A.md`) is allowed.
    pub fn rename_target(&self, rel: &str, new_name: &str) -> AppResult<String> {
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
        Ok(join_rel(&dir, &new_name))
    }

    /// Where moving `rel` into folder `new_parent_rel` (`""` = vault root) would put it.
    pub fn move_target(&self, rel: &str, new_parent_rel: &str) -> AppResult<String> {
        let rel = normalize_rel(rel);
        let new_parent_rel = normalize_rel(new_parent_rel);
        self.existing(&rel)?;
        if new_parent_rel == rel || new_parent_rel.starts_with(&format!("{rel}/")) {
            return Err(AppError::InvalidName(new_parent_rel));
        }
        if !self.abs(&new_parent_rel)?.is_dir() {
            return Err(AppError::NotFound(new_parent_rel));
        }
        let name = file_name(&rel).to_string();
        let new_rel = join_rel(&new_parent_rel, &name);
        if new_rel != rel && self.sibling_exists(&new_parent_rel, &name, None)? {
            return Err(AppError::AlreadyExists(new_rel));
        }
        Ok(new_rel)
    }

    pub fn rename(&self, rel: &str, new_name: &str, update_links: bool) -> AppResult<String> {
        let to = self.rename_target(rel, new_name)?;
        self.relocate(&normalize_rel(rel), &to, update_links)
    }

    pub fn move_to(&self, rel: &str, new_parent_rel: &str, update_links: bool) -> AppResult<String> {
        let to = self.move_target(rel, new_parent_rel)?;
        self.relocate(&normalize_rel(rel), &to, update_links)
    }

    /// Notes whose links moving `from` to `to` would change, with their new text.
    /// Paths are where those notes live after the move.
    fn plan_link_updates(&self, from: &str, to: &str) -> AppResult<Vec<(String, String, usize)>> {
        let mv = Move { from, to };
        let name_unique = is_note(from) && self.index.name_count(&title_of(from))? == 1;
        let moved = self.index.notes_under(from)?;
        let mut sources = self.index.referrers(from)?;
        sources.extend(moved.iter().cloned());
        sources.sort();
        sources.dedup();
        let mut plan = Vec::new();
        for src in sources {
            let Ok(content) = fs::read_to_string(self.abs(&src)?) else { continue };
            let (text, count) = if moved.contains(&src) {
                // Re-base its own relative links first, then fix links to other moved notes.
                let new_src = format!("{to}{}", &src[from.len()..]);
                let (a, n1) = rebase_own_links(&content, &src, &new_src, &mv);
                let (b, n2) = rewrite_links(&a, &new_src, &mv, name_unique);
                (b, n1 + n2)
            } else {
                rewrite_links(&content, &src, &mv, name_unique)
            };
            if count > 0 {
                let after = if moved.contains(&src) { format!("{to}{}", &src[from.len()..]) } else { src };
                plan.push((after, text, count));
            }
        }
        Ok(plan)
    }

    /// What a rename/move would change in other notes (SCR-15). Nothing is written.
    pub fn preview_relocate(&self, from: &str, to: &str) -> AppResult<Vec<LinkChange>> {
        Ok(self
            .plan_link_updates(&normalize_rel(from), &normalize_rel(to))?
            .into_iter()
            .map(|(path, _, count)| LinkChange { title: title_of(&path), path, count })
            .collect())
    }

    /// Renames/moves `from` to `to` and, when asked, rewrites links that point at it (FR-LNK-05).
    fn relocate(&self, from: &str, to: &str, update_links: bool) -> AppResult<String> {
        if from == to {
            return Ok(to.to_string());
        }
        let plan = if update_links { self.plan_link_updates(from, to)? } else { Vec::new() };
        fs::rename(self.abs(from)?, self.abs(to)?)?;
        self.after_move(from, to)?;
        for (path, text, _) in plan {
            self.write_tracked(&path, &text)?;
        }
        Ok(to.to_string())
    }

    /// Writes a note on the app's behalf (not from the editor) and keeps history,
    /// index and known hashes in step.
    pub(crate) fn write_tracked(&self, rel: &str, content: &str) -> AppResult<()> {
        self.write_note(rel, content)?;
        self.known().insert(rel.to_string(), content_hash(content));
        self.history.record(rel, content, Origin::App, true)?;
        self.index.upsert_file(&self.root, rel)
    }

    /// Notes linking to `rel`, with the linking line for context (SCR-07).
    pub fn backlinks(&self, rel: &str) -> AppResult<Vec<Backlink>> {
        let rel = normalize_rel(rel);
        let mut out = Vec::new();
        let mut cache: HashMap<String, Vec<String>> = HashMap::new();
        for LinkRef { path, title, line } in self.index.backlinks(&rel)? {
            let lines = cache.entry(path.clone()).or_insert_with(|| {
                self.abs(&path)
                    .ok()
                    .and_then(|p| fs::read_to_string(p).ok())
                    .map(|s| s.lines().map(str::to_string).collect())
                    .unwrap_or_default()
            });
            let context = lines.get(line.saturating_sub(1) as usize).map(|l| l.trim()).unwrap_or("");
            let context: String = context.chars().take(160).collect();
            out.push(Backlink { path, title, line, context });
        }
        Ok(out)
    }

    /// Sends a file or folder to the OS recycle bin.
    pub fn delete(&self, rel: &str) -> AppResult<()> {
        let rel = normalize_rel(rel);
        let p = self.existing(&rel)?;
        trash::delete(&p).map_err(|e| AppError::Trash(e.to_string()))?;
        // History is kept so deleted notes can be restored (FR-HIS-07).
        self.forget_known(&rel);
        self.index.remove(&rel)
    }
}

fn title_of(rel: &str) -> String {
    let name = file_name(rel);
    if is_note(name) { name[..name.len() - 3].to_string() } else { name.to_string() }
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
        assert_eq!(v.rename("a.md", "새 이름", true).unwrap(), "새 이름.md");
        assert!(matches!(v.rename("b.md", "새 이름", true), Err(AppError::AlreadyExists(_))));
        // case-only rename is allowed
        assert_eq!(v.rename("b.md", "B", true).unwrap(), "B.md");
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
        assert!(v.index().has("a.md").unwrap());
        assert_eq!(v.read_note("a.md").unwrap(), "3");
    }

    #[test]
    fn conflicting_external_edit_keeps_both_versions() {
        let (dir, v) = vault();
        v.create_note("", Some("a"), "original").unwrap();
        assert_eq!(v.read_note("a.md").unwrap(), "original");
        // another program edits the file while the editor still holds "original"
        fs::write(dir.path().join("a.md"), "from outside").unwrap();
        let out = v.save_note("a.md", "my edit", false).unwrap();
        let conflict = out.conflict.expect("conflict copy");
        assert!(conflict.starts_with("a (충돌 ") && conflict.ends_with(".md"), "{conflict}");
        assert_eq!(fs::read_to_string(dir.path().join("a.md")).unwrap(), "from outside");
        assert_eq!(v.read_note(&conflict).unwrap(), "my edit");
        // after reloading, saving works normally again
        v.read_note("a.md").unwrap();
        assert!(v.save_note("a.md", "merged", false).unwrap().conflict.is_none());
    }

    #[test]
    fn external_change_is_recorded_once_and_own_saves_are_ignored() {
        let (dir, v) = vault();
        v.create_note("", Some("a"), "mine").unwrap();
        assert!(!v.on_external_change("a.md").unwrap(), "own write is not external");
        fs::write(dir.path().join("a.md"), "theirs").unwrap();
        assert!(v.on_external_change("a.md").unwrap());
        let versions = v.history().list("a.md").unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[0].origin, Origin::External);
    }

    #[test]
    fn rename_carries_history_and_index() {
        let (_d, v) = vault();
        v.create_folder("", "f").unwrap();
        v.create_note("f", Some("a"), "x").unwrap();
        v.rename("f", "g", true).unwrap();
        assert_eq!(v.history().list("g/a.md").unwrap().len(), 1);
        assert!(v.index().has("g/a.md").unwrap());
        assert!(!v.index().has("f/a.md").unwrap());
    }

    #[test]
    fn rename_rewrites_links_in_other_notes_after_preview() {
        let (dir, v) = vault();
        v.create_folder("", "30 조사자료").unwrap();
        v.create_note("30 조사자료", Some("회의록"), "본문").unwrap();
        v.create_folder("", "일지").unwrap();
        v.create_note("일지", Some("a"), "[[회의록|어제]] [자료](../30%20조사자료/회의록.md)").unwrap();
        let preview = v.preview_relocate("30 조사자료/회의록.md", "30 조사자료/회의록 1027.md").unwrap();
        assert_eq!(preview.len(), 1);
        assert_eq!((preview[0].path.as_str(), preview[0].count), ("일지/a.md", 2));
        // preview writes nothing
        assert!(fs::read_to_string(dir.path().join("일지/a.md")).unwrap().contains("[[회의록|"));

        v.rename("30 조사자료/회의록.md", "회의록 1027", true).unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("일지/a.md")).unwrap(),
            "[[회의록 1027|어제]] [자료](../30%20조사자료/회의록%201027.md)"
        );
        assert_eq!(v.backlinks("30 조사자료/회의록 1027.md").unwrap().len(), 2);
    }

    #[test]
    fn moving_a_note_rebases_its_own_relative_links() {
        let (dir, v) = vault();
        v.create_folder("", "a").unwrap();
        v.create_folder("", "b").unwrap();
        v.create_note("b", Some("y"), "").unwrap();
        v.create_note("a", Some("x"), "[y](../b/y.md)").unwrap();
        v.create_folder("a", "sub").unwrap();
        v.move_to("a/x.md", "a/sub", true).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("a/sub/x.md")).unwrap(), "[y](../../b/y.md)");
        assert_eq!(v.backlinks("b/y.md").unwrap().len(), 1);
    }

    #[test]
    fn move_into_folder_and_refuse_self_nesting() {
        let (_d, v) = vault();
        v.create_folder("", "f").unwrap();
        v.create_folder("f", "g").unwrap();
        v.create_note("", Some("n"), "").unwrap();
        assert_eq!(v.move_to("n.md", "f/g", true).unwrap(), "f/g/n.md");
        assert!(v.move_to("f", "f/g", true).is_err());
        assert_eq!(v.move_to("f/g", "", true).unwrap(), "g");
    }
}
