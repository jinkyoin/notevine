//! Git backup: the vault folder as a Git repository, saved with one button and,
//! when a remote is set, sent there (and brought back from it). Uses the Git the
//! user installed; nothing is sent unless the user sets a remote.
//!
//! The index and history databases change all the time and can't be merged, so they
//! stay out of Git (`.gitignore`); notes, attachments, boards and settings go in.

use std::path::Path;
use std::process::Command;

use chrono::{DateTime, Local};
use serde::Serialize;
use tauri::State;

use crate::commands::AppState;
use crate::crypt::{CRYPT_FILE, MasterKey, crypt_file_key_id, crypt_file_text, key_id};
use crate::error::{AppError, AppResult};
use crate::trust::vault_root;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
const NO_HOOKS: &str = "core.hooksPath=NUL";
#[cfg(not(windows))]
const NO_HOOKS: &str = "core.hooksPath=/dev/null";

const GITIGNORE: &str = "# Notevine: 검색 인덱스·히스토리 DB는 Git에 넣지 않습니다 (계속 바뀌고 합칠 수 없음)
.app/*.db
.app/*.db-*
.app/workspace.json
*.notevine-tmp
";

/// Every file goes through the notevine filter except the three that Git and the app
/// must read as they are.
const GITATTRIBUTES: &str = "# Notevine: 이 노트 폴더는 원격에 암호화되어 올라갑니다
* filter=notevine diff=notevine merge=notevine -text
.gitattributes !filter !diff !merge
.gitignore !filter !diff !merge
.notevine-crypt !filter !diff !merge
";

/// Where `enable_encryption_in` puts the old repository. It holds plain history, so
/// it never goes into the new one.
const MOVED_ASIDE: &str = ".git-before-encryption-";
const MOVED_ASIDE_IGNORE: &str = "/.git-before-encryption-*/";

const NO_KEY: &str = "이 PC에 이 노트 폴더의 암호화 열쇠가 없습니다. 설정 > 백업에서 복구 코드를 넣어 주세요";
const NOT_THIS_REPO: &str =
    "원격 저장소가 이 암호화 저장소가 아닙니다(평문 이력이거나 다른 열쇠). 새 빈 저장소를 만들어 주소를 넣어 주세요";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct BackupStatus {
    /// Git is installed.
    pub git: bool,
    /// The vault is a Git repository.
    pub repo: bool,
    /// The user allowed Git to run in it on this PC. Until then nothing else is known.
    pub trusted: bool,
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
    /// Backups of this vault go to the remote encrypted.
    pub encrypted: bool,
    /// This PC's key is the one the vault is encrypted with.
    pub key_ok: bool,
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
        // A repository's own settings must not run commands (a backup never needs them).
        .args(["-c", "core.fsmonitor=false", "-c", NO_HOOKS, "-c", "protocol.ext.allow=never"])
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
    status_with_key(dir, None)
}

/// [`status_in`], also telling whether `key` opens an encrypted vault.
pub fn status_with_key(dir: &Path, key: Option<&MasterKey>) -> AppResult<BackupStatus> {
    let mut s = BackupStatus { git: installed(), ..Default::default() };
    if !s.git || !is_repo(dir) {
        return Ok(s);
    }
    s.repo = true;
    if let Some(id) = crypt_state(dir) {
        s.encrypted = true;
        s.key_ok = key_matches(key, id.as_deref());
    }
    s.branch = git(dir, &["rev-parse", "--abbrev-ref", "HEAD"]).ok().filter(|b| b != "HEAD");
    s.remote = git(dir, &["remote", "get-url", "origin"]).ok().filter(|r| !r.is_empty());
    // Without the key the filter can't clean a changed note, so Git may not say how many.
    s.changed = match git(dir, &["status", "--porcelain", "-uall"]) {
        Ok(out) => out.lines().count() as u32,
        Err(_) if s.encrypted && !s.key_ok => 0,
        Err(e) => return Err(e),
    };
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

/// `None`: a plain vault. `Some(id)`: an encrypted one, with the key id its
/// `.notevine-crypt` names (`None` if that can't be read). The working-tree file is
/// asked first; a deleted one still counts through the last commit or the filter config.
fn crypt_state(dir: &Path) -> Option<Option<String>> {
    if !is_repo(dir) {
        return None;
    }
    let file = dir.join(CRYPT_FILE);
    if file.exists() {
        return Some(std::fs::read_to_string(file).ok().as_deref().and_then(crypt_file_key_id));
    }
    if let Ok(text) = git(dir, &["show", &format!("HEAD:{CRYPT_FILE}")]) {
        return Some(crypt_file_key_id(&text));
    }
    if git(dir, &["config", "--local", "--get", "filter.notevine.process"]).is_ok() {
        return Some(None);
    }
    None
}

fn key_matches(key: Option<&MasterKey>, id: Option<&str>) -> bool {
    matches!((key, id), (Some(k), Some(id)) if key_id(k) == id)
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

/// Registers `notevine` as the repository's filter, diff text converter and merge
/// driver. `exe` is written with `/` and in double quotes, as Git's shell needs it.
fn configure_filter(dir: &Path, exe: &Path) -> AppResult<()> {
    let exe = exe.to_string_lossy().replace('\\', "/");
    if exe.is_empty() || exe.contains('"') {
        return Err(AppError::System(format!("Notevine 실행 파일 경로를 Git에 넣을 수 없습니다: {exe}")));
    }
    let exe = format!("\"{exe}\"");
    for (k, v) in [
        ("filter.notevine.process", format!("{exe} --git-filter")),
        ("filter.notevine.required", "true".to_string()),
        ("diff.notevine.textconv", format!("{exe} --git-textconv")),
        ("merge.notevine.driver", format!("{exe} --git-merge %O %A %B %P")),
        ("merge.notevine.name", "Notevine 암호화 노트 합치기".to_string()),
    ] {
        if git(dir, &["config", "--local", "--get", k]).ok().as_deref() != Some(v.as_str()) {
            git(dir, &["config", "--local", k, &v])?;
        }
    }
    Ok(())
}

/// Writes `text` to `path` unless it is exactly that already.
fn write_if_changed(path: &Path, text: &str) -> AppResult<()> {
    if std::fs::read(path).ok().as_deref() != Some(text.as_bytes()) {
        std::fs::write(path, text)?;
    }
    Ok(())
}

/// Makes the vault an encrypted repository. A `.git` already there is moved aside
/// (its new name is returned) because its history holds the notes in plain text; the
/// fresh repository starts with no commits and no remote, so nothing old can be sent.
pub fn enable_encryption_in(
    dir: &Path,
    key: &MasterKey,
    exe: &Path,
    now: DateTime<Local>,
) -> AppResult<Option<String>> {
    let old = dir.join(".git");
    let moved = if old.exists() {
        let stamp = now.format("%Y%m%d-%H%M%S").to_string();
        let mut name = format!("{MOVED_ASIDE}{stamp}");
        let mut n = 2;
        while dir.join(&name).exists() {
            name = format!("{MOVED_ASIDE}{stamp}-{n}");
            n += 1;
        }
        std::fs::rename(&old, dir.join(&name))?;
        Some(name)
    } else {
        None
    };
    init_in(dir)?;
    write_if_changed(&dir.join(".gitattributes"), GITATTRIBUTES)?;
    write_if_changed(&dir.join(CRYPT_FILE), &crypt_file_text(key))?;
    let ignore = dir.join(".gitignore");
    let text = std::fs::read_to_string(&ignore)?;
    if !text.lines().any(|l| l.trim() == MOVED_ASIDE_IGNORE) {
        let sep = if text.is_empty() || text.ends_with('\n') { "" } else { "\n" };
        std::fs::write(&ignore, format!("{text}{sep}{MOVED_ASIDE_IGNORE}\n"))?;
    }
    configure_filter(dir, exe)?;
    Ok(moved)
}

/// [`backup_with_exe`] with this program as the filter of an encrypted vault.
pub fn backup_in(dir: &Path, message: &str, key: Option<&MasterKey>) -> AppResult<BackupResult> {
    let exe = if crypt_state(dir).is_some() { std::env::current_exe()? } else { Default::default() };
    backup_with_exe(dir, message, key, &exe)
}

/// Commits everything changed, then (with a remote) brings in what other PCs sent
/// and sends this one's. A merge that would conflict is undone and reported, so
/// the notes on this PC are never left half-merged.
///
/// An encrypted vault fails closed: without this vault's key nothing is added, and a
/// remote that isn't this encrypted repository is never merged or pushed to. `exe` is
/// the `notevine` program Git runs as the filter, written again on every backup so a
/// moved or updated app keeps working.
pub fn backup_with_exe(dir: &Path, message: &str, key: Option<&MasterKey>, exe: &Path) -> AppResult<BackupResult> {
    if !is_repo(dir) {
        init_in(dir)?;
    }
    keep_line_endings(dir)?;
    let crypt = crypt_state(dir);
    if let Some(id) = &crypt {
        let Some(key) = key.filter(|k| key_matches(Some(k), id.as_deref())) else {
            return Err(AppError::System(NO_KEY.into()));
        };
        // The app owns these: a deleted or edited one must not let plain text through.
        write_if_changed(&dir.join(".gitattributes"), GITATTRIBUTES)?;
        write_if_changed(&dir.join(CRYPT_FILE), &crypt_file_text(key))?;
        configure_filter(dir, exe)?;
    }
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
        // Before any merge or push: the remote must be this same encrypted repository.
        if let Some(id) = &crypt {
            let theirs = git(dir, &["show", &format!("{remote_branch}:{CRYPT_FILE}")]).ok();
            if theirs.as_deref().and_then(crypt_file_key_id).is_none_or(|t| Some(t) != *id) {
                return Err(AppError::System(NOT_THIS_REPO.into()));
            }
        }
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

/// A `.git` that was already in the folder may have come with it, and its settings
/// can run commands in ways `-c` can't all rule out (filter drivers, credential
/// helpers...). So Git stays out of it until the user allows it on this PC.
fn require_trust(dir: &Path, trusted: bool) -> AppResult<()> {
    if is_repo(dir) && !trusted {
        return Err(AppError::System(
            "이 노트 폴더의 Git 저장소는 아직 허용하지 않았습니다. 설정 > 백업에서 확인해 주세요".into(),
        ));
    }
    Ok(())
}

pub fn status_for(dir: &Path, trusted: bool, key: Option<&MasterKey>) -> AppResult<BackupStatus> {
    if is_repo(dir) && !trusted {
        return Ok(BackupStatus { git: installed(), repo: true, ..Default::default() });
    }
    Ok(BackupStatus { trusted, ..status_with_key(dir, key)? })
}

pub fn init_for(dir: &Path, trusted: bool) -> AppResult<()> {
    require_trust(dir, trusted)?;
    init_in(dir)
}

pub fn set_remote_for(dir: &Path, trusted: bool, url: &str) -> AppResult<()> {
    require_trust(dir, trusted)?;
    set_remote_in(dir, url)
}

pub fn backup_for(dir: &Path, trusted: bool, message: &str, key: Option<&MasterKey>) -> AppResult<BackupResult> {
    require_trust(dir, trusted)?;
    backup_in(dir, message, key)
}

/// This PC's key. A key store that fails is an error only for an encrypted vault; Git
/// is asked whether it is one only in a repository the user allowed.
fn load_key(dir: &Path, trusted: bool) -> AppResult<Option<MasterKey>> {
    match crate::crypt_key::key_store().load() {
        Ok(k) => Ok(k),
        Err(e) if trusted && crypt_state(dir).is_some() => Err(e),
        Err(_) => Ok(None),
    }
}

fn is_trusted(state: &State<AppState>, dir: &Path) -> bool {
    state.trust.get(dir).git
}

/// The repository now is one the app made or was allowed into.
fn remember_trust(state: &State<AppState>, dir: &Path) -> AppResult<()> {
    if !is_trusted(state, dir) {
        state.trust.update(dir, |t| t.git = true)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn backup_status(state: State<'_, AppState>) -> AppResult<BackupStatus> {
    let dir = vault_root(&state)?;
    let trusted = is_trusted(&state, &dir);
    let key = load_key(&dir, trusted)?;
    status_for(&dir, trusted, key.as_ref())
}

/// The user allows Git in the `.git` that was already in this folder.
#[tauri::command]
pub async fn backup_trust(state: State<'_, AppState>) -> AppResult<BackupStatus> {
    let dir = vault_root(&state)?;
    remember_trust(&state, &dir)?;
    let key = load_key(&dir, true)?;
    status_for(&dir, true, key.as_ref())
}

#[tauri::command]
pub async fn backup_init(state: State<'_, AppState>) -> AppResult<()> {
    let dir = vault_root(&state)?;
    init_for(&dir, is_trusted(&state, &dir))?;
    remember_trust(&state, &dir)
}

#[tauri::command]
pub async fn backup_set_remote(state: State<'_, AppState>, url: String) -> AppResult<()> {
    let dir = vault_root(&state)?;
    set_remote_for(&dir, is_trusted(&state, &dir), &url)?;
    remember_trust(&state, &dir)
}

#[tauri::command]
pub async fn backup_now(state: State<'_, AppState>, message: String) -> AppResult<BackupResult> {
    let dir = vault_root(&state)?;
    let trusted = is_trusted(&state, &dir);
    let key = load_key(&dir, trusted)?;
    let r = backup_for(&dir, trusted, &message, key.as_ref())?;
    remember_trust(&state, &dir)?;
    Ok(r)
}

/// Turns encryption on for the vault with this PC's key; returns the name the old
/// repository was moved to, if there was one.
#[tauri::command]
pub async fn backup_enable_encryption(state: State<'_, AppState>) -> AppResult<Option<String>> {
    let dir = vault_root(&state)?;
    let key = crate::crypt_key::key_store().load()?.ok_or_else(|| {
        AppError::System("이 PC에 암호화 열쇠가 없습니다. 먼저 열쇠를 만들거나 복구 코드를 넣어 주세요".into())
    })?;
    let exe = std::env::current_exe()?;
    let moved = enable_encryption_in(&dir, &key, &exe, Local::now())?;
    // The repository there now is the one the app just made.
    remember_trust(&state, &dir)?;
    Ok(moved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A received folder whose `.git` runs commands: `core.fsmonitor` on any status,
    /// a pre-commit hook on commit. Each leaves a marker file in the folder if it ran.
    fn booby_trapped_repo(dir: &Path) {
        git(dir, &["init", "-q", "-b", "main"]).unwrap();
        git(dir, &["config", "user.name", "x"]).unwrap();
        git(dir, &["config", "user.email", "x@x"]).unwrap();
        fs::write(dir.join("a.md"), "a\n").unwrap();
        git(dir, &["add", "-A"]).unwrap();
        git(dir, &["commit", "-q", "-m", "first"]).unwrap();
        git(dir, &["config", "core.fsmonitor", "echo ran > fsmonitor-ran #"]).unwrap();
        fs::write(dir.join(".git/hooks/pre-commit"), "#!/bin/sh\necho ran > hook-ran\n").unwrap();
    }

    #[test]
    fn a_repository_cannot_run_commands_through_fsmonitor_or_hooks() {
        if !installed() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        booby_trapped_repo(tmp.path());
        fs::write(tmp.path().join("a.md"), "b\n").unwrap();
        status_in(tmp.path()).unwrap();
        assert!(!tmp.path().join("fsmonitor-ran").exists(), "core.fsmonitor ran");
        backup_in(tmp.path(), "백업", None).unwrap();
        assert!(!tmp.path().join("hook-ran").exists(), "pre-commit hook ran");
    }

    #[test]
    fn an_untrusted_repository_is_not_touched_by_git() {
        if !installed() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        booby_trapped_repo(tmp.path());
        // Someone's own folder config can't be undone by -c alone: filter drivers run too.
        git(tmp.path(), &["config", "filter.x.clean", "echo ran > filter-ran #"]).unwrap();
        fs::write(tmp.path().join(".gitattributes"), "*.md filter=x\n").unwrap();
        fs::write(tmp.path().join("a.md"), "b\n").unwrap();

        let s = status_for(tmp.path(), false, None).unwrap();
        assert!(s.repo && !s.trusted);
        assert_eq!((s.changed, s.branch.clone()), (0, None), "git was not asked");
        assert!(backup_for(tmp.path(), false, "백업", None).is_err());
        assert!(set_remote_for(tmp.path(), false, "https://example.com/x.git").is_err());
        assert!(!tmp.path().join("filter-ran").exists());
    }

    #[test]
    fn a_folder_without_a_repository_can_start_one() {
        if !installed() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let s = status_for(tmp.path(), false, None).unwrap();
        assert!(!s.repo && !s.trusted);
        init_for(tmp.path(), false).unwrap();
        assert!(status_for(tmp.path(), true, None).unwrap().trusted);
    }

    #[test]
    fn init_does_not_adopt_a_repository_that_was_already_there() {
        if !installed() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        booby_trapped_repo(tmp.path());
        assert!(init_for(tmp.path(), false).is_err());
    }

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
        let r = backup_in(&a, "백업 1", None).unwrap();
        assert!(r.committed && r.pushed && !r.pulled);
        assert_eq!(r.files, 2);
        assert_eq!(backup_in(&a, "그대로", None).unwrap(), BackupResult::default());

        // A second PC gets the notes, adds one, and sends it back.
        let b = tmp.path().join("b");
        git(tmp.path(), &["clone", "-q", &url, "b"]).unwrap();
        git(&b, &["config", "user.name", "b"]).unwrap();
        git(&b, &["config", "user.email", "b@x"]).unwrap();
        keep_line_endings(&b).unwrap();
        assert!(b.join("회의.md").exists());
        fs::write(b.join("아이디어.md"), "새 생각\n").unwrap();
        assert!(backup_in(&b, "B", None).unwrap().pushed);

        fs::write(a.join("할 일.md"), "- 질의서\n").unwrap();
        let r = backup_in(&a, "백업 2", None).unwrap();
        assert!(r.committed && r.pulled && r.pushed);
        assert!(a.join("아이디어.md").exists());
        let s = status_in(&a).unwrap();
        assert_eq!((s.changed, s.ahead, s.behind), (0, 0, 0));
        assert!(s.last_at.is_some() && s.last_message.is_some());

        // Both change the same line: nothing is half-merged and the reason is given.
        fs::write(b.join("회의.md"), "# 회의 B\n").unwrap();
        git(&b, &["pull", "-q", "--no-rebase"]).unwrap();
        backup_in(&b, "B2", None).unwrap();
        fs::write(a.join("회의.md"), "# 회의 A\n").unwrap();
        let e = backup_in(&a, "A2", None).unwrap_err().to_string();
        assert!(e.contains("회의.md"), "{e}");
        assert_eq!(fs::read_to_string(a.join("회의.md")).unwrap(), "# 회의 A\n");
        assert!(!a.join(".git/MERGE_HEAD").exists());
    }
}
