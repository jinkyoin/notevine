//! A note handed over by Windows: Explorer's "연결 프로그램" starts the app with the file's
//! path (FR-VLT-10). Opening a folder as a note folder creates `.app` in it, so this only
//! finds where the file belongs; the page asks before opening a folder that isn't one yet.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::paths::{self, APP_DIR};
use crate::vault::strip_verbatim;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NoteFile {
    /// The folder to open: the note folder holding the file, or else the file's own folder.
    pub root: String,
    /// The file, relative to `root`.
    pub rel: String,
    /// Whether `root` is a note folder already (it has `.app`).
    pub in_vault: bool,
}

/// The note named on a command line. The first argument is the program itself.
pub fn from_args<I: IntoIterator<Item = String>>(args: I, cwd: &Path) -> Option<PathBuf> {
    args.into_iter().skip(1).find(|a| !a.starts_with('-') && paths::is_note(a)).map(|a| cwd.join(a))
}

/// Touches the disk up the whole path, which can take long on a network drive.
pub fn locate(file: &Path) -> Option<NoteFile> {
    let file = strip_verbatim(file.canonicalize().ok()?);
    if !file.is_file() || !paths::is_note(&file.file_name()?.to_string_lossy()) {
        return None;
    }
    for dir in file.ancestors().skip(1) {
        if dir.join(APP_DIR).is_dir()
            && let Some(rel) = paths::to_rel(dir, &file)
            // The tree doesn't show hidden folders, so such a file isn't one of this folder's notes.
            && !rel.split('/').any(paths::is_hidden)
        {
            return Some(NoteFile { root: dir.display().to_string(), rel, in_vault: true });
        }
    }
    let parent = file.parent()?;
    Some(NoteFile { root: parent.display().to_string(), rel: paths::to_rel(parent, &file)?, in_vault: false })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn finds_the_note_on_the_command_line() {
        let cwd = Path::new(r"C:\work");
        let exe = "notevine.exe";
        assert_eq!(from_args(args(&[exe, r"D:\노트\회의.md"]), cwd), Some(PathBuf::from(r"D:\노트\회의.md")));
        assert_eq!(from_args(args(&[exe, "--tray", r"D:\a.MD"]), cwd), Some(PathBuf::from(r"D:\a.MD")));
        assert_eq!(from_args(args(&[exe, "a.md"]), cwd), Some(PathBuf::from(r"C:\work\a.md")));
    }

    #[test]
    fn ignores_everything_else_on_the_command_line() {
        let cwd = Path::new(r"C:\work");
        assert_eq!(from_args(args(&["notevine.exe"]), cwd), None);
        assert_eq!(from_args(args(&["notevine.exe", "--tray"]), cwd), None);
        assert_eq!(from_args(args(&["notevine.exe", r"D:\a.txt"]), cwd), None);
        // The program's own name is never taken for a note.
        assert_eq!(from_args(args(&["note.md"]), cwd), None);
    }

    #[test]
    fn a_file_in_a_note_folder_opens_there() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("자료/깊은 곳");
        fs::create_dir_all(&sub).unwrap();
        fs::create_dir(dir.path().join(APP_DIR)).unwrap();
        fs::write(sub.join("메모.md"), "x").unwrap();
        let found = locate(&sub.join("메모.md")).unwrap();
        assert_eq!(found.rel, "자료/깊은 곳/메모.md");
        assert_eq!(found.root, strip_verbatim(dir.path().canonicalize().unwrap()).display().to_string());
        assert!(found.in_vault);
    }

    #[test]
    fn the_nearest_note_folder_wins() {
        let dir = tempfile::tempdir().unwrap();
        let inner = dir.path().join("안쪽");
        fs::create_dir_all(inner.join(APP_DIR)).unwrap();
        fs::create_dir(dir.path().join(APP_DIR)).unwrap();
        fs::write(inner.join("a.md"), "x").unwrap();
        let found = locate(&inner.join("a.md")).unwrap();
        assert_eq!((found.rel.as_str(), found.in_vault), ("a.md", true));
        assert!(found.root.ends_with("안쪽"));
    }

    #[test]
    fn a_file_outside_any_note_folder_offers_its_own_folder() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "x").unwrap();
        let found = locate(&dir.path().join("a.md")).unwrap();
        assert_eq!((found.rel.as_str(), found.in_vault), ("a.md", false));
        // Finding out creates nothing: only opening the folder does, after the user agrees.
        assert!(!dir.path().join(APP_DIR).exists());
    }

    #[test]
    fn a_hidden_folder_is_not_part_of_the_note_folder_above_it() {
        let dir = tempfile::tempdir().unwrap();
        let hidden = dir.path().join(".숨김");
        fs::create_dir(&hidden).unwrap();
        fs::create_dir(dir.path().join(APP_DIR)).unwrap();
        fs::write(hidden.join("a.md"), "x").unwrap();
        let found = locate(&hidden.join("a.md")).unwrap();
        assert_eq!((found.rel.as_str(), found.in_vault), ("a.md", false));
    }

    #[test]
    fn only_an_existing_note_file_is_found() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), "x").unwrap();
        fs::create_dir(dir.path().join("폴더.md")).unwrap();
        assert_eq!(locate(&dir.path().join("없음.md")), None);
        assert_eq!(locate(&dir.path().join("a.txt")), None);
        assert_eq!(locate(&dir.path().join("폴더.md")), None);
    }
}
