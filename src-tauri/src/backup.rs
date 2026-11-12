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
/.gitattributes !filter !diff !merge
/.gitignore !filter !diff !merge
/.notevine-crypt !filter !diff !merge
";

/// The only paths an encrypted vault commits as they are (all at the root).
const PLAIN_FILES: [&str; 3] = [".gitattributes", ".gitignore", CRYPT_FILE];

/// Where `enable_encryption_in` puts the old repository. It holds plain history, so
/// it never goes into the new one.
const MOVED_ASIDE: &str = ".git-before-encryption-";
const MOVED_ASIDE_IGNORE: &str = "/.git-before-encryption-*/";

const NO_KEY: &str = "이 PC에 이 노트 폴더의 암호화 열쇠가 없습니다. 설정 > 백업에서 복구 코드를 넣어 주세요";
const NOT_THIS_REPO: &str =
    "원격 저장소가 이 암호화 저장소가 아닙니다(평문 이력이거나 다른 열쇠). 새 빈 저장소를 만들어 주소를 넣어 주세요";
const ENCRYPTED_REMOTE: &str = "원격 저장소가 암호화 저장소입니다. 이 노트 폴더도 암호화를 켠 뒤 백업하세요";

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
    /// Why backups of this vault can't run now (an encrypted vault without its key, or
    /// Git failing to read the vault), to tell the user instead of skipping silently.
    pub problem: Option<String>,
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
    /// An encrypted vault has no remote, so nothing was sent anywhere. (A plain vault
    /// may be kept local on purpose, so it never sets this.)
    pub remote_missing: bool,
}

fn git(dir: &Path, args: &[&str]) -> AppResult<String> {
    let out = git_bytes(dir, args, None)?;
    Ok(String::from_utf8_lossy(&out).trim_end().to_string())
}

/// [`git`] with `input` on stdin (none: stdin is closed) and stdout as it is.
fn git_bytes(dir: &Path, args: &[&str], input: Option<&[u8]>) -> AppResult<Vec<u8>> {
    use std::process::Stdio;
    let mut c = Command::new("git");
    // Korean file names as they are, not as "í…".
    c.args(["-c", "core.quotepath=false"])
        // A repository's own settings must not run commands (a backup never needs them).
        .args(["-c", "core.fsmonitor=false", "-c", NO_HOOKS, "-c", "protocol.ext.allow=never"])
        .args(args)
        .current_dir(dir)
        // Never wait for a password typed in a console nobody sees.
        .env("GIT_TERMINAL_PROMPT", "0")
        // `refs/replace/*` must not make Git show one object in place of another: what
        // is checked has to be exactly what a push sends.
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("LC_ALL", "C")
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = c.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::System("Git이 설치되어 있지 않습니다. https://git-scm.com 에서 설치해 주세요".into())
        } else {
            AppError::Io(e)
        }
    })?;
    // From another thread: Git may fill stdout before it has read all of stdin.
    let writer = match (input, child.stdin.take()) {
        (Some(data), Some(mut stdin)) => {
            let data = data.to_vec();
            Some(std::thread::spawn(move || std::io::Write::write_all(&mut stdin, &data)))
        }
        _ => None,
    };
    let out = child.wait_with_output()?;
    let wrote = writer.map(|w| w.join());
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let err = if err.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { err };
        return Err(AppError::System(explain(&err)));
    }
    if let Some(wrote) = wrote {
        wrote.map_err(|_| AppError::System("Git에 입력을 넘기지 못했습니다".into()))??;
    }
    Ok(out.stdout)
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
    } else if lower.contains("refusing to merge unrelated histories") {
        "원격 저장소의 기록이 이 노트 폴더와 관련이 없습니다. 원격 저장소 주소를 확인해 주세요"
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
        if !s.key_ok {
            s.problem = Some(NO_KEY.into());
        }
    }
    s.branch = git(dir, &["rev-parse", "--abbrev-ref", "HEAD"]).ok().filter(|b| b != "HEAD");
    s.remote = git(dir, &["remote", "get-url", "origin"]).ok().filter(|r| !r.is_empty());
    // Without the key (or with a filter Git can't start) Git may not say how many
    // changed; the reason goes to `problem` so a timed backup doesn't stop silently.
    s.changed = match git(dir, &["status", "--porcelain", "-uall"]) {
        Ok(out) => out.lines().count() as u32,
        Err(e) if s.encrypted => {
            s.problem.get_or_insert(e.to_string());
            0
        }
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
    let old = if has { git(dir, &["remote", "get-url", "origin"]).ok() } else { None };
    match (has, url.is_empty()) {
        (true, true) => git(dir, &["remote", "remove", "origin"]).map(drop),
        (true, false) => git(dir, &["remote", "set-url", "origin", url]).map(drop),
        (false, false) => git(dir, &["remote", "add", "origin", url]).map(drop),
        (false, true) => Ok(()),
    }?;
    if old.as_deref() != Some(url) {
        forget_remote_branches(dir)?;
    }
    Ok(())
}

/// Drops what was fetched from an earlier `origin`: a corrected address must not be
/// judged by the branches of the wrong one.
fn forget_remote_branches(dir: &Path) -> AppResult<()> {
    let refs = git(dir, &["for-each-ref", "--format=%(refname)", "refs/remotes/origin"])?;
    for r in refs.lines().filter(|r| !r.is_empty()) {
        // `--no-deref`: `origin/HEAD` itself, not the branch it points at.
        git(dir, &["update-ref", "--no-deref", "-d", r])?;
    }
    Ok(())
}

/// Registers `notevine` as the repository's filter, diff text converter and merge
/// driver. `exe` is written with `/` and in single quotes, so Git's shell takes it as
/// it is (no `$` or backtick expansion).
fn configure_filter(dir: &Path, exe: &Path) -> AppResult<()> {
    let exe = exe.to_string_lossy().replace('\\', "/");
    if exe.is_empty() || exe.contains('\'') {
        return Err(AppError::System(format!("Notevine 실행 파일 경로를 Git에 넣을 수 없습니다: {exe}")));
    }
    let exe = format!("'{exe}'");
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

/// Writes this program into an encrypted vault's filter config again (nothing for a
/// plain vault), so a moved or updated app keeps working before the next backup.
pub fn refresh_filter(dir: &Path, exe: &Path) -> AppResult<()> {
    if crypt_state(dir).is_some() { configure_filter(dir, exe) } else { Ok(()) }
}

/// Receives the repository at `url` into `dest` (not there yet, or an empty folder).
/// An encrypted repository is checked against `key` before anything is checked out,
/// then checked out through the filter so the notes arrive as plain text. On any
/// error `dest` is left as it was found: gone, or empty again.
pub fn clone_in(url: &str, dest: &Path, key: Option<&MasterKey>, exe: &Path) -> AppResult<()> {
    let url = url.trim();
    if url.is_empty() {
        return Err(AppError::System("저장소 주소를 넣어 주세요".into()));
    }
    if !dest.is_absolute() {
        return Err(AppError::System("받을 폴더는 전체 경로로 주세요".into()));
    }
    let existed = dest.exists();
    if existed && !std::fs::read_dir(dest).is_ok_and(|mut d| d.next().is_none()) {
        return Err(AppError::System("받을 폴더가 비어 있지 않습니다".into()));
    }
    let Err(first) = clone_into(url, dest, key, exe) else {
        return Ok(());
    };
    let cleaned: std::io::Result<()> = if existed {
        // Back to the empty folder it was.
        std::fs::read_dir(dest).and_then(|rd| {
            for e in rd {
                let p = e?.path();
                if p.is_dir() { std::fs::remove_dir_all(&p)? } else { std::fs::remove_file(&p)? }
            }
            Ok(())
        })
    } else {
        std::fs::remove_dir_all(dest).or_else(|e| if dest.exists() { Err(e) } else { Ok(()) })
    };
    match cleaned {
        Ok(()) => Err(first),
        Err(_) => Err(AppError::System(format!("{first}. 받다 만 폴더를 지우지 못했습니다: {}", dest.display()))),
    }
}

/// Any branch of `origin` fetched into this repository (not counting `origin/HEAD`).
fn has_remote_branches(dir: &Path) -> AppResult<bool> {
    let refs = git(dir, &["for-each-ref", "--format=%(refname)", "refs/remotes"])?;
    Ok(refs.lines().any(|r| !r.is_empty() && !r.ends_with("/HEAD")))
}

fn clone_into(url: &str, dest: &Path, key: Option<&MasterKey>, exe: &Path) -> AppResult<()> {
    let parent = match dest.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    std::fs::create_dir_all(parent)?;
    let dest_arg = dest.to_string_lossy();
    git(parent, &["clone", "-q", "--no-checkout", "--", url, &dest_arg])?;

    // Empty only if the remote has no branches at all. Branches but an unborn HEAD
    // (the remote's default branch is another name) must never pass as an empty remote.
    let has_head = git(dest, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok();
    if !has_head && has_remote_branches(dest)? {
        return Err(AppError::System("원격 저장소의 기본 브랜치를 찾지 못했습니다".into()));
    }
    let encrypted = has_head && !git(dest, &["ls-tree", "HEAD", "--", CRYPT_FILE])?.is_empty();
    if encrypted {
        let text = git(dest, &["show", &format!("HEAD:{CRYPT_FILE}")])?;
        if !key_matches(key, crypt_file_key_id(&text).as_deref()) {
            return Err(AppError::System(
                "이 저장소의 암호화 열쇠가 이 PC에 없습니다. 복구 코드를 먼저 넣어 주세요".into(),
            ));
        }
    }
    keep_line_endings(dest)?;
    if encrypted {
        configure_filter(dest, exe)?;
    }
    if git(dest, &["config", "user.name"]).is_err() {
        git(dest, &["config", "user.name", "Notevine"])?;
    }
    if git(dest, &["config", "user.email"]).is_err() {
        git(dest, &["config", "user.email", "notevine@localhost"])?;
    }
    if has_head {
        // For an encrypted repository the smudge filter decrypts on the way out.
        git(dest, &["reset", "-q", "--hard", "HEAD"])?;
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

/// The `origin` address of a repository that has no commits of its own, so nothing in
/// it can be plain history. Read from its files only (it may not be allowed yet).
fn remote_of_empty_repo(git_dir: &Path) -> Option<String> {
    fn has_files(dir: &Path) -> bool {
        std::fs::read_dir(dir)
            .map(|d| d.flatten().any(|e| if e.path().is_dir() { has_files(&e.path()) } else { true }))
            .unwrap_or(false)
    }
    if has_files(&git_dir.join("refs").join("heads")) {
        return None;
    }
    if std::fs::read_to_string(git_dir.join("packed-refs")).is_ok_and(|t| t.contains(" refs/heads/")) {
        return None;
    }
    let config = std::fs::read_to_string(git_dir.join("config")).ok()?;
    let mut in_origin = false;
    for line in config.lines().map(str::trim) {
        if line.starts_with('[') {
            in_origin = line.replace(' ', "").eq_ignore_ascii_case("[remote\"origin\"]");
        } else if in_origin
            && let Some((k, v)) = line.split_once('=')
            && k.trim().eq_ignore_ascii_case("url")
            && !v.trim().is_empty()
        {
            return Some(v.trim().trim_matches('"').to_string());
        }
    }
    None
}

/// Makes the vault an encrypted repository. A `.git` already there is moved aside
/// (its new name is returned) because its history holds the notes in plain text; the
/// fresh repository starts with no commits. Its remote is not carried over, except the
/// address of a repository that had no commits (nothing plain to send, and a backup
/// still refuses a remote that isn't this encrypted repository).
pub fn enable_encryption_in(
    dir: &Path,
    key: &MasterKey,
    exe: &Path,
    now: DateTime<Local>,
) -> AppResult<Option<String>> {
    let old = dir.join(".git");
    // Read from the file only: the repository may not be one the user allowed yet.
    let marked = std::fs::read_to_string(dir.join(CRYPT_FILE)).ok();
    if old.exists() && marked.as_deref().and_then(crypt_file_key_id).is_some_and(|id| id == key_id(key)) {
        return Err(AppError::System("이미 암호화된 노트 폴더입니다".into()));
    }
    let kept_remote = if old.is_dir() { remote_of_empty_repo(&old) } else { None };
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
    // Encrypted from here on, even if a later step fails: the next backup sees the
    // marker and the filter config and refuses to commit plain text.
    write_if_changed(&dir.join(CRYPT_FILE), &crypt_file_text(key))?;
    configure_filter(dir, exe)?;
    write_if_changed(&dir.join(".gitattributes"), GITATTRIBUTES)?;
    ignore_moved_aside(dir)?;
    if let Some(url) = kept_remote {
        set_remote_in(dir, &url)?;
    }
    Ok(moved)
}

/// Keeps moved-aside repositories (plain history) out of the backup.
fn ignore_moved_aside(dir: &Path) -> AppResult<()> {
    let ignore = dir.join(".gitignore");
    let text = match std::fs::read_to_string(&ignore) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => GITIGNORE.to_string(),
        Err(e) => return Err(e.into()),
    };
    if !text.lines().any(|l| l.trim() == MOVED_ASIDE_IGNORE) {
        let sep = if text.is_empty() || text.ends_with('\n') { "" } else { "\n" };
        std::fs::write(&ignore, format!("{text}{sep}{MOVED_ASIDE_IGNORE}\n"))?;
    }
    Ok(())
}

/// Every staged path except the three root files must go through the notevine filter.
/// A `.gitattributes` in a subfolder (or `.git/info/attributes`) can switch it off or
/// name a filter that isn't defined, and Git would then stage the note as it is.
fn unencrypted_staged(dir: &Path) -> AppResult<Vec<String>> {
    let files = git_bytes(dir, &["ls-files", "-z"], None)?;
    if files.is_empty() {
        return Ok(Vec::new());
    }
    let out = git_bytes(dir, &["check-attr", "-z", "--stdin", "filter"], Some(&files))?;
    let out = String::from_utf8_lossy(&out);
    // `<path> NUL filter NUL <value> NUL`, once per path.
    let fields: Vec<&str> = out.split('\0').collect();
    let mut bad = Vec::new();
    for rec in fields.chunks(3) {
        if let [path, _, value] = rec
            && *value != "notevine"
            && !PLAIN_FILES.contains(path)
        {
            bad.push(path.to_string());
        }
    }
    let listed = String::from_utf8_lossy(&files).split('\0').filter(|p| !p.is_empty()).count();
    if fields.len() / 3 < listed {
        return Err(AppError::System("Git이 파일의 암호화 설정을 알려 주지 않았습니다".into()));
    }
    Ok(bad)
}

/// Paths staged as a symlink or a submodule (gitlink). Git stores those as they are
/// (a link target, a commit id), never through the filter.
fn links_staged(dir: &Path) -> AppResult<Vec<String>> {
    let out = git_bytes(dir, &["ls-files", "-s", "-z"], None)?;
    let out = String::from_utf8_lossy(&out);
    let mut bad = Vec::new();
    // `<mode> <id> <stage>\t<path>` per entry.
    for rec in out.split('\0').filter(|r| !r.is_empty()) {
        let Some((meta, path)) = rec.split_once('\t') else {
            return Err(AppError::System("Git이 백업할 파일 목록을 알려 주지 않았습니다".into()));
        };
        let mode = meta.split(' ').next().unwrap_or_default();
        if mode == "120000" || mode == "160000" {
            bad.push(path.to_string());
        }
    }
    Ok(bad)
}

/// Any fetched branch of `origin` (not `origin/HEAD`) with `.notevine-crypt` at its tip.
/// A branch Git can't answer for counts as encrypted (fail closed).
fn remote_has_encrypted_branch(dir: &Path) -> AppResult<bool> {
    let refs = git(dir, &["for-each-ref", "--format=%(refname)", "refs/remotes/origin"])?;
    for r in refs.lines().filter(|r| !r.is_empty() && *r != "refs/remotes/origin/HEAD") {
        match git(dir, &["ls-tree", "--name-only", r, "--", CRYPT_FILE]) {
            Ok(out) if out.is_empty() => {}
            _ => return Ok(true),
        }
    }
    Ok(false)
}

/// Objects read from `cat-file --batch` at most this much at a time.
const OUTGOING_CHUNK: u64 = 32 << 20;

/// Paths of what a push would send that isn't encrypted: every new blob except the
/// three root files must be ciphertext that `key` opens, and no new tree may hold a
/// symlink or a submodule (gitlink). Anything Git can't account for is an error.
fn unencrypted_outgoing(dir: &Path, key: &MasterKey) -> AppResult<Vec<String>> {
    let unsure = || AppError::System("원격으로 보낼 백업을 확인하지 못해 보내지 않았습니다".into());
    let list = git(dir, &["rev-list", "--objects", "HEAD", "--not", "--remotes=origin"])?;
    // `<id>` for a commit, `<id> <path>` for a tree or blob (the root tree: empty path).
    let objects: Vec<(&str, &str)> =
        list.lines().filter(|l| !l.is_empty()).map(|l| l.split_once(' ').unwrap_or((l, ""))).collect();
    if objects.is_empty() {
        return Ok(Vec::new());
    }
    let ids = objects.iter().map(|(id, _)| *id).collect::<Vec<_>>().join("\n") + "\n";
    let types = git_bytes(dir, &["cat-file", "--batch-check"], Some(ids.as_bytes()))?;
    let types = String::from_utf8_lossy(&types);
    let types: Vec<&str> = types.lines().collect();
    if types.len() != objects.len() {
        return Err(unsure());
    }
    // (id, path, is a tree) of the objects to read, in chunks.
    let mut chunks: Vec<Vec<(&str, &str, bool)>> = vec![Vec::new()];
    let mut size = 0u64;
    for ((id, path), line) in objects.iter().zip(&types) {
        let mut f = line.split(' ');
        let (Some(got), Some(kind), Some(len)) = (f.next(), f.next(), f.next().and_then(|n| n.parse::<u64>().ok()))
        else {
            return Err(unsure());
        };
        if got != *id {
            return Err(unsure());
        }
        let tree = match kind {
            "commit" => continue,
            "blob" if PLAIN_FILES.contains(path) => continue,
            "blob" => false,
            "tree" => true,
            _ => return Err(unsure()),
        };
        if size + len > OUTGOING_CHUNK && chunks.last().is_some_and(|c| !c.is_empty()) {
            chunks.push(Vec::new());
            size = 0;
        }
        size += len;
        if let Some(c) = chunks.last_mut() {
            c.push((*id, *path, tree));
        }
    }
    let mut bad = Vec::new();
    for chunk in chunks.iter().filter(|c| !c.is_empty()) {
        let input = chunk.iter().map(|(id, _, _)| *id).collect::<Vec<_>>().join("\n") + "\n";
        let out = git_bytes(dir, &["cat-file", "--batch"], Some(input.as_bytes()))?;
        let mut rest = out.as_slice();
        for (id, path, tree) in chunk {
            // `<id> <type> <size>\n<content>\n`
            let nl = rest.iter().position(|&b| b == b'\n').ok_or_else(unsure)?;
            let header = String::from_utf8_lossy(&rest[..nl]).to_string();
            let mut f = header.split(' ');
            let (Some(got), Some(_), Some(len)) = (f.next(), f.next(), f.next().and_then(|n| n.parse::<usize>().ok()))
            else {
                return Err(unsure());
            };
            if got != *id || rest.len() < nl + 1 + len + 1 {
                return Err(unsure());
            }
            let content = &rest[nl + 1..nl + 1 + len];
            rest = &rest[nl + 1 + len + 1..];
            if !*tree {
                // Decrypting also proves the header's key id and the content are this key's.
                if crate::crypt::decrypt(key, content).is_err() {
                    bad.push(path.to_string());
                }
                continue;
            }
            // Raw tree: `<mode> <name>\0<hash>` per entry; the hash is as long as the id says.
            let hash_len = id.len() / 2;
            let mut t = content;
            while !t.is_empty() {
                let sp = t.iter().position(|&b| b == b' ').ok_or_else(unsure)?;
                let nul = t.iter().position(|&b| b == 0).ok_or_else(unsure)?;
                if nul < sp || t.len() < nul + 1 + hash_len {
                    return Err(unsure());
                }
                let mode = &t[..sp];
                if mode == b"120000" || mode == b"160000" {
                    let name = String::from_utf8_lossy(&t[sp + 1..nul]);
                    bad.push(if path.is_empty() { name.to_string() } else { format!("{path}/{name}") });
                }
                t = &t[nul + 1 + hash_len..];
            }
        }
    }
    Ok(bad)
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
    // This vault's key (only for an encrypted vault).
    let mut vault_key = None;
    if let Some(id) = &crypt {
        let Some(key) = key.filter(|k| key_matches(Some(k), id.as_deref())) else {
            return Err(AppError::System(NO_KEY.into()));
        };
        vault_key = Some(key);
        // The app owns these: a deleted or edited one must not let plain text through.
        write_if_changed(&dir.join(".gitattributes"), GITATTRIBUTES)?;
        write_if_changed(&dir.join(CRYPT_FILE), &crypt_file_text(key))?;
        ignore_moved_aside(dir)?;
        configure_filter(dir, exe)?;
    }
    let mut r = BackupResult::default();
    git(dir, &["add", "-A"])?;
    if crypt.is_some() {
        let links = links_staged(dir).inspect_err(|_| {
            let _ = git(dir, &["reset", "-q"]);
        })?;
        if !links.is_empty() {
            let _ = git(dir, &["reset", "-q"]);
            let paths = links.iter().take(5).map(String::as_str).collect::<Vec<_>>().join(", ");
            return Err(AppError::System(format!(
                "하위 폴더/파일 {paths}는 Git 저장소(또는 링크)라 암호화 백업할 수 없습니다. 노트 폴더 밖으로 옮기거나 .gitignore에 넣으세요"
            )));
        }
        let bad = unencrypted_staged(dir).inspect_err(|_| {
            let _ = git(dir, &["reset", "-q"]);
        })?;
        if !bad.is_empty() {
            let _ = git(dir, &["reset", "-q"]);
            let paths = bad.iter().take(5).map(String::as_str).collect::<Vec<_>>().join(", ");
            return Err(AppError::System(format!(
                "암호화되지 않는 파일이 있어 백업을 멈췄습니다: {paths}. 하위 폴더의 .gitattributes 등이 암호화를 끄고 있습니다"
            )));
        }
    }
    let staged = git(dir, &["diff", "--cached", "--name-only"])?;
    r.files = staged.lines().filter(|l| !l.is_empty()).count() as u32;
    if r.files > 0 {
        git(dir, &["commit", "-q", "-m", message])?;
        r.committed = true;
    }
    if git(dir, &["remote", "get-url", "origin"]).is_err() {
        r.remote_missing = crypt.is_some();
        return Ok(r);
    }
    let branch = git(dir, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    // `--prune`: branches deleted there (or from a corrected address) don't linger here.
    // Every branch, whatever `remote.origin.fetch` says (a single-branch clone fetches
    // only its own), so an encrypted branch of another name is always seen.
    git(dir, &["fetch", "-q", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*"])?;
    if crypt.is_none() && remote_has_encrypted_branch(dir)? {
        // A plain vault never merges from or sends to an encrypted repository.
        return Err(AppError::System(ENCRYPTED_REMOTE.into()));
    }
    let remote_branch = format!("origin/{branch}");
    if crypt.is_some()
        && git(dir, &["rev-parse", "--verify", "-q", &remote_branch]).is_err()
        && has_remote_branches(dir)?
    {
        // The remote holds other branches but not ours: not this encrypted repository.
        return Err(AppError::System(NOT_THIS_REPO.into()));
    }
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
        if let Some(key) = vault_key {
            // The last word on what leaves this PC, whatever made the commits.
            let bad = unencrypted_outgoing(dir, key)?;
            if !bad.is_empty() {
                let paths = bad.iter().take(5).map(String::as_str).collect::<Vec<_>>().join(", ");
                return Err(AppError::System(format!(
                    "원격으로 보낼 백업에 암호화되지 않은 내용이 있어 보내지 않았습니다: {paths}"
                )));
            }
        }
        // Only the branch: an annotated tag (its message is plain text) never goes along.
        git(dir, &["-c", "push.followTags=false", "push", "--no-follow-tags", "-q", "-u", "origin", &branch])?;
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

/// This PC's key, read only for an encrypted vault (a plain one never touches the
/// credential store). Git is asked whether it is one only in a repository the user allowed.
fn load_key(dir: &Path, trusted: bool) -> AppResult<Option<MasterKey>> {
    if !trusted || crypt_state(dir).is_none() {
        return Ok(None);
    }
    crate::crypt_key::key_store().load()
}

/// Status for the commands: an encrypted vault's filter path is written again first,
/// so a moved app doesn't leave Git unable to read the vault.
fn status_now(dir: &Path, trusted: bool) -> AppResult<BackupStatus> {
    let refreshed = if trusted && is_repo(dir) {
        std::env::current_exe().map_err(AppError::from).and_then(|exe| refresh_filter(dir, &exe))
    } else {
        Ok(())
    };
    let key = load_key(dir, trusted)?;
    let mut s = status_for(dir, trusted, key.as_ref())?;
    if let Err(e) = refreshed
        && s.encrypted
    {
        s.problem.get_or_insert(e.to_string());
    }
    Ok(s)
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
    status_now(&dir, is_trusted(&state, &dir))
}

/// The user allows Git in the `.git` that was already in this folder.
#[tauri::command]
pub async fn backup_trust(state: State<'_, AppState>) -> AppResult<BackupStatus> {
    let dir = vault_root(&state)?;
    remember_trust(&state, &dir)?;
    status_now(&dir, true)
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

/// Receives a Git repository into a new folder (decrypting an encrypted one); returns
/// the folder for the front end to open.
#[tauri::command]
pub async fn backup_clone(state: State<'_, AppState>, url: String, dest: String) -> AppResult<String> {
    let key = crate::crypt_key::key_store().load()?;
    let exe = std::env::current_exe()?;
    let dest_path = std::path::PathBuf::from(&dest);
    clone_in(&url, &dest_path, key.as_ref(), &exe)?;
    // The same spelling the vault code uses, so the trust entry matches when it opens.
    let dest_path = crate::vault::canonical_root(&dest_path)?;
    remember_trust(&state, &dest_path)?;
    Ok(dest_path.to_string_lossy().into_owned())
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
    fn unrelated_histories_are_explained_in_korean() {
        assert_eq!(
            explain("fatal: refusing to merge unrelated histories"),
            "원격 저장소의 기록이 이 노트 폴더와 관련이 없습니다. 원격 저장소 주소를 확인해 주세요 (Git: fatal: refusing to merge unrelated histories)"
        );
    }

    #[test]
    fn the_filter_path_is_single_quoted_for_the_shell() {
        if !installed() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        git(tmp.path(), &["init", "-q"]).unwrap();
        configure_filter(tmp.path(), Path::new(r#"C:\a $b`c"\notevine.exe"#)).unwrap();
        assert_eq!(
            git(tmp.path(), &["config", "--local", "--get", "filter.notevine.process"]).unwrap(),
            r#"'C:/a $b`c"/notevine.exe' --git-filter"#
        );
        assert!(configure_filter(tmp.path(), Path::new(r"C:\it's\notevine.exe")).is_err());
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
