//! Git backup: the vault folder as a Git repository, saved with one button and,
//! when a remote is set, sent there (and brought back from it). Uses the Git the
//! user installed; nothing is sent unless the user sets a remote.
//!
//! The index and history databases change all the time and can't be merged, so they
//! stay out of Git (`.gitignore`); notes, attachments, boards and settings go in.

use std::path::Path;
use std::process::Command;

use serde::Serialize;
use tauri::State;

use crate::commands::{AppState, with_vault};
use crate::error::{AppError, AppResult};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const GITIGNORE: &str = "# Notevine: 검색 인덱스·히스토리 DB는 Git에 넣지 않습니다 (계속 바뀌고 합칠 수 없음)
.app/*.db
.app/*.db-*
.app/workspace.json
*.notevine-tmp
";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct BackupStatus {
    /// Git is installed.
    pub git: bool,
    /// The vault is a Git repository.
    pub repo: bool,
    pub branch: Option<String>,
    pub remote: Option<String>,
    /// Files changed since the last backup.
    pub changed: u32,
    /// Backups not yet sent to the remote / sent there by another PC and not here yet.
    pub ahead: u32,
    pub behind: u32,
    /// Time (ms) and message of the last backup.
    pub last_at: Option<i64>,
    pub last_message: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct BackupResult {
    /// A new backup (commit) was made.
    pub committed: bool,
    pub files: u32,
    /// Sent to the remote.
    pub pushed: bool,
    /// Changes from the remote were brought in.
    pub pulled: bool,
}

fn git(dir: &Path, args: &[&str]) -> AppResult<String> {
    let mut c = Command::new("git");
    // Korean file names as they are, not as "í…".
    c.args(["-c", "core.quotepath=false"])
        .args(args)
        .current_dir(dir)
        // Never wait for a password typed in a console nobody sees.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    let out = c.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::System("Git이 설치되어 있지 않습니다. https://git-scm.com 에서 설치해 주세요".into())
        } else {
            AppError::Io(e)
        }
    })?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let err = if err.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { err };
        return Err(AppError::System(explain(&err)));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
}

/// Git's message, with the usual causes said plainly first.
fn explain(err: &str) -> String {
    let lower = err.to_lowercase();
    let why = if lower.contains("authentication")
        || lower.contains("could not read username")
        || lower.contains("permission denied")
    {
        "원격 저장소에 로그인하지 못했습니다. 주소와 권한을 확인하세요 (Git 자격 증명 관리자로 한 번 로그인해 두면 됩니다)"
    } else if lower.contains("could not resolve host") || lower.contains("unable to access") {
        "원격 저장소에 연결하지 못했습니다. 인터넷 연결과 주소를 확인하세요"
    } else if lower.contains("repository not found") || lower.contains("does not appear to be a git repository") {
        "원격 저장소를 찾지 못했습니다. 주소를 확인하세요"
    } else if lower.contains("user.email") || lower.contains("user.name") || lower.contains("author identity") {
        "Git 사용자 이름·이메일이 설정되어 있지 않습니다"
    } else {
        ""
    };
    let first = err.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    if why.is_empty() { format!("Git 오류: {first}") } else { format!("{why} (Git: {first})") }
}

fn installed() -> bool {
    git(Path::new("."), &["--version"]).is_ok()
}

fn is_repo(dir: &Path) -> bool {
    // The vault folder itself, not a repository it happens to sit inside.
    dir.join(".git").exists()
}

pub fn status_in(dir: &Path) -> AppResult<BackupStatus> {
    let mut s = BackupStatus { git: installed(), ..Default::default() };
    if !s.git || !is_repo(dir) {
        return Ok(s);
    }
    s.repo = true;
    s.branch = git(dir, &["rev-parse", "--abbrev-ref", "HEAD"]).ok().filter(|b| b != "HEAD");
    s.remote = git(dir, &["remote", "get-url", "origin"]).ok().filter(|r| !r.is_empty());
    s.changed = git(dir, &["status", "--porcelain", "-uall"])?.lines().count() as u32;
    if let Ok(last) = git(dir, &["log", "-1", "--format=%ct%x09%s"])
        && let Some((t, m)) = last.split_once('\t')
    {
        s.last_at = t.parse::<i64>().ok().map(|t| t * 1000);
        s.last_message = Some(m.to_string());
    }
    if s.remote.is_some()
        && let Ok(counts) = git(dir, &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])
    {
        let mut it = counts.split_whitespace().map(|n| n.parse::<u32>().unwrap_or(0));
        s.ahead = it.next().unwrap_or(0);
        s.behind = it.next().unwrap_or(0);
    }
    Ok(s)
}

/// Makes the vault a repository with the Notevine `.gitignore` (kept if there is one).
pub fn init_in(dir: &Path) -> AppResult<()> {
    if !is_repo(dir) {
        git(dir, &["init", "-b", "main"])?;
    }
    let ignore = dir.join(".gitignore");
    if !ignore.exists() {
        std::fs::write(&ignore, GITIGNORE)?;
    }
    keep_line_endings(dir)?;
    // Commits need a name; use one local to this repository when none is set anywhere.
    if git(dir, &["config", "user.name"]).is_err() {
        git(dir, &["config", "user.name", "Notevine"])?;
    }
    if git(dir, &["config", "user.email"]).is_err() {
        git(dir, &["config", "user.email", "notevine@localhost"])?;
    }
    Ok(())
}

/// Notes stay byte for byte as saved: Git for Windows would otherwise turn their LF
/// line ends into CRLF whenever it writes them (a pull, an undone merge).
fn keep_line_endings(dir: &Path) -> AppResult<()> {
    if git(dir, &["config", "--local", "core.autocrlf"]).ok().as_deref() != Some("false") {
        git(dir, &["config", "--local", "core.autocrlf", "false"])?;
    }
    Ok(())
}

pub fn set_remote_in(dir: &Path, url: &str) -> AppResult<()> {
    let url = url.trim();
    if !is_repo(dir) {
        init_in(dir)?;
    }
    let has = git(dir, &["remote"])?.lines().any(|r| r == "origin");
    match (has, url.is_empty()) {
        (true, true) => git(dir, &["remote", "remove", "origin"]).map(drop),
        (true, false) => git(dir, &["remote", "set-url", "origin", url]).map(drop),
        (false, false) => git(dir, &["remote", "add", "origin", url]).map(drop),
        (false, true) => Ok(()),
    }
}

/// Commits everything changed, then (with a remote) brings in what other PCs sent
/// and sends this one's. A merge that would conflict is undone and reported, so
/// the notes on this PC are never left half-merged.
pub fn backup_in(dir: &Path, message: &str) -> AppResult<BackupResult> {
    if !is_repo(dir) {
        init_in(dir)?;
    }
    keep_line_endings(dir)?;
    let mut r = BackupResult::default();
    git(dir, &["add", "-A"])?;
    let staged = git(dir, &["diff", "--cached", "--name-only"])?;
    r.files = staged.lines().filter(|l| !l.is_empty()).count() as u32;
    if r.files > 0 {
        git(dir, &["commit", "-q", "-m", message])?;
        r.committed = true;
    }
    if git(dir, &["remote", "get-url", "origin"]).is_err() {
        return Ok(r);
    }
    let branch = git(dir, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    git(dir, &["fetch", "-q", "origin"])?;
    let remote_branch = format!("origin/{branch}");
    if git(dir, &["rev-parse", "--verify", "-q", &remote_branch]).is_ok() {
        let behind: u32 = git(dir, &["rev-list", "--count", &format!("HEAD..{remote_branch}")])?.parse().unwrap_or(0);
        if behind > 0 {
            if let Err(e) = git(dir, &["merge", "-q", "--no-edit", &remote_branch]) {
                let conflicts = git(dir, &["diff", "--name-only", "--diff-filter=U"]).unwrap_or_default();
                let _ = git(dir, &["merge", "--abort"]);
                return Err(if conflicts.is_empty() {
                    e
                } else {
                    AppError::System(format!(
                        "다른 PC에서 같은 노트를 고쳐 합치지 못했습니다: {}. 이 PC의 노트는 그대로 두었습니다. 한쪽에서 고친 뒤 다시 백업하세요",
                        conflicts.lines().collect::<Vec<_>>().join(", ")
                    ))
                });
            }
            r.pulled = true;
        }
    }
    let ahead: u32 = if git(dir, &["rev-parse", "--verify", "-q", &remote_branch]).is_ok() {
        git(dir, &["rev-list", "--count", &format!("{remote_branch}..HEAD")])?.parse().unwrap_or(0)
    } else {
        1 // the remote has no such branch yet
    };
    if ahead > 0 && git(dir, &["rev-parse", "-q", "--verify", "HEAD"]).is_ok() {
        git(dir, &["push", "-q", "-u", "origin", &branch])?;
        r.pushed = true;
    }
    Ok(r)
}

fn vault_dir(state: &State<AppState>) -> AppResult<std::path::PathBuf> {
    with_vault(state, |v| Ok(v.root().to_path_buf()))
}

#[tauri::command]
pub async fn backup_status(state: State<'_, AppState>) -> AppResult<BackupStatus> {
    status_in(&vault_dir(&state)?)
}

#[tauri::command]
pub async fn backup_init(state: State<'_, AppState>) -> AppResult<()> {
    init_in(&vault_dir(&state)?)
}

#[tauri::command]
pub async fn backup_set_remote(state: State<'_, AppState>, url: String) -> AppResult<()> {
    set_remote_in(&vault_dir(&state)?, &url)
}

#[tauri::command]
pub async fn backup_now(state: State<'_, AppState>, message: String) -> AppResult<BackupResult> {
    backup_in(&vault_dir(&state)?, &message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn backs_up_and_syncs_two_pcs_through_a_remote() {
        if !installed() {
            return; // nothing to test without Git
        }
        let tmp = tempfile::tempdir().unwrap();
        let remote = tmp.path().join("remote.git");
        fs::create_dir(&remote).unwrap();
        git(&remote, &["init", "-q", "--bare", "-b", "main"]).unwrap();
        let url = remote.to_string_lossy().to_string();

        let a = tmp.path().join("a");
        fs::create_dir_all(a.join(".app")).unwrap();
        fs::write(a.join("회의.md"), "# 회의\n").unwrap();
        fs::write(a.join(".app/index.db"), "x").unwrap();
        assert!(!status_in(&a).unwrap().repo);
        set_remote_in(&a, &url).unwrap();
        let s = status_in(&a).unwrap();
        assert!(s.repo && s.remote.is_some());
        assert_eq!(s.changed, 2); // 회의.md and .gitignore; index.db stays out
        let r = backup_in(&a, "백업 1").unwrap();
        assert!(r.committed && r.pushed && !r.pulled);
        assert_eq!(r.files, 2);
        assert_eq!(backup_in(&a, "그대로").unwrap(), BackupResult::default());

        // A second PC gets the notes, adds one, and sends it back.
        let b = tmp.path().join("b");
        git(tmp.path(), &["clone", "-q", &url, "b"]).unwrap();
        git(&b, &["config", "user.name", "b"]).unwrap();
        git(&b, &["config", "user.email", "b@x"]).unwrap();
        keep_line_endings(&b).unwrap();
        assert!(b.join("회의.md").exists());
        fs::write(b.join("아이디어.md"), "새 생각\n").unwrap();
        assert!(backup_in(&b, "B").unwrap().pushed);

        fs::write(a.join("할 일.md"), "- 질의서\n").unwrap();
        let r = backup_in(&a, "백업 2").unwrap();
        assert!(r.committed && r.pulled && r.pushed);
        assert!(a.join("아이디어.md").exists());
        let s = status_in(&a).unwrap();
        assert_eq!((s.changed, s.ahead, s.behind), (0, 0, 0));
        assert!(s.last_at.is_some() && s.last_message.is_some());

        // Both change the same line: nothing is half-merged and the reason is given.
        fs::write(b.join("회의.md"), "# 회의 B\n").unwrap();
        git(&b, &["pull", "-q", "--no-rebase"]).unwrap();
        backup_in(&b, "B2").unwrap();
        fs::write(a.join("회의.md"), "# 회의 A\n").unwrap();
        let e = backup_in(&a, "A2").unwrap_err().to_string();
        assert!(e.contains("회의.md"), "{e}");
        assert_eq!(fs::read_to_string(a.join("회의.md")).unwrap(), "# 회의 A\n");
        assert!(!a.join(".git/MERGE_HEAD").exists());
    }
}
