//! Note folders inside a cloud drive folder (OneDrive, Google Drive for desktop).
//! The drive's own app does the syncing; this module keeps the app out of its way.

use std::collections::HashSet;
use std::fs::{self, Metadata};
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::Connection;
use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::history::History;
use crate::paths::{APP_DIR, file_name, is_note, join_rel, name_key, parent_rel};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum DriveKind {
    #[serde(rename = "onedrive")]
    OneDrive,
    #[serde(rename = "google")]
    Google,
}

/// A drive folder on this PC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DriveRoot {
    pub kind: DriveKind,
    /// Shown on the start screen ("OneDrive - 회사").
    pub name: String,
    /// Everything under this folder is synced.
    pub root: String,
    /// Where the folder picker starts ("G:\내 드라이브").
    pub start: String,
}

/// Drive folders on this PC, found without asking the drives' apps anything.
pub fn installed() -> Vec<DriveRoot> {
    let mut out: Vec<DriveRoot> = Vec::new();
    let mut add = |d: DriveRoot| {
        if !out.iter().any(|o| o.root.eq_ignore_ascii_case(&d.root)) {
            out.push(d);
        }
    };
    // The OneDrive app sets these for each signed-in account.
    for var in ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] {
        let Some(dir) = std::env::var_os(var).map(PathBuf::from).filter(|d| d.is_dir()) else { continue };
        let name = dir.file_name().map_or_else(|| "OneDrive".to_string(), |n| n.to_string_lossy().into_owned());
        let root = dir.display().to_string();
        add(DriveRoot { kind: DriveKind::OneDrive, name, start: root.clone(), root });
    }
    // Google Drive: a drive letter of its own (streaming) ...
    for volume in google_volumes() {
        let start = MY_DRIVE.iter().map(|n| volume.join(n)).find(|d| d.is_dir()).unwrap_or_else(|| volume.clone());
        add(DriveRoot {
            kind: DriveKind::Google,
            name: "Google Drive".into(),
            root: volume.display().to_string(),
            start: start.display().to_string(),
        });
    }
    // ... or a folder in the user's profile (mirroring).
    if let Some(home) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
        for dir in MY_DRIVE.iter().chain(["Google Drive"].iter()).map(|n| home.join(n)).filter(|d| d.is_dir()) {
            let root = dir.display().to_string();
            add(DriveRoot { kind: DriveKind::Google, name: "Google Drive".into(), start: root.clone(), root });
        }
    }
    out
}

const MY_DRIVE: [&str; 2] = ["내 드라이브", "My Drive"];

/// Fixed volumes named "Google Drive". Network drives are skipped: asking one for its
/// name can hang for as long as the network takes to give up.
#[cfg(windows)]
fn google_volumes() -> Vec<PathBuf> {
    const DRIVE_FIXED: u32 = 3;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetLogicalDrives() -> u32;
        fn GetDriveTypeW(root: *const u16) -> u32;
        fn GetVolumeInformationW(
            root: *const u16,
            name: *mut u16,
            name_len: u32,
            serial: *mut u32,
            max_component: *mut u32,
            flags: *mut u32,
            fs_name: *mut u16,
            fs_name_len: u32,
        ) -> i32;
    }
    // SAFETY: takes no arguments and returns a bit mask.
    let letters = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();
    for i in 0..26u8 {
        if letters & (1 << i) == 0 {
            continue;
        }
        let root = format!("{}:\\", (b'A' + i) as char);
        let wide: Vec<u16> = root.encode_utf16().chain([0]).collect();
        let mut label = [0u16; 261];
        // SAFETY: `wide` is NUL-terminated, `label` is writable for the length given,
        // and the API allows null for every output it isn't asked for.
        let named = unsafe {
            GetDriveTypeW(wide.as_ptr()) == DRIVE_FIXED
                && GetVolumeInformationW(
                    wide.as_ptr(),
                    label.as_mut_ptr(),
                    label.len() as u32,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    0,
                ) != 0
        };
        let len = label.iter().position(|c| *c == 0).unwrap_or(label.len());
        if named && String::from_utf16_lossy(&label[..len]).eq_ignore_ascii_case("Google Drive") {
            out.push(PathBuf::from(root));
        }
    }
    out
}

#[cfg(not(windows))]
fn google_volumes() -> Vec<PathBuf> {
    Vec::new()
}

/// Which drive a folder is in. Windows paths compare without regard to case.
pub fn kind_of(path: &Path, roots: &[DriveRoot]) -> Option<DriveKind> {
    let path = path.to_string_lossy().to_lowercase();
    roots.iter().find(|r| Path::new(&path).starts_with(r.root.to_lowercase())).map(|r| r.kind)
}

const FILE_ATTRIBUTE_OFFLINE: u32 = 0x1000;
const FILE_ATTRIBUTE_RECALL_ON_OPEN: u32 = 0x0004_0000;
const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;

pub fn attrs_online_only(attrs: u32) -> bool {
    attrs & (FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS) != 0
}

/// A file whose content isn't on this PC: reading it makes the drive's app download it.
/// OneDrive marks these. Google Drive's streaming volume doesn't, so there every file
/// reads as present and comes down the first time it is read.
#[cfg(windows)]
pub fn is_online_only(meta: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    attrs_online_only(meta.file_attributes())
}

#[cfg(not(windows))]
pub fn is_online_only(_meta: &Metadata) -> bool {
    false
}

/// Reads a file so that it is on this PC, downloading it if need be.
pub fn fetch(abs: &Path, rel: &str) -> AppResult<()> {
    match retry_locked(|| fs::read(abs)) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(AppError::NotFound(rel.to_string())),
        Err(_) => Err(AppError::CloudFile(rel.to_string())),
    }
}

const RETRY_MS: [u64; 5] = [100, 200, 400, 800, 1500];

/// Runs a file operation, waiting and trying again while something holds the file.
/// Sync apps and antivirus open a file right after it changes, usually for moments.
pub fn retry_locked<T>(mut op: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
    for wait in RETRY_MS {
        match op() {
            Err(e) if is_locked(&e) => std::thread::sleep(Duration::from_millis(wait)),
            other => return other,
        }
    }
    op()
}

fn is_locked(e: &std::io::Error) -> bool {
    const ERROR_SHARING_VIOLATION: i32 = 32;
    const ERROR_LOCK_VIOLATION: i32 = 33;
    e.kind() == std::io::ErrorKind::PermissionDenied
        || matches!(e.raw_os_error(), Some(ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION))
}

/// Where a vault's databases and open-tabs file live.
#[derive(Debug, Clone)]
pub struct Placement {
    pub dir: PathBuf,
    /// The earlier history could not be moved. It is still where it was.
    pub warning: Option<String>,
}

/// This PC's folder for a vault's data. Keyed by path: an id kept in the vault would
/// follow a copied folder and make two vaults share one history.
pub fn local_store(local_base: &Path, root: &Path) -> PathBuf {
    let hash = blake3::hash(root.to_string_lossy().to_lowercase().as_bytes()).to_hex();
    local_base.join("vaults").join(&hash.as_str()[..16])
}

/// Decides where a vault's data lives, moving it there if it isn't yet.
///
/// A sync app uploading SQLite files that are in use can damage them, and WAL files
/// can't be shared between PCs at all, so a drive vault keeps them on this PC. A vault
/// that has been moved stays moved, even if its drive can't be seen later.
pub fn place(root: &Path, local_base: &Path, drive: Option<DriveKind>) -> Placement {
    let app = root.join(APP_DIR);
    let local = local_store(local_base, root);
    if drive.is_none() && !local.join(HISTORY).exists() {
        return Placement { dir: app, warning: None };
    }
    if let Err(e) = fs::create_dir_all(&local) {
        return Placement { dir: app, warning: Some(e.to_string()) };
    }
    // For whoever looks in this folder: which vault it belongs to.
    let _ = fs::write(local.join("vault-path.txt"), root.display().to_string());

    let warning = move_history(&app, &local).err().map(|e| e.to_string());
    for suffix in ["", "-wal", "-shm"] {
        let _ = fs::remove_file(app.join(format!("index.db{suffix}"))); // a cache; rebuilt here
    }
    let tabs = app.join(WORKSPACE);
    if tabs.exists() && (local.join(WORKSPACE).exists() || fs::copy(&tabs, local.join(WORKSPACE)).is_ok()) {
        let _ = fs::remove_file(&tabs);
    }
    Placement { dir: local, warning }
}

const HISTORY: &str = "history.db";
const WORKSPACE: &str = "workspace.json";
/// The history as it was moved off the drive. Other PCs start from this copy; it no
/// longer changes, so syncing it is safe.
const MOVED: &str = "history-moved.db";

fn move_history(app: &Path, local: &Path) -> AppResult<()> {
    let old = app.join(HISTORY);
    let moved = app.join(MOVED);
    let new = local.join(HISTORY);
    if new.exists() {
        if old.exists() {
            // Left behind by a retire that failed, or written by a PC on an older version.
            History::open(&new)?.merge_from(&old)?;
            retire(&old, &moved);
        }
        return Ok(());
    }
    let tmp = local.join("history.db.tmp");
    let copied = if old.exists() {
        snapshot(&old, &tmp)
    } else if moved.exists() {
        copy_checked(&moved, &tmp)
    } else {
        return Ok(());
    };
    let result = copied.and_then(|()| fs::rename(&tmp, &new).map_err(Into::into));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result?;
    if old.exists() {
        retire(&old, &moved);
    }
    Ok(())
}

/// A consistent copy of a database in use, its write-ahead log included.
fn snapshot(from: &Path, to: &Path) -> AppResult<()> {
    let _ = fs::remove_file(to);
    let conn = Connection::open(from)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.execute("VACUUM INTO ?1", [to.to_string_lossy()])?;
    drop(conn);
    check(to)
}

fn copy_checked(from: &Path, to: &Path) -> AppResult<()> {
    fs::copy(from, to)?;
    check(to)
}

fn check(file: &Path) -> AppResult<()> {
    let conn = Connection::open(file)?;
    let verdict: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    conn.query_row("SELECT count(*) FROM versions", [], |r| r.get::<_, i64>(0))?;
    if verdict != "ok" {
        return Err(AppError::System(verdict));
    }
    Ok(())
}

/// Takes the old file out of use. If it can't be done now, the next open merges it
/// again, which adds nothing already there.
fn retire(old: &Path, moved: &Path) {
    if retry_locked(|| fs::rename(old, moved)).is_ok() {
        for suffix in ["-wal", "-shm"] {
            let _ = fs::remove_file(format!("{}{suffix}", old.display()));
        }
    }
}

/// A copy the drive's app made when two PCs changed a note at once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DriveConflict {
    pub copy: String,
    pub original: String,
}

/// The conflict copies among `notes`. A name only counts if the note it was copied
/// from is right beside it, so "회의 (1).md" alone is just a note.
pub fn conflict_copies(kind: DriveKind, notes: &[String], computer: &str) -> Vec<DriveConflict> {
    let keys: HashSet<String> = notes.iter().map(|n| name_key(n)).collect();
    notes
        .iter()
        .filter_map(|copy| {
            let name = file_name(copy);
            if !is_note(name) {
                return None;
            }
            let stem = &name[..name.len() - ".md".len()];
            let base = match kind {
                DriveKind::Google => google_original(stem),
                DriveKind::OneDrive => onedrive_original(stem, computer),
            }?;
            let original = join_rel(parent_rel(copy), &format!("{base}.md"));
            keys.contains(&name_key(&original)).then(|| DriveConflict { copy: copy.clone(), original })
        })
        .collect()
}

/// "x (1)", "x_conf(1)", "[Conflict] x"
fn google_original(stem: &str) -> Option<&str> {
    if let Some(rest) = stem.strip_prefix("[Conflict] ") {
        return Some(rest);
    }
    let (base, number) = stem.strip_suffix(')')?.rsplit_once('(')?;
    if number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    base.strip_suffix(' ').or_else(|| base.strip_suffix("_conf")).filter(|b| !b.is_empty())
}

/// "x-PC이름" and "x-PC이름-2". Only this PC's name and the names Windows gives PCs by
/// default are recognized: "회의-2024" and "회의-AI" are names people choose.
fn onedrive_original<'a>(stem: &'a str, computer: &str) -> Option<&'a str> {
    let numbered = stem.rsplit_once('-').filter(|(_, n)| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
    [Some(stem), numbered.map(|(base, _)| base)].into_iter().flatten().find_map(|s| strip_pc_name(s, computer))
}

fn strip_pc_name<'a>(stem: &'a str, computer: &str) -> Option<&'a str> {
    let lower = stem.to_ascii_lowercase();
    let this_pc = format!("-{}", computer.to_ascii_lowercase());
    let at = if !computer.is_empty() && lower.ends_with(&this_pc) {
        lower.len() - this_pc.len()
    } else {
        ["-desktop-", "-laptop-"].iter().find_map(|tag| {
            let at = lower.rfind(tag)?;
            let rest = &lower[at + tag.len()..];
            (!rest.is_empty() && rest.bytes().all(|b| b.is_ascii_alphanumeric())).then_some(at)
        })?
    };
    (at > 0).then(|| &stem[..at])
}

/// Gives a file the mark a real online-only file has. Its content stays readable, so a
/// test can see whether the code under test read it.
#[cfg(all(test, windows))]
pub fn mark_online_only(file: &Path) {
    attrib("+O", file);
}

#[cfg(all(test, windows))]
pub fn mark_local(file: &Path) {
    attrib("-O", file);
}

#[cfg(all(test, windows))]
fn attrib(flag: &str, file: &Path) {
    let status = std::process::Command::new("attrib").arg(flag).arg(file).status().unwrap();
    assert!(status.success());
    let meta = fs::metadata(file).unwrap();
    assert_eq!(is_online_only(&meta), flag == "+O", "attrib {flag} did not take");
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::io::{Error, ErrorKind};

    use crate::history::Origin;

    use super::*;

    fn root(kind: DriveKind, root: &str) -> DriveRoot {
        DriveRoot { kind, name: String::new(), root: root.into(), start: root.into() }
    }

    #[test]
    fn a_path_belongs_to_a_drive_only_inside_its_folder() {
        let roots = [root(DriveKind::OneDrive, r"C:\Users\A\OneDrive"), root(DriveKind::Google, r"G:\")];
        assert_eq!(kind_of(Path::new(r"c:\users\a\onedrive\노트"), &roots), Some(DriveKind::OneDrive));
        assert_eq!(kind_of(Path::new(r"C:\Users\A\OneDrive"), &roots), Some(DriveKind::OneDrive));
        assert_eq!(kind_of(Path::new(r"G:\내 드라이브\노트"), &roots), Some(DriveKind::Google));
        assert_eq!(kind_of(Path::new(r"C:\Users\A\OneDrive2\노트"), &roots), None);
        assert_eq!(kind_of(Path::new(r"D:\노트"), &roots), None);
    }

    #[test]
    fn only_recall_attributes_mean_online_only() {
        assert!(attrs_online_only(0x0040_0000)); // RECALL_ON_DATA_ACCESS (OneDrive)
        assert!(attrs_online_only(0x0004_0000)); // RECALL_ON_OPEN
        assert!(attrs_online_only(0x1000)); // OFFLINE
        assert!(!attrs_online_only(0x20 | 0x80)); // ARCHIVE | NORMAL
    }

    #[test]
    fn a_locked_file_is_tried_again_until_it_is_free() {
        let tries = Cell::new(0);
        let out = retry_locked(|| {
            tries.set(tries.get() + 1);
            if tries.get() < 3 { Err(Error::from(ErrorKind::PermissionDenied)) } else { Ok(7) }
        });
        assert_eq!(out.unwrap(), 7);
        assert_eq!(tries.get(), 3);
    }

    #[test]
    fn a_file_that_stays_locked_gives_the_error_back() {
        let tries = Cell::new(0);
        let out: std::io::Result<()> = retry_locked(|| {
            tries.set(tries.get() + 1);
            Err(Error::from_raw_os_error(32)) // ERROR_SHARING_VIOLATION
        });
        assert!(out.is_err());
        assert!(tries.get() > 1);
    }

    #[test]
    fn other_errors_are_not_tried_again() {
        let tries = Cell::new(0);
        let out: std::io::Result<()> = retry_locked(|| {
            tries.set(tries.get() + 1);
            Err(Error::from(ErrorKind::NotFound))
        });
        assert!(out.is_err());
        assert_eq!(tries.get(), 1);
    }

    #[test]
    fn a_note_that_will_not_come_down_says_so() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("a.md");
        fs::write(&file, "본문").unwrap();
        assert!(fetch(&file, "a.md").is_ok());
        assert!(matches!(fetch(&tmp.path().join("없음.md"), "없음.md"), Err(AppError::NotFound(_))));
        // Reading a folder fails the way a failed download does: not "not found".
        assert!(matches!(fetch(tmp.path(), "a.md"), Err(AppError::CloudFile(_))));
    }

    struct Dirs {
        _tmp: tempfile::TempDir,
        root: PathBuf,
        base: PathBuf,
    }

    fn dirs() -> Dirs {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("노트");
        let base = tmp.path().join("local");
        fs::create_dir_all(root.join(APP_DIR)).unwrap();
        Dirs { _tmp: tmp, root, base }
    }

    fn old_history(d: &Dirs, path: &str, text: &str) {
        let h = History::open(&d.root.join(APP_DIR).join("history.db")).unwrap();
        h.record(path, text, Origin::App, true).unwrap();
    }

    fn versions(dir: &Path, path: &str) -> usize {
        History::open(&dir.join("history.db")).unwrap().list(path).unwrap().len()
    }

    #[test]
    fn an_ordinary_folder_keeps_its_data_in_dot_app() {
        let d = dirs();
        old_history(&d, "a.md", "첫");
        let p = place(&d.root, &d.base, None);
        assert_eq!(p.dir, d.root.join(APP_DIR));
        assert!(p.warning.is_none());
        assert!(d.root.join(APP_DIR).join("history.db").exists());
        assert!(!d.base.exists());
    }

    #[test]
    fn a_drive_folder_moves_its_history_off_the_drive() {
        let d = dirs();
        old_history(&d, "a.md", "첫");
        let p = place(&d.root, &d.base, Some(DriveKind::OneDrive));
        let app = d.root.join(APP_DIR);
        assert_eq!(p.dir, local_store(&d.base, &d.root));
        assert!(p.warning.is_none(), "{:?}", p.warning);
        assert_eq!(versions(&p.dir, "a.md"), 1);
        assert!(!app.join("history.db").exists());
        assert!(!app.join("history.db-wal").exists());
        assert!(app.join("history-moved.db").exists(), "other PCs still need it");
    }

    #[test]
    fn a_drive_folder_drops_the_index_and_moves_the_open_tabs() {
        let d = dirs();
        let app = d.root.join(APP_DIR);
        fs::write(app.join("index.db"), "cache").unwrap();
        fs::write(app.join("index.db-wal"), "cache").unwrap();
        fs::write(app.join("workspace.json"), r#"{"open_path":"a.md"}"#).unwrap();
        fs::write(app.join("config.json"), "{}").unwrap();
        let p = place(&d.root, &d.base, Some(DriveKind::Google));
        assert!(!app.join("index.db").exists());
        assert!(!app.join("index.db-wal").exists());
        assert!(!app.join("workspace.json").exists());
        assert!(p.dir.join("workspace.json").exists());
        assert!(app.join("config.json").exists(), "settings stay and sync");
    }

    #[test]
    fn another_pc_starts_from_the_moved_history() {
        let d = dirs();
        old_history(&d, "a.md", "첫");
        place(&d.root, &d.base, Some(DriveKind::OneDrive));
        let other = d._tmp.path().join("other-pc");
        let p = place(&d.root, &other, Some(DriveKind::OneDrive));
        assert_eq!(versions(&p.dir, "a.md"), 1);
        assert!(d.root.join(APP_DIR).join("history-moved.db").exists());
    }

    #[test]
    fn a_history_that_reappears_on_the_drive_is_merged_once() {
        let d = dirs();
        old_history(&d, "a.md", "첫");
        let p = place(&d.root, &d.base, Some(DriveKind::OneDrive));
        History::open(&p.dir.join("history.db")).unwrap().record("b.md", "여기", Origin::App, true).unwrap();
        // A PC still on the old version writes a new history.db to the drive.
        old_history(&d, "c.md", "저기");
        let p = place(&d.root, &d.base, Some(DriveKind::OneDrive));
        assert!(p.warning.is_none(), "{:?}", p.warning);
        assert_eq!(versions(&p.dir, "a.md"), 1);
        assert_eq!(versions(&p.dir, "b.md"), 1);
        assert_eq!(versions(&p.dir, "c.md"), 1);
        assert!(!d.root.join(APP_DIR).join("history.db").exists());
    }

    #[test]
    fn merging_twice_does_not_duplicate_versions() {
        let d = dirs();
        old_history(&d, "a.md", "첫");
        let copy = d._tmp.path().join("copy.db");
        // The first move succeeded but the old file could not be retired.
        let p = place(&d.root, &d.base, Some(DriveKind::OneDrive));
        fs::copy(d.root.join(APP_DIR).join("history-moved.db"), &copy).unwrap();
        fs::copy(&copy, d.root.join(APP_DIR).join("history.db")).unwrap();
        place(&d.root, &d.base, Some(DriveKind::OneDrive));
        assert_eq!(versions(&p.dir, "a.md"), 1);
    }

    #[test]
    fn a_damaged_history_is_left_alone_and_reported() {
        let d = dirs();
        let old = d.root.join(APP_DIR).join("history.db");
        fs::write(&old, "이건 DB가 아닙니다").unwrap();
        let p = place(&d.root, &d.base, Some(DriveKind::OneDrive));
        assert!(p.warning.is_some());
        assert_eq!(fs::read(&old).unwrap(), "이건 DB가 아닙니다".as_bytes());
        assert_eq!(versions(&p.dir, "a.md"), 0, "the vault still opens with an empty history");
    }

    #[test]
    fn a_folder_that_was_moved_stays_moved_when_the_drive_app_is_gone() {
        let d = dirs();
        old_history(&d, "a.md", "첫");
        place(&d.root, &d.base, Some(DriveKind::OneDrive));
        let p = place(&d.root, &d.base, None);
        assert_eq!(p.dir, local_store(&d.base, &d.root));
        assert_eq!(versions(&p.dir, "a.md"), 1);
    }

    #[test]
    fn different_folders_get_different_stores() {
        let base = Path::new(r"C:\local");
        assert_ne!(local_store(base, Path::new(r"G:\a")), local_store(base, Path::new(r"G:\b")));
        assert_eq!(local_store(base, Path::new(r"G:\A")), local_store(base, Path::new(r"g:\a")));
    }

    fn found(kind: DriveKind, notes: &[&str]) -> Vec<(String, String)> {
        let notes: Vec<String> = notes.iter().map(|s| s.to_string()).collect();
        conflict_copies(kind, &notes, "MY-PC").into_iter().map(|c| (c.copy, c.original)).collect()
    }

    fn pair(copy: &str, original: &str) -> (String, String) {
        (copy.into(), original.into())
    }

    #[test]
    fn google_conflict_copies_are_found_next_to_their_original() {
        assert_eq!(found(DriveKind::Google, &["회의.md", "회의 (1).md"]), [pair("회의 (1).md", "회의.md")]);
        assert_eq!(found(DriveKind::Google, &["폴더/회의.md", "폴더/회의_conf(2).md"]), [pair("폴더/회의_conf(2).md", "폴더/회의.md")]);
        assert_eq!(found(DriveKind::Google, &["회의.md", "[Conflict] 회의.md"]), [pair("[Conflict] 회의.md", "회의.md")]);
    }

    #[test]
    fn onedrive_conflict_copies_carry_a_pc_name() {
        assert_eq!(found(DriveKind::OneDrive, &["회의.md", "회의-MY-PC.md"]), [pair("회의-MY-PC.md", "회의.md")]);
        assert_eq!(found(DriveKind::OneDrive, &["회의.md", "회의-my-pc-2.md"]), [pair("회의-my-pc-2.md", "회의.md")]);
        assert_eq!(found(DriveKind::OneDrive, &["회의.md", "회의-DESKTOP-AB12C.md"]), [pair("회의-DESKTOP-AB12C.md", "회의.md")]);
        assert_eq!(found(DriveKind::OneDrive, &["회의.md", "회의-LAPTOP-XY9.md"]), [pair("회의-LAPTOP-XY9.md", "회의.md")]);
    }

    #[test]
    fn ordinary_names_are_not_conflict_copies() {
        // No original next to it.
        assert!(found(DriveKind::Google, &["회의 (1).md"]).is_empty());
        assert!(found(DriveKind::Google, &["다른폴더/회의.md", "회의 (1).md"]).is_empty());
        // Names people really use.
        assert!(found(DriveKind::OneDrive, &["회의.md", "회의-2024.md", "회의-AI.md"]).is_empty());
        assert!(found(DriveKind::Google, &["회의.md", "회의 (초안).md", "회의 1.md"]).is_empty());
        // Notevine's own conflict copies are reported when they are made.
        assert!(found(DriveKind::Google, &["회의.md", "회의 (충돌 2026-11-06 1432).md"]).is_empty());
        // Each drive's pattern applies to that drive only.
        assert!(found(DriveKind::OneDrive, &["회의.md", "회의 (1).md"]).is_empty());
    }
}
