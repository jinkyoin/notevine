//! Vault = a user folder of .md files. The files are the only source of truth
//! (DR-01); everything under `.app/` is app data.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::drive::{self, DriveConflict, DriveKind, DriveRoot, Placement};
use crate::error::{AppError, AppResult};
use crate::history::{History, Origin};
use crate::index::{Index, LinkRef};
use crate::paths::{
    self, APP_DIR, check_rel, file_name, is_hidden, is_note, join_rel, name_key, normalize_rel, parent_rel,
    validate_name,
};
use crate::rewrite::{Move, rebase_own_links, rewrite_links};

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
    /// Open tabs in order (FR-EDT-07). Missing in files written before tabs.
    #[serde(default)]
    pub tabs: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultInfo {
    pub root: String,
    pub name: String,
    pub drive: Option<DriveKind>,
    /// The folder holding this vault's history and search index.
    pub store_dir: String,
    /// Kept on this PC, not in the note folder's `.app`.
    pub store_on_this_pc: bool,
    /// The earlier history could not be moved off the drive (it is still in `.app`).
    pub store_warning: Option<String>,
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
    /// Where the databases and open tabs live: `.app`, or this PC for a drive vault.
    store: PathBuf,
    drive: Option<DriveKind>,
    store_warning: Option<String>,
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
    #[cfg(test)]
    pub fn open(root: &Path) -> AppResult<Self> {
        let root = canonical_root(root)?;
        let dir = root.join(APP_DIR);
        Self::open_at(root, Placement { dir, warning: None }, None)
    }

    /// Opens a folder, keeping its databases off the drive if it is in one.
    pub fn open_placed(root: &Path, local_base: &Path, drives: &[DriveRoot]) -> AppResult<Self> {
        let root = canonical_root(root)?;
        let drive = drive::kind_of(&root, drives);
        let placement = drive::place(&root, local_base, drive);
        Self::open_at(root, placement, drive)
    }

    fn open_at(root: PathBuf, placement: Placement, drive: Option<DriveKind>) -> AppResult<Self> {
        fs::create_dir_all(root.join(APP_DIR))?;
        fs::create_dir_all(&placement.dir)?;
        let history = History::open(&placement.dir.join("history.db"))?;
        let index = Index::open(&placement.dir.join("index.db"))?;
        Ok(Self {
            root,
            store: placement.dir,
            drive,
            store_warning: placement.warning,
            history,
            index,
            known: Mutex::new(HashMap::new()),
        })
    }

    pub fn store_dir(&self) -> PathBuf {
        self.store.clone()
    }

    /// In a drive vault a note may have to come down from the network first. That read
    /// has to happen without holding the vault, or the whole app waits for the network.
    pub fn fetch_target(&self, rel: &str) -> AppResult<Option<PathBuf>> {
        if self.drive.is_none() {
            return Ok(None);
        }
        self.existing(rel).map(Some)
    }

    /// Copies the drive's app made when two PCs changed a note at once.
    pub fn drive_conflicts(&self) -> AppResult<Vec<DriveConflict>> {
        let Some(kind) = self.drive else { return Ok(Vec::new()) };
        fn notes_in(nodes: Vec<TreeNode>, out: &mut Vec<String>) {
            for n in nodes {
                match n.children {
                    Some(children) => notes_in(children, out),
                    None if n.kind == EntryKind::Note => out.push(n.path),
                    None => {}
                }
            }
        }
        let mut notes = Vec::new();
        notes_in(self.tree()?, &mut notes);
        let computer = std::env::var("COMPUTERNAME").unwrap_or_default();
        Ok(drive::conflict_copies(kind, &notes, &computer))
    }

    pub fn is_online_only(&self, rel: &str) -> bool {
        self.abs(rel).ok().and_then(|p| fs::metadata(p).ok()).is_some_and(|m| drive::is_online_only(&m))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Note open when the vault was last used (FR-VLT-02), from `.app/workspace.json`.
    pub fn workspace(&self) -> Workspace {
        fs::read_to_string(self.store.join("workspace.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn set_workspace(&self, ws: &Workspace) -> AppResult<()> {
        fs::write(self.store.join("workspace.json"), serde_json::to_string_pretty(ws)?)?;
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
            drive: self.drive,
            store_dir: self.store.display().to_string(),
            store_on_this_pc: self.store != self.root.join(APP_DIR),
            store_warning: self.store_warning.clone(),
        }
    }

    /// Absolute path for a vault-relative path, refusing anything outside the vault.
    pub fn abs(&self, rel: &str) -> AppResult<PathBuf> {
        let rel = normalize_rel(rel);
        check_rel(&rel)?;
        if rel.split('/').next() == Some(APP_DIR) {
            return Err(AppError::OutsideVault(rel));
        }
        Ok(if rel.is_empty() { self.root.clone() } else { self.root.join(rel) })
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
        let rel = normalize_rel(rel);
        self.known().insert(rel.clone(), content_hash(&content));
        // A note made before the vault was opened (or by another program) gets its
        // current text as the first version, so the first edit can be undone (FR-HIS-05).
        if is_note(&rel) && !self.history.has_versions(&rel).unwrap_or(true) {
            let _ = self.history.record(&rel, &content, Origin::External, true);
        }
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
        drive::retry_locked(|| fs::write(&tmp, content))?;
        if let Err(e) = drive::retry_locked(|| fs::rename(&tmp, &p)) {
            let _ = fs::remove_file(&tmp);
            return Err(e.into());
        }
        Ok(())
    }

    /// Saves a text file the app edits that is not a note (a `.canvas` board):
    /// written atomically like a note, without history or search index.
    pub fn save_text(&self, rel: &str, content: &str) -> AppResult<()> {
        let rel = normalize_rel(rel);
        self.write_note(&rel, content)?;
        self.known().insert(rel, content_hash(content));
        Ok(())
    }

    /// Saves a note from the editor and records a history snapshot (FR-HIS-01·02).
    /// The file write is what matters: if only the snapshot fails, the save still
    /// succeeds and the snapshot error comes back as a warning.
    pub fn save_note(&self, rel: &str, content: &str, force: bool) -> AppResult<SaveOutcome> {
        self.save_note_from(rel, content, force, Origin::App)
    }

    /// [`Self::save_note`], recording who wrote it.
    pub fn save_note_from(&self, rel: &str, content: &str, force: bool, origin: Origin) -> AppResult<SaveOutcome> {
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
        if let Err(e) = self.history.record(&rel, content, origin, force) {
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
        if self.is_online_only(&rel) {
            return Ok(false); // its text isn't here, and reading it would download it
        }
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
        self.create_note_from(dir_rel, name, content, Origin::App)
    }

    /// [`Self::create_note`], recording who wrote it.
    pub fn create_note_from(
        &self,
        dir_rel: &str,
        name: Option<&str>,
        content: &str,
        origin: Origin,
    ) -> AppResult<String> {
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
        // Sealed, so the first real edit becomes its own version.
        self.save_note_from(&rel, content, true, origin)?;
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
        let canvas = |n: &str| n.to_lowercase().ends_with(".canvas");
        let new_name = if src.is_file() && is_note(&old_name) {
            with_md(new_name)
        } else if src.is_file() && canvas(&old_name) && !canvas(new_name) {
            format!("{new_name}.canvas") // boards keep their extension like notes
        } else {
            new_name.to_string()
        };
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
            let Ok(content) = fs::read_to_string(self.abs(&src)?) else {
                continue;
            };
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
        let (from_abs, to_abs) = (self.abs(from)?, self.abs(to)?);
        drive::retry_locked(|| fs::rename(&from_abs, &to_abs))?;
        self.after_move(from, to)?;
        for (path, text, _) in plan {
            self.write_tracked(&path, &text)?;
        }
        if update_links {
            // Canvas cards follow the note too; a board that can't be read is left as it is.
            let _ = crate::canvas::retarget(self, from, to);
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
pub(crate) fn canonical_root(root: &Path) -> AppResult<PathBuf> {
    if !root.is_dir() {
        return Err(AppError::NotADirectory(root.display().to_string()));
    }
    Ok(strip_verbatim(root.canonicalize()?))
}

pub(crate) fn strip_verbatim(p: PathBuf) -> PathBuf {
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
    fn workspace_keeps_tabs_and_reads_files_from_before_tabs() {
        let (dir, v) = vault();
        let ws = Workspace { open_path: Some("b.md".into()), tabs: vec!["a.md".into(), "b.md".into()] };
        v.set_workspace(&ws).unwrap();
        let back = v.workspace();
        assert_eq!(back.open_path.as_deref(), Some("b.md"));
        assert_eq!(back.tabs, ["a.md", "b.md"]);
        fs::write(dir.path().join(APP_DIR).join("workspace.json"), r#"{ "open_path": "a.md" }"#).unwrap();
        let old = v.workspace();
        assert_eq!(old.open_path.as_deref(), Some("a.md"));
        assert!(old.tabs.is_empty());
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
        v.save_text("보드.canvas", "{}").unwrap();
        assert_eq!(v.rename("보드.canvas", "계획", true).unwrap(), "계획.canvas");
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
    fn opening_a_note_without_history_records_its_text_first() {
        let (dir, v) = vault();
        fs::write(dir.path().join("old.md"), "원래 내용").unwrap();
        v.read_note("old.md").unwrap();
        v.save_note("old.md", "고친 내용", false).unwrap();
        let versions = v.history().list("old.md").unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(v.history().content(versions[1].id).unwrap(), "원래 내용");
        v.read_note("old.md").unwrap();
        assert_eq!(v.history().list("old.md").unwrap().len(), 2, "only once");
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

    struct DriveVault {
        _dir: tempfile::TempDir,
        root: PathBuf,
        base: PathBuf,
        roots: Vec<DriveRoot>,
    }

    fn in_drive() -> DriveVault {
        let dir = tempfile::tempdir().unwrap();
        let top = strip_verbatim(dir.path().canonicalize().unwrap());
        let root = top.join("Drive").join("노트");
        fs::create_dir_all(&root).unwrap();
        let drive = top.join("Drive").display().to_string();
        let roots = vec![DriveRoot { kind: DriveKind::Google, name: String::new(), root: drive.clone(), start: drive }];
        DriveVault { root, base: top.join("local"), roots, _dir: dir }
    }

    #[test]
    fn a_drive_vault_keeps_its_databases_off_the_drive() {
        let d = in_drive();
        let v = Vault::open_placed(&d.root, &d.base, &d.roots).unwrap();
        let app = d.root.join(APP_DIR);
        assert_eq!(v.store_dir(), crate::drive::local_store(&d.base, &d.root));
        assert_eq!(v.info().drive, Some(DriveKind::Google));
        assert!(v.info().store_on_this_pc);
        assert!(v.store_dir().join("history.db").exists());
        assert!(v.store_dir().join("index.db").exists());
        assert!(!app.join("history.db").exists());
        assert!(!app.join("index.db").exists());
        assert!(app.is_dir(), "settings still sync through .app");
    }

    #[test]
    fn a_drive_vault_keeps_its_open_tabs_on_this_pc() {
        let d = in_drive();
        let v = Vault::open_placed(&d.root, &d.base, &d.roots).unwrap();
        v.set_workspace(&Workspace { open_path: Some("a.md".into()), tabs: vec![] }).unwrap();
        assert!(v.store_dir().join("workspace.json").exists());
        assert!(!d.root.join(APP_DIR).join("workspace.json").exists());
        assert_eq!(v.workspace().open_path.as_deref(), Some("a.md"));
    }

    #[test]
    fn a_folder_outside_any_drive_stays_as_it_was() {
        let d = in_drive();
        let v = Vault::open_placed(&d.root, &d.base, &[]).unwrap();
        assert_eq!(v.store_dir(), d.root.join(APP_DIR));
        assert_eq!(v.info().drive, None);
        assert!(!v.info().store_on_this_pc);
        assert!(d.root.join(APP_DIR).join("history.db").exists());
    }

    #[test]
    fn a_note_is_fetched_outside_the_lock_only_in_a_drive_vault() {
        let d = in_drive();
        let v = Vault::open_placed(&d.root, &d.base, &d.roots).unwrap();
        v.write_note("a.md", "x").unwrap();
        assert_eq!(v.fetch_target("a.md").unwrap(), Some(d.root.join("a.md")));
        let (_dir, plain) = vault();
        plain.write_note("a.md", "x").unwrap();
        assert_eq!(plain.fetch_target("a.md").unwrap(), None);
    }

    #[test]
    fn drive_conflicts_are_listed_only_in_a_drive_vault() {
        let d = in_drive();
        let v = Vault::open_placed(&d.root, &d.base, &d.roots).unwrap();
        v.write_note("폴더/회의.md", "a").unwrap();
        v.write_note("폴더/회의 (1).md", "b").unwrap();
        let found = v.drive_conflicts().unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].copy, "폴더/회의 (1).md");
        assert_eq!(found[0].original, "폴더/회의.md");
        let (_dir, plain) = vault();
        plain.write_note("회의.md", "a").unwrap();
        plain.write_note("회의 (1).md", "b").unwrap();
        assert!(plain.drive_conflicts().unwrap().is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn a_note_held_by_a_sync_app_is_saved_once_it_is_free() {
        use std::os::windows::fs::OpenOptionsExt;
        let (dir, v) = vault();
        let file = dir.path().join("a.md");
        fs::write(&file, "old").unwrap();
        let held = fs::OpenOptions::new().read(true).share_mode(0).open(&file).unwrap();
        let free = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            drop(held);
        });
        v.write_note("a.md", "new").unwrap();
        free.join().unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "new");
    }

    #[cfg(windows)]
    #[test]
    fn a_change_to_an_online_only_note_does_not_download_it() {
        let (dir, v) = vault();
        let file = dir.path().join("a.md");
        fs::write(&file, "드라이브의 본문").unwrap();
        crate::drive::mark_online_only(&file);
        assert!(v.is_online_only("a.md"));
        assert!(!v.on_external_change("a.md").unwrap());
        assert!(v.history().list("a.md").unwrap().is_empty());
    }
}
