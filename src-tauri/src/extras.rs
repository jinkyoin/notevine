//! Version compare/restore and deleted notes (FR-HIS-04..07), and attachments
//! (FR-ATT-01·02·04·05).
//!
//! Every write goes through [`Vault`] path checks, so nothing lands outside the
//! vault or in `.app/` (NFR-SEC-01).

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use similar::{Algorithm, ChangeTag, TextDiff};
use unicode_normalization::UnicodeNormalization;

use crate::error::{AppError, AppResult};
use crate::history::Origin;
use crate::paths::{
    file_name, is_hidden, is_note, join_rel, name_key, normalize_rel, parent_rel, resolve_rel, to_rel, validate_name,
};
use crate::vault::Vault;

// ---------------------------------------------------------------------------
// History: restore, diff, deleted notes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffKind {
    Same,
    Add,
    Del,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiffLine {
    pub kind: DiffKind,
    pub text: String,
    /// 1-based line number in the old text (absent for added lines).
    pub old_no: Option<u32>,
    /// 1-based line number in the new text (absent for deleted lines).
    pub new_no: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeletedNote {
    pub path: String,
    pub title: String,
    pub last_saved_at: i64,
    pub versions: u32,
}

/// Version content, after checking that `id` is a version of `rel`.
fn version_of(vault: &Vault, rel: &str, id: i64) -> AppResult<String> {
    if !vault.history().list(rel)?.iter().any(|v| v.id == id) {
        return Err(AppError::NotFound(format!("{rel} (버전 {id})")));
    }
    vault.history().content(id)
}

/// Restores version `id` of `path` (FR-HIS-05). The current file is first kept as
/// a version so the restore can be undone; a deleted note is recreated (FR-HIS-07).
pub fn restore_version(vault: &Vault, path: &str, id: i64) -> AppResult<()> {
    let rel = normalize_rel(path);
    let abs = vault.abs(&rel)?;
    if rel.is_empty() || abs.is_dir() {
        return Err(AppError::AlreadyExists(rel));
    }
    // Read the version before recording the current text: recording may update
    // an open bundle row, which could be the very version being restored.
    let content = version_of(vault, &rel, id)?;
    if abs.is_file() {
        let current = vault.read_note(&rel)?;
        vault.history().record(&rel, &current, Origin::App, true)?;
    }
    vault.write_note(&rel, &content)?; // atomic; creates parent folders
    // Refresh the known hash from disk so the watcher treats this as the app's own
    // write and the reloaded editor sees no conflict. The caller holds the vault
    // lock, so the watcher cannot run in between.
    vault.read_note(&rel)?;
    vault.history().record(&rel, &content, Origin::Restore, true)?;
    if is_note(&rel) {
        vault.index().upsert_file(vault.root(), &rel)?;
    }
    Ok(())
}

/// Text of version `id`, or of the file on disk for `None` (empty if missing).
/// Reading the disk copy does not touch the known-hash map.
fn diff_side(vault: &Vault, rel: &str, id: Option<i64>) -> AppResult<String> {
    match id {
        Some(id) => version_of(vault, rel, id),
        None => {
            let abs = vault.abs(rel)?;
            if abs.is_file() { Ok(fs::read_to_string(abs)?) } else { Ok(String::new()) }
        }
    }
}

/// Line diff between two texts. CRLF and LF line ends compare equal.
pub fn diff_lines(old: &str, new: &str) -> Vec<DiffLine> {
    let old: Vec<&str> = old.lines().collect();
    let new: Vec<&str> = new.lines().collect();
    let diff =
        TextDiff::configure().algorithm(Algorithm::Patience).timeout(Duration::from_secs(2)).diff_slices(&old, &new);
    diff.iter_all_changes()
        .map(|c| DiffLine {
            kind: match c.tag() {
                ChangeTag::Equal => DiffKind::Same,
                ChangeTag::Insert => DiffKind::Add,
                ChangeTag::Delete => DiffKind::Del,
            },
            text: c.value().to_string(),
            old_no: c.old_index().map(|i| i as u32 + 1),
            new_no: c.new_index().map(|i| i as u32 + 1),
        })
        .collect()
}

/// Diff from version `from_id` to version `to_id` of `path` (FR-HIS-04).
/// `None` means the current file on disk.
pub fn version_diff(vault: &Vault, path: &str, from_id: Option<i64>, to_id: Option<i64>) -> AppResult<Vec<DiffLine>> {
    let rel = normalize_rel(path);
    let old = diff_side(vault, &rel, from_id)?;
    let new = diff_side(vault, &rel, to_id)?;
    Ok(diff_lines(&old, &new))
}

/// Paths that have history but no file on disk, newest first (FR-HIS-07).
pub fn deleted_notes(vault: &Vault) -> AppResult<Vec<DeletedNote>> {
    let mut out = Vec::new();
    for (path, last_saved_at, versions) in vault.history().paths()? {
        if path.split('/').any(is_hidden) {
            continue;
        }
        let Ok(abs) = vault.abs(&path) else { continue };
        if abs.is_file() {
            continue;
        }
        let name = file_name(&path);
        let title = if is_note(name) { name[..name.len() - 3].to_string() } else { name.to_string() };
        out.push(DeletedNote { path, title, last_saved_at, versions });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/// Validates the attachments folder (vault-relative, may be nested) and creates it.
fn attachment_dir(vault: &Vault, folder: &str) -> AppResult<String> {
    let rel = normalize_rel(folder);
    for seg in rel.split('/').filter(|s| !s.is_empty()) {
        validate_name(seg)?;
        if is_hidden(seg) {
            return Err(AppError::InvalidName(seg.to_string()));
        }
    }
    fs::create_dir_all(vault.abs(&rel)?)?;
    Ok(rel)
}

/// `("사진", ".png")`; a leading dot is not an extension.
fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

fn check_file_name(name: &str) -> AppResult<String> {
    let name: String = name.nfc().collect();
    validate_name(&name)?;
    if is_hidden(&name) {
        return Err(AppError::InvalidName(name));
    }
    Ok(name)
}

/// Creates a new file `name` in `dir_rel`, numbering it ("name 1.ext", ...) when
/// the name is taken (case-insensitive, NFC), and fills it with `fill`.
/// Never overwrites an existing file. Returns the vault-relative path.
fn create_unique(
    vault: &Vault,
    dir_rel: &str,
    name: &str,
    fill: impl Fn(&mut File) -> io::Result<()>,
) -> AppResult<String> {
    let (stem, ext) = split_ext(name);
    loop {
        let unique = vault.unique_name(dir_rel, stem, ext)?;
        let rel = join_rel(dir_rel, &unique);
        let abs = vault.abs(&rel)?;
        let mut f = match OpenOptions::new().write(true).create_new(true).open(&abs) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue, // lost a race; next number
            Err(e) => return Err(e.into()),
        };
        if let Err(e) = fill(&mut f).and_then(|_| f.sync_all()) {
            drop(f);
            let _ = fs::remove_file(&abs);
            return Err(e.into());
        }
        return Ok(rel);
    }
}

/// `canonicalize` on Windows returns `\\?\C:\...`; strip it to compare with the vault root.
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

/// Copies a dropped file into the attachments folder (FR-ATT-01). A file already
/// inside the vault is not copied; its vault-relative path is returned.
pub fn import_attachment(vault: &Vault, src: &Path, folder: &str) -> AppResult<String> {
    let src = strip_verbatim(src.canonicalize().map_err(|_| AppError::NotFound(src.display().to_string()))?);
    if !src.is_file() {
        return Err(AppError::NotFound(src.display().to_string()));
    }
    if let Some(rel) = to_rel(vault.root(), &src)
        && !rel.is_empty()
        && !rel.split('/').any(is_hidden)
        && vault.abs(&rel).is_ok()
    {
        return Ok(rel);
    }
    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| AppError::InvalidName(src.display().to_string()))?;
    let name = check_file_name(&name)?;
    let dir = attachment_dir(vault, folder)?;
    create_unique(vault, &dir, &name, |f| {
        io::copy(&mut File::open(&src)?, f)?;
        Ok(())
    })
}

/// Saves pasted clipboard bytes as a new file in the attachments folder (FR-ATT-02).
pub fn save_attachment(vault: &Vault, name: &str, data: &[u8], folder: &str) -> AppResult<String> {
    let name = check_file_name(name)?;
    let dir = attachment_dir(vault, folder)?;
    create_unique(vault, &dir, &name, |f| f.write_all(data))
}

/// Absolute path of an existing vault file, for the asset protocol and the OS opener.
pub fn attachment_path(vault: &Vault, path: &str) -> AppResult<String> {
    let rel = normalize_rel(path);
    let abs = vault.abs(&rel)?;
    if rel.is_empty() || !abs.is_file() {
        return Err(AppError::NotFound(rel));
    }
    Ok(abs.display().to_string())
}

/// Name lookup for `![[name.png]]` embeds (FR-ATT-04·05).
///
/// Cache policy: one in-memory map of name key → vault-relative paths, built by a
/// single walk of the vault (hidden entries and `.app/` skipped).
/// - It is reused for up to [`FRESH`] after being built, then rebuilt on next use.
/// - A miss (unknown name, or a cached path that no longer exists) rebuilds it at
///   once if the map is older than [`MISS_REBUILD`], so a file added by another
///   program shows up within about a second, while a note full of broken embeds
///   costs at most one walk per second.
/// - Files the app itself imports/saves are added to the map right away.
pub struct AttachmentResolver {
    cache: Mutex<Option<NameMap>>,
}

const FRESH: Duration = Duration::from_secs(10);
const MISS_REBUILD: Duration = Duration::from_secs(1);

struct NameMap {
    root: PathBuf,
    built: Instant,
    by_name: HashMap<String, Vec<String>>,
}

impl NameMap {
    fn build(root: &Path, now: Instant) -> Self {
        let mut by_name: HashMap<String, Vec<String>> = HashMap::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if is_hidden(&name) {
                    continue; // .app/, .git, temp files
                }
                let Ok(ft) = entry.file_type() else { continue };
                if ft.is_dir() {
                    stack.push(entry.path());
                } else if let Some(rel) = to_rel(root, &entry.path()) {
                    by_name.entry(name_key(&name)).or_default().push(rel);
                }
            }
        }
        Self { root: root.to_path_buf(), built: now, by_name }
    }

    /// Best match: same folder as the note, then shallowest, then shortest path.
    fn best(&self, key: &str, from_dir: &str) -> Option<String> {
        self.by_name
            .get(key)?
            .iter()
            .min_by_key(|p| (parent_rel(p) != from_dir, p.matches('/').count(), p.chars().count(), p.as_str()))
            .cloned()
    }
}

impl Default for AttachmentResolver {
    fn default() -> Self {
        Self::new()
    }
}

impl AttachmentResolver {
    pub const fn new() -> Self {
        Self { cache: Mutex::new(None) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<NameMap>> {
        self.cache.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Records a file the app just created so lookups find it without a rebuild.
    pub fn added(&self, root: &Path, rel: &str) {
        if let Some(map) = self.lock().as_mut()
            && map.root == root
        {
            let list = map.by_name.entry(name_key(file_name(rel))).or_default();
            if !list.iter().any(|p| p == rel) {
                list.push(rel.to_string());
            }
        }
    }

    pub fn resolve(&self, vault: &Vault, target: &str, from: &str) -> AppResult<Option<String>> {
        self.resolve_at(vault, target, from, Instant::now())
    }

    fn resolve_at(&self, vault: &Vault, target: &str, from: &str, now: Instant) -> AppResult<Option<String>> {
        // `![[a.png|300]]`: '|' cannot be part of a Windows file name.
        let target = target.split('|').next().unwrap_or("").trim();
        if target.is_empty() {
            return Ok(None);
        }
        let from_dir = parent_rel(&normalize_rel(from)).to_string();
        let existing = |rel: &str| -> bool {
            !rel.is_empty() && !rel.split('/').any(is_hidden) && vault.abs(rel).is_ok_and(|p| p.is_file())
        };

        if target.contains('/') || target.contains('\\') {
            // Vault-relative first, then relative to the note's folder.
            let rel = normalize_rel(target);
            if existing(&rel) {
                return Ok(Some(rel));
            }
            return Ok(resolve_rel(&from_dir, target).filter(|r| existing(r)));
        }

        let key = name_key(target);
        let root = vault.root();
        let mut cache = self.lock();
        let stale = |m: &NameMap| m.root != root || now.saturating_duration_since(m.built) >= FRESH;
        if cache.as_ref().is_none_or(stale) {
            *cache = Some(NameMap::build(root, now));
        }
        let map = cache.as_ref().expect("built above");
        if let Some(found) = map.best(&key, &from_dir).filter(|p| existing(p)) {
            return Ok(Some(found));
        }
        if now.saturating_duration_since(map.built) >= MISS_REBUILD {
            let map = cache.insert(NameMap::build(root, now));
            return Ok(map.best(&key, &from_dir).filter(|p| existing(p)));
        }
        Ok(None)
    }
}

static RESOLVER: AttachmentResolver = AttachmentResolver::new();

// ---------------------------------------------------------------------------
// Tauri commands (TS side: src/api.ts)
// ---------------------------------------------------------------------------

/// Command wrappers. Kept in their own module so the command names can match
/// the plain functions above.
pub mod cmd {
    use std::path::Path;

    use tauri::State;

    use super::{DeletedNote, DiffLine, RESOLVER};
    use crate::commands::{AppState, with_vault};
    use crate::error::AppResult;

    #[tauri::command]
    pub fn restore_version(state: State<AppState>, path: String, id: i64) -> AppResult<()> {
        with_vault(&state, |v| super::restore_version(v, &path, id))
    }

    #[tauri::command]
    pub fn version_diff(
        state: State<AppState>,
        path: String,
        from_id: Option<i64>,
        to_id: Option<i64>,
    ) -> AppResult<Vec<DiffLine>> {
        with_vault(&state, |v| super::version_diff(v, &path, from_id, to_id))
    }

    #[tauri::command]
    pub fn deleted_notes(state: State<AppState>) -> AppResult<Vec<DeletedNote>> {
        with_vault(&state, super::deleted_notes)
    }

    #[tauri::command]
    pub fn import_attachment(state: State<AppState>, src: String, folder: String) -> AppResult<String> {
        with_vault(&state, |v| {
            let rel = super::import_attachment(v, Path::new(&src), &folder)?;
            RESOLVER.added(v.root(), &rel);
            Ok(rel)
        })
    }

    /// `data` arrives as a JSON number array (send `Array.from(uint8array)`).
    #[tauri::command]
    pub fn save_attachment(state: State<AppState>, name: String, data: Vec<u8>, folder: String) -> AppResult<String> {
        with_vault(&state, |v| {
            let rel = super::save_attachment(v, &name, &data, &folder)?;
            RESOLVER.added(v.root(), &rel);
            Ok(rel)
        })
    }

    #[tauri::command]
    pub fn resolve_attachment(state: State<AppState>, target: String, from: String) -> AppResult<Option<String>> {
        with_vault(&state, |v| RESOLVER.resolve(v, &target, &from))
    }

    #[tauri::command]
    pub fn attachment_path(state: State<AppState>, path: String) -> AppResult<String> {
        with_vault(&state, |v| super::attachment_path(v, &path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::APP_DIR;

    fn vault() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        (dir, v)
    }

    fn kinds(d: &[DiffLine]) -> Vec<(DiffKind, &str, Option<u32>, Option<u32>)> {
        d.iter().map(|l| (l.kind, l.text.as_str(), l.old_no, l.new_no)).collect()
    }

    #[test]
    fn restore_keeps_current_and_records_restore() {
        let (dir, v) = vault();
        v.save_note("a.md", "첫 버전", true).unwrap();
        let first = v.history().list("a.md").unwrap()[0].id;
        v.save_note("a.md", "둘째 버전", true).unwrap();
        // an unrecorded change on disk (e.g. the watcher missed it) must survive as a version
        fs::write(dir.path().join("a.md"), "디스크 버전").unwrap();

        restore_version(&v, "a.md", first).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("a.md")).unwrap(), "첫 버전");
        let versions = v.history().list("a.md").unwrap();
        assert_eq!(versions[0].origin, Origin::Restore);
        assert_eq!(v.history().content(versions[0].id).unwrap(), "첫 버전");
        assert_eq!(versions[1].origin, Origin::App);
        assert_eq!(v.history().content(versions[1].id).unwrap(), "디스크 버전");
        // the watcher sees the app's own write, and the editor can save without a conflict
        assert!(!v.on_external_change("a.md").unwrap());
        assert!(v.save_note("a.md", "이어서 편집", false).unwrap().conflict.is_none());
    }

    #[test]
    fn restore_rejects_a_version_of_another_note() {
        let (_d, v) = vault();
        v.save_note("a.md", "a", true).unwrap();
        v.save_note("b.md", "b", true).unwrap();
        let b_id = v.history().list("b.md").unwrap()[0].id;
        assert!(matches!(restore_version(&v, "a.md", b_id), Err(AppError::NotFound(_))));
        assert!(matches!(restore_version(&v, "a.md", 9999), Err(AppError::NotFound(_))));
        assert!(restore_version(&v, "../a.md", b_id).is_err());
    }

    #[test]
    fn restoring_a_deleted_note_recreates_it() {
        let (dir, v) = vault();
        v.create_folder("", "일지").unwrap();
        v.save_note("일지/오늘.md", "기록", true).unwrap();
        let id = v.history().list("일지/오늘.md").unwrap()[0].id;
        fs::remove_dir_all(dir.path().join("일지")).unwrap();
        v.on_external_remove("일지").unwrap();
        assert_eq!(deleted_notes(&v).unwrap()[0].path, "일지/오늘.md");

        restore_version(&v, "일지/오늘.md", id).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("일지/오늘.md")).unwrap(), "기록");
        assert!(v.index().has("일지/오늘.md").unwrap());
        assert!(deleted_notes(&v).unwrap().is_empty());
    }

    #[test]
    fn diff_marks_kinds_and_line_numbers() {
        let d = diff_lines("가\n나\n다\n", "가\n나나\n다\n라");
        assert_eq!(
            kinds(&d),
            [
                (DiffKind::Same, "가", Some(1), Some(1)),
                (DiffKind::Del, "나", Some(2), None),
                (DiffKind::Add, "나나", None, Some(2)),
                (DiffKind::Same, "다", Some(3), Some(3)),
                (DiffKind::Add, "라", None, Some(4)),
            ]
        );
        // CRLF and LF compare equal, and no '\r' leaks into the text
        let d = diff_lines("한글\r\n둘째\r\n", "한글\n둘째\n셋째\n");
        assert_eq!(
            kinds(&d),
            [
                (DiffKind::Same, "한글", Some(1), Some(1)),
                (DiffKind::Same, "둘째", Some(2), Some(2)),
                (DiffKind::Add, "셋째", None, Some(3)),
            ]
        );
        assert!(diff_lines("", "").is_empty());
        let json = serde_json::to_string(&d[2]).unwrap();
        assert_eq!(json, r#"{"kind":"add","text":"셋째","old_no":null,"new_no":3}"#);
    }

    #[test]
    fn version_diff_against_disk_and_missing_file() {
        let (dir, v) = vault();
        v.save_note("a.md", "하나\n둘", true).unwrap();
        let id = v.history().list("a.md").unwrap()[0].id;
        fs::write(dir.path().join("a.md"), "하나\n셋").unwrap();
        let d = version_diff(&v, "a.md", Some(id), None).unwrap();
        assert_eq!(d.iter().map(|l| l.kind).collect::<Vec<_>>(), [DiffKind::Same, DiffKind::Del, DiffKind::Add]);
        // reading the disk side must not hide the external change from conflict detection
        assert!(v.save_note("a.md", "편집기", false).unwrap().conflict.is_some());

        fs::remove_file(dir.path().join("a.md")).unwrap();
        let d = version_diff(&v, "a.md", Some(id), None).unwrap();
        assert!(!d.is_empty() && d.iter().all(|l| l.kind == DiffKind::Del));
        v.save_note("b.md", "b", true).unwrap();
        let other = v.history().list("b.md").unwrap()[0].id;
        assert!(version_diff(&v, "a.md", Some(other), None).is_err());
    }

    #[test]
    fn deleted_notes_lists_only_missing_newest_first() {
        let (_d, v) = vault();
        v.history().record_at("old.md", "x", Origin::App, true, 1_000).unwrap();
        v.history().record_at("old.md", "y", Origin::App, true, 2_000).unwrap();
        v.history().record_at("폴더/new.md", "z", Origin::App, true, 5_000).unwrap();
        v.history().record_at(".hidden/h.md", "z", Origin::App, true, 6_000).unwrap();
        v.save_note("kept.md", "k", true).unwrap();
        let d = deleted_notes(&v).unwrap();
        let got: Vec<_> = d.iter().map(|n| (n.path.as_str(), n.title.as_str(), n.last_saved_at, n.versions)).collect();
        assert_eq!(got, [("폴더/new.md", "new", 5_000, 1), ("old.md", "old", 2_000, 2)]);
    }

    #[test]
    fn import_copies_with_unique_names() {
        let (dir, v) = vault();
        let outside = tempfile::tempdir().unwrap();
        let src = outside.path().join("사진.PNG");
        fs::write(&src, b"img1").unwrap();
        let a = import_attachment(&v, &src, "첨부").unwrap();
        assert_eq!(a, "첨부/사진.PNG");
        assert!(src.exists(), "source is copied, never moved");
        assert_eq!(fs::read(dir.path().join(&a)).unwrap(), b"img1");

        // same name in a different case and in NFD form → numbered, stored as NFC
        let nfd: String = "사진.png".nfd().collect();
        let other = tempfile::tempdir().unwrap();
        let src2 = other.path().join(&nfd);
        fs::write(&src2, b"img2").unwrap();
        assert_eq!(import_attachment(&v, &src2, "첨부").unwrap(), "첨부/사진 1.png");
        assert_eq!(import_attachment(&v, &src, "첨부").unwrap(), "첨부/사진 2.PNG");
        assert_eq!(fs::read(dir.path().join("첨부/사진.PNG")).unwrap(), b"img1", "never overwritten");

        // a file already in the vault is not copied
        fs::create_dir(dir.path().join("자료")).unwrap();
        fs::write(dir.path().join("자료/표.xlsx"), b"x").unwrap();
        assert_eq!(import_attachment(&v, &dir.path().join("자료/표.xlsx"), "첨부").unwrap(), "자료/표.xlsx");
        assert_eq!(fs::read_dir(dir.path().join("첨부")).unwrap().count(), 3);

        // folder must stay inside the vault
        assert!(import_attachment(&v, &src, "../밖").is_err());
        assert!(import_attachment(&v, &src, APP_DIR).is_err());
        assert!(import_attachment(&v, &outside.path().join("없음.png"), "첨부").is_err());
    }

    #[test]
    fn save_attachment_validates_name() {
        let (dir, v) = vault();
        let name = "이미지 20261028-143201.png";
        assert_eq!(save_attachment(&v, name, b"png", "첨부").unwrap(), format!("첨부/{name}"));
        assert_eq!(save_attachment(&v, name, b"png2", "첨부").unwrap(), "첨부/이미지 20261028-143201 1.png");
        assert_eq!(fs::read(dir.path().join("첨부").join(name)).unwrap(), b"png");
        assert_eq!(save_attachment(&v, "a.png", b"", "자료/이미지").unwrap(), "자료/이미지/a.png");
        for bad in ["../x.png", "a/b.png", "a:b.png", "", " a.png", ".hidden", "CON.png"] {
            assert!(save_attachment(&v, bad, b"", "첨부").is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn attachment_path_requires_an_existing_vault_file() {
        let (dir, v) = vault();
        fs::write(dir.path().join("a.pdf"), b"").unwrap();
        let p = attachment_path(&v, "a.pdf").unwrap();
        assert!(Path::new(&p).is_file());
        assert!(attachment_path(&v, "없음.pdf").is_err());
        assert!(attachment_path(&v, "../x").is_err());
        assert!(attachment_path(&v, "").is_err());
    }

    #[test]
    fn resolve_by_name_path_and_preference() {
        let (dir, v) = vault();
        let r = AttachmentResolver::new();
        for p in ["첨부/그림.png", "a/b/그림.png", "노트/그림.png", "z/그림.png", ".git/그림.png", "자료/표.xlsx"]
        {
            let abs = dir.path().join(p);
            fs::create_dir_all(abs.parent().unwrap()).unwrap();
            fs::write(abs, b"").unwrap();
        }
        // same folder as the note wins
        assert_eq!(r.resolve(&v, "그림.png", "노트/글.md").unwrap().as_deref(), Some("노트/그림.png"));
        // otherwise shallowest, then shortest path ("z/" beats "첨부/" and "노트/")
        assert_eq!(r.resolve(&v, "그림.PNG", "a/글.md").unwrap().as_deref(), Some("z/그림.png"));
        // case-insensitive, NFD input, size alias stripped
        let nfd: String = "표.XLSX|300".nfd().collect();
        assert_eq!(r.resolve(&v, &nfd, "").unwrap().as_deref(), Some("자료/표.xlsx"));
        // path targets: vault-relative, then relative to the note
        assert_eq!(r.resolve(&v, "a/b/그림.png", "x.md").unwrap().as_deref(), Some("a/b/그림.png"));
        assert_eq!(r.resolve(&v, "b/그림.png", "a/글.md").unwrap().as_deref(), Some("a/b/그림.png"));
        // missing, hidden, escaping
        assert_eq!(r.resolve(&v, "없음.png", "").unwrap(), None);
        assert_eq!(r.resolve(&v, ".git/그림.png", "").unwrap(), None);
        assert_eq!(r.resolve(&v, "../그림.png", "").unwrap(), None);
        assert_eq!(r.resolve(&v, "", "").unwrap(), None);
    }

    #[test]
    fn resolver_cache_picks_up_new_and_removed_files() {
        let (dir, v) = vault();
        let r = AttachmentResolver::new();
        let t0 = Instant::now();
        assert_eq!(r.resolve_at(&v, "새.png", "", t0).unwrap(), None);
        fs::write(dir.path().join("새.png"), b"").unwrap();
        // a miss right after a build does not walk the vault again...
        assert_eq!(r.resolve_at(&v, "새.png", "", t0).unwrap(), None);
        // ...but a second later it does
        assert_eq!(r.resolve_at(&v, "새.png", "", t0 + MISS_REBUILD).unwrap().as_deref(), Some("새.png"));
        // files the app creates are added immediately
        let rel = save_attachment(&v, "붙임.png", b"", "첨부").unwrap();
        r.added(v.root(), &rel);
        assert_eq!(r.resolve_at(&v, "붙임.png", "", t0 + MISS_REBUILD).unwrap().as_deref(), Some("첨부/붙임.png"));
        // a cached path that disappeared falls back to another copy
        fs::create_dir(dir.path().join("다른")).unwrap();
        fs::write(dir.path().join("다른/새.png"), b"").unwrap();
        fs::remove_file(dir.path().join("새.png")).unwrap();
        assert_eq!(r.resolve_at(&v, "새.png", "", t0 + MISS_REBUILD * 3).unwrap().as_deref(), Some("다른/새.png"));
    }
}
