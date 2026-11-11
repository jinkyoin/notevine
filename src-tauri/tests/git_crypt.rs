//! Encrypted Git backup end to end: Git runs the real `notevine` executable as its
//! filter and merge driver, so these live here (only integration tests get its path).
//!
//! The filter child process finds its key through `NOTEVINE_KEY_STORE=test` and
//! `NOTEVINE_TEST_KEY` (debug builds only), so every test holds one lock while those
//! variables are set.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, MutexGuard};

use chrono::{DateTime, Local, TimeZone};
use notevine_lib::backup::{
    backup_in, backup_with_exe, clone_in, enable_encryption_in, init_in, refresh_filter, set_remote_in, status_with_key,
};
use notevine_lib::crypt::{CRYPT_FILE, MasterKey, crypt_file_text, recovery_code};

const NO_KEY: &str = "이 PC에 이 노트 폴더의 암호화 열쇠가 없습니다. 설정 > 백업에서 복구 코드를 넣어 주세요";
const NOT_THIS_REPO: &str =
    "원격 저장소가 이 암호화 저장소가 아닙니다(평문 이력이거나 다른 열쇠). 새 빈 저장소를 만들어 주소를 넣어 주세요";
const GITATTRIBUTES: &str = "# Notevine: 이 노트 폴더는 원격에 암호화되어 올라갑니다
* filter=notevine diff=notevine merge=notevine -text
/.gitattributes !filter !diff !merge
/.gitignore !filter !diff !merge
/.notevine-crypt !filter !diff !merge
";

static ENV_LOCK: Mutex<()> = Mutex::new(());

/// Holds the lock and the key variables for the filter child; clears them when dropped.
struct KeyEnv(#[allow(dead_code)] MutexGuard<'static, ()>);

impl KeyEnv {
    /// `None`: the test key store with no key in it (never the real OS store).
    fn new(key: Option<&MasterKey>) -> KeyEnv {
        let g = KeyEnv(ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner()));
        // SAFETY: every test in this binary that sets or reads these variables (or runs
        // Git, whose children read them) holds ENV_LOCK, so no other thread touches them.
        unsafe {
            std::env::set_var("NOTEVINE_KEY_STORE", "test");
            match key {
                Some(k) => std::env::set_var("NOTEVINE_TEST_KEY", recovery_code(k)),
                None => std::env::remove_var("NOTEVINE_TEST_KEY"),
            }
        }
        g
    }
}

impl Drop for KeyEnv {
    fn drop(&mut self) {
        // SAFETY: still holding ENV_LOCK (the guard field drops after this body).
        unsafe {
            std::env::remove_var("NOTEVINE_TEST_KEY");
            std::env::remove_var("NOTEVINE_KEY_STORE");
        }
    }
}

fn exe() -> &'static Path {
    Path::new(env!("CARGO_BIN_EXE_notevine"))
}

fn git_raw(dir: &Path, args: &[&str]) -> std::process::Output {
    Command::new("git")
        .args(["-c", "core.quotepath=false"])
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("git runs")
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = git_raw(dir, args);
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim_end().to_string()
}

fn installed() -> bool {
    Command::new("git").arg("--version").output().is_ok_and(|o| o.status.success())
}

fn bare_remote(root: &Path) -> String {
    let remote = root.join("remote.git");
    std::fs::create_dir(&remote).unwrap();
    git(&remote, &["init", "-q", "--bare", "-b", "main"]);
    remote.to_string_lossy().to_string()
}

fn now() -> DateTime<Local> {
    Local.with_ymd_and_hms(2026, 11, 11, 9, 8, 7).unwrap()
}

fn vault(root: &Path, name: &str) -> PathBuf {
    let d = root.join(name);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// A second PC: clones with the filter already set so checkout decrypts.
fn clone_encrypted(root: &Path, url: &str, name: &str) -> PathBuf {
    let exe = format!("\"{}\"", exe().to_string_lossy().replace('\\', "/"));
    let process = format!("filter.notevine.process={exe} --git-filter");
    git(
        root,
        &[
            "-c",
            &process,
            "-c",
            "filter.notevine.required=true",
            "clone",
            "-q",
            "-c",
            "core.autocrlf=false",
            "-c",
            &process,
            "-c",
            "filter.notevine.required=true",
            url,
            name,
        ],
    );
    let d = root.join(name);
    git(&d, &["config", "user.name", "b"]);
    git(&d, &["config", "user.email", "b@x"]);
    d
}

fn read(p: &Path) -> String {
    std::fs::read_to_string(p).unwrap()
}

#[test]
fn remote_holds_only_ciphertext() {
    if !installed() {
        return;
    }
    let key = MasterKey::generate();
    let _env = KeyEnv::new(Some(&key));
    let tmp = tempfile::tempdir().unwrap();
    let url = bare_remote(tmp.path());
    let a = vault(tmp.path(), "a");
    std::fs::write(a.join("회의.md"), "예산 확정\n").unwrap();

    assert_eq!(enable_encryption_in(&a, &key, exe(), now()).unwrap(), None);
    set_remote_in(&a, &url).unwrap();
    let r = backup_with_exe(&a, "백업", Some(&key), exe()).unwrap();
    assert!(r.committed && r.pushed, "{r:?}");

    let remote = Path::new(&url);
    let blob = git_raw(remote, &["show", "HEAD:회의.md"]);
    assert!(blob.status.success());
    assert!(blob.stdout.starts_with(b"NVENC"), "{:?}", String::from_utf8_lossy(&blob.stdout));
    assert!(!String::from_utf8_lossy(&blob.stdout).contains("예산"));
    assert_eq!(git(remote, &["show", "HEAD:.gitattributes"]), GITATTRIBUTES.trim_end());
    assert_eq!(git(remote, &["show", &format!("HEAD:{CRYPT_FILE}")]), crypt_file_text(&key).trim_end());
    // This PC keeps reading its notes as they are.
    assert_eq!(read(&a.join("회의.md")), "예산 확정\n");

    let s = status_with_key(&a, Some(&key)).unwrap();
    assert!(s.encrypted && s.key_ok && s.changed == 0, "{s:?}");
    let s = status_with_key(&a, Some(&MasterKey::generate())).unwrap();
    assert!(s.encrypted && !s.key_ok);
}

#[test]
fn enabling_moves_the_old_repository_aside() {
    if !installed() {
        return;
    }
    let key = MasterKey::generate();
    let _env = KeyEnv::new(Some(&key));
    let tmp = tempfile::tempdir().unwrap();
    let a = vault(tmp.path(), "a");
    std::fs::write(a.join("회의.md"), "예산 확정\n").unwrap();
    init_in(&a).unwrap();
    assert!(backup_in(&a, "평문 백업", None).unwrap().committed);
    set_remote_in(&a, "https://example.com/old.git").unwrap();

    let moved = enable_encryption_in(&a, &key, exe(), now()).unwrap();
    assert_eq!(moved.as_deref(), Some(".git-before-encryption-20261111-090807"));
    assert!(a.join(".git-before-encryption-20261111-090807/HEAD").exists());
    assert_eq!(git(&a, &["rev-list", "--all", "--count"]), "0");
    assert_eq!(git(&a, &["remote"]), "", "the remote is not carried over");
    assert_eq!(read(&a.join("회의.md")), "예산 확정\n");
    assert_eq!(read(&a.join(".gitattributes")), GITATTRIBUTES);
    assert_eq!(read(&a.join(CRYPT_FILE)), crypt_file_text(&key));

    // The old repository (plain history) never goes into the new one.
    backup_with_exe(&a, "암호화 백업", Some(&key), exe()).unwrap();
    let files = git(&a, &["ls-files"]);
    assert!(!files.contains(".git-before-encryption"), "{files}");
    assert!(files.contains("회의.md"));
}

#[test]
fn backup_without_key_commits_nothing() {
    if !installed() {
        return;
    }
    let key = MasterKey::generate();
    let tmp = tempfile::tempdir().unwrap();
    let a = vault(tmp.path(), "a");
    std::fs::write(a.join("회의.md"), "예산 확정\n").unwrap();
    {
        let _env = KeyEnv::new(Some(&key));
        enable_encryption_in(&a, &key, exe(), now()).unwrap();
    }
    let _env = KeyEnv::new(None);
    let e = backup_with_exe(&a, "백업", None, exe()).unwrap_err().to_string();
    assert_eq!(e, NO_KEY);
    let e = backup_with_exe(&a, "백업", Some(&MasterKey::generate()), exe()).unwrap_err().to_string();
    assert_eq!(e, NO_KEY, "a key for another folder is no key");
    assert_eq!(git(&a, &["rev-list", "--all"]), "");
    assert_eq!(git(&a, &["diff", "--cached", "--name-only"]), "", "nothing staged");

    let s = status_with_key(&a, None).unwrap();
    assert!(s.encrypted && !s.key_ok, "{s:?}");
}

#[test]
fn two_pcs_merge_encrypted_notes() {
    if !installed() {
        return;
    }
    let key = MasterKey::generate();
    let _env = KeyEnv::new(Some(&key));
    let tmp = tempfile::tempdir().unwrap();
    let url = bare_remote(tmp.path());
    let a = vault(tmp.path(), "a");
    std::fs::write(a.join("회의.md"), "1\n2\n3\n4\n5\n").unwrap();
    enable_encryption_in(&a, &key, exe(), now()).unwrap();
    set_remote_in(&a, &url).unwrap();
    backup_with_exe(&a, "A1", Some(&key), exe()).unwrap();

    let b = clone_encrypted(tmp.path(), &url, "b");
    assert_eq!(read(&b.join("회의.md")), "1\n2\n3\n4\n5\n", "the clone decrypts");

    // Different lines: merged through the notevine merge driver.
    std::fs::write(b.join("회의.md"), "1 B\n2\n3\n4\n5\n").unwrap();
    assert!(backup_with_exe(&b, "B1", Some(&key), exe()).unwrap().pushed);
    std::fs::write(a.join("회의.md"), "1\n2\n3\n4\n5 A\n").unwrap();
    let r = backup_with_exe(&a, "A2", Some(&key), exe()).unwrap();
    assert!(r.committed && r.pulled && r.pushed, "{r:?}");
    assert_eq!(read(&a.join("회의.md")), "1 B\n2\n3\n4\n5 A\n");
    assert!(backup_with_exe(&b, "B2", Some(&key), exe()).unwrap().pulled);
    assert_eq!(read(&b.join("회의.md")), "1 B\n2\n3\n4\n5 A\n");
    let blob = git_raw(Path::new(&url), &["show", "HEAD:회의.md"]);
    assert!(blob.stdout.starts_with(b"NVENC"), "the merge result is encrypted too");

    // The same line: nothing half-merged, the reason given.
    std::fs::write(b.join("회의.md"), "1 B\n2\n3 B\n4\n5 A\n").unwrap();
    assert!(backup_with_exe(&b, "B3", Some(&key), exe()).unwrap().pushed);
    std::fs::write(a.join("회의.md"), "1 B\n2\n3 A\n4\n5 A\n").unwrap();
    let e = backup_with_exe(&a, "A3", Some(&key), exe()).unwrap_err().to_string();
    assert!(e.contains("다른 PC에서 같은 노트를 고쳐 합치지 못했습니다") && e.contains("회의.md"), "{e}");
    assert_eq!(read(&a.join("회의.md")), "1 B\n2\n3 A\n4\n5 A\n");
    assert!(!a.join(".git/MERGE_HEAD").exists());
}

#[test]
fn refuses_a_remote_that_is_not_this_encrypted_repo() {
    if !installed() {
        return;
    }
    let key = MasterKey::generate();
    let _env = KeyEnv::new(Some(&key));
    let tmp = tempfile::tempdir().unwrap();

    // A remote holding plain history.
    let url = bare_remote(tmp.path());
    let p = vault(tmp.path(), "plain");
    std::fs::write(p.join("회의.md"), "평문\n").unwrap();
    set_remote_in(&p, &url).unwrap();
    assert!(backup_in(&p, "평문", None).unwrap().pushed);
    let remote_head = git(Path::new(&url), &["rev-parse", "HEAD"]);

    let a = vault(tmp.path(), "a");
    std::fs::write(a.join("회의.md"), "비밀\n").unwrap();
    enable_encryption_in(&a, &key, exe(), now()).unwrap();
    set_remote_in(&a, &url).unwrap();
    let e = backup_with_exe(&a, "A", Some(&key), exe()).unwrap_err().to_string();
    assert_eq!(e, NOT_THIS_REPO);
    assert_eq!(read(&a.join("회의.md")), "비밀\n");
    assert!(!a.join(".git/MERGE_HEAD").exists());
    assert_eq!(git(&a, &["ls-files"]).lines().count(), 4, "no file from the remote came in");
    assert_eq!(git(Path::new(&url), &["rev-parse", "HEAD"]), remote_head, "nothing was sent");

    // A remote encrypted with another key.
    let other = MasterKey::generate();
    let url2 = {
        let r = tmp.path().join("other.git");
        std::fs::create_dir(&r).unwrap();
        git(&r, &["init", "-q", "--bare", "-b", "main"]);
        r.to_string_lossy().to_string()
    };
    {
        drop(_env);
        let _env = KeyEnv::new(Some(&other));
        let o = vault(tmp.path(), "o");
        std::fs::write(o.join("x.md"), "x\n").unwrap();
        enable_encryption_in(&o, &other, exe(), now()).unwrap();
        set_remote_in(&o, &url2).unwrap();
        assert!(backup_with_exe(&o, "O", Some(&other), exe()).unwrap().pushed);
    }
    let _env = KeyEnv::new(Some(&key));
    set_remote_in(&a, &url2).unwrap();
    let e = backup_with_exe(&a, "A", Some(&key), exe()).unwrap_err().to_string();
    assert_eq!(e, NOT_THIS_REPO);
    assert!(!a.join("x.md").exists());
}

/// An encrypted vault with one backup made; returns the vault.
fn encrypted_vault(root: &Path, key: &MasterKey) -> PathBuf {
    let a = vault(root, "a");
    std::fs::write(a.join("회의.md"), "예산 확정\n").unwrap();
    enable_encryption_in(&a, key, exe(), now()).unwrap();
    assert!(backup_with_exe(&a, "첫 백업", Some(key), exe()).unwrap().committed);
    a
}

fn assert_nested_attributes_refused(attributes: &str) {
    if !installed() {
        return;
    }
    let key = MasterKey::generate();
    let _env = KeyEnv::new(Some(&key));
    let tmp = tempfile::tempdir().unwrap();
    let a = encrypted_vault(tmp.path(), &key);
    let before = git(&a, &["rev-list", "--all"]);
    std::fs::create_dir(a.join("sub")).unwrap();
    std::fs::write(a.join("sub/.gitattributes"), attributes).unwrap();
    std::fs::write(a.join("sub/c.md"), "비밀 메모\n").unwrap();

    let e = backup_with_exe(&a, "백업", Some(&key), exe()).unwrap_err().to_string();
    assert!(e.starts_with("암호화되지 않는 파일이 있어 백업을 멈췄습니다: "), "{e}");
    assert!(e.contains("sub/c.md"), "{e}");
    assert!(e.ends_with(". 하위 폴더의 .gitattributes 등이 암호화를 끄고 있습니다"), "{e}");
    assert_eq!(git(&a, &["rev-list", "--all"]), before, "nothing committed");
    assert_eq!(git(&a, &["diff", "--cached", "--name-only"]), "", "nothing staged");
}

#[test]
fn nested_gitattributes_cannot_switch_encryption_off() {
    assert_nested_attributes_refused("* -filter\n");
}

#[test]
fn nested_gitattributes_cannot_name_an_undefined_filter() {
    assert_nested_attributes_refused("* filter=lfs\n");
}

#[test]
fn enabling_twice_with_the_same_key_changes_nothing() {
    if !installed() {
        return;
    }
    let key = MasterKey::generate();
    let _env = KeyEnv::new(Some(&key));
    let tmp = tempfile::tempdir().unwrap();
    let a = encrypted_vault(tmp.path(), &key);
    let head = git(&a, &["rev-parse", "HEAD"]);
    let e = enable_encryption_in(&a, &key, exe(), now()).unwrap_err().to_string();
    assert_eq!(e, "이미 암호화된 노트 폴더입니다");
    assert_eq!(git(&a, &["rev-parse", "HEAD"]), head);
    assert!(!a.join(".git-before-encryption-20261111-090807").exists());
}

#[test]
fn a_deleted_ignore_line_is_restored_before_backup() {
    if !installed() {
        return;
    }
    let key = MasterKey::generate();
    let _env = KeyEnv::new(Some(&key));
    let tmp = tempfile::tempdir().unwrap();
    let a = vault(tmp.path(), "a");
    std::fs::write(a.join("회의.md"), "예산\n").unwrap();
    init_in(&a).unwrap();
    backup_in(&a, "평문", None).unwrap();
    let moved = enable_encryption_in(&a, &key, exe(), now()).unwrap().unwrap();
    std::fs::write(a.join(".gitignore"), "").unwrap();
    backup_with_exe(&a, "백업", Some(&key), exe()).unwrap();
    assert!(read(&a.join(".gitignore")).contains("/.git-before-encryption-*/"));
    assert!(!git(&a, &["ls-files"]).contains(&moved));
}

#[test]
fn a_filter_without_the_key_commits_nothing() {
    if !installed() {
        return;
    }
    let key = MasterKey::generate();
    let tmp = tempfile::tempdir().unwrap();
    let a = vault(tmp.path(), "a");
    std::fs::write(a.join("회의.md"), "예산 확정\n").unwrap();
    {
        let _env = KeyEnv::new(Some(&key));
        enable_encryption_in(&a, &key, exe(), now()).unwrap();
    }
    // The app has the key, the filter Git starts does not: Git itself must refuse.
    let _env = KeyEnv::new(None);
    let e = backup_with_exe(&a, "백업", Some(&key), exe()).unwrap_err().to_string();
    assert!(e.starts_with("Git 오류: ") && e.contains("암호화 열쇠가 이 PC에 없어 암호화·복호화할 수 없습니다"), "{e}");
    assert_eq!(git(&a, &["rev-list", "--all"]), "");
}

#[test]
fn clone_brings_plain_notes() {
    if !installed() {
        return;
    }
    let key = MasterKey::generate();
    let _env = KeyEnv::new(Some(&key));
    let tmp = tempfile::tempdir().unwrap();
    let url = bare_remote(tmp.path());
    let a = encrypted_vault(tmp.path(), &key);
    set_remote_in(&a, &url).unwrap();
    assert!(backup_with_exe(&a, "올림", Some(&key), exe()).unwrap().pushed);

    let dest = tmp.path().join("받음");
    clone_in(&url, &dest, Some(&key), exe()).unwrap();
    assert_eq!(read(&dest.join("회의.md")), "예산 확정\n");
    assert!(status_with_key(&dest, Some(&key)).unwrap().key_ok);
    assert_eq!(git(&dest, &["status", "--porcelain"]), "");
    // It keeps working as a vault: a change goes back up encrypted.
    std::fs::write(dest.join("회의.md"), "예산 확정\n추가\n").unwrap();
    assert!(backup_with_exe(&dest, "받은 곳에서", Some(&key), exe()).unwrap().pushed);
    assert!(git_raw(Path::new(&url), &["show", "HEAD:회의.md"]).stdout.starts_with(b"NVENC"));

    // An existing empty folder works too.
    let empty = vault(tmp.path(), "비어 있음");
    clone_in(&url, &empty, Some(&key), exe()).unwrap();
    assert_eq!(read(&empty.join("회의.md")), "예산 확정\n추가\n");
}

#[test]
fn clone_without_key_leaves_nothing() {
    if !installed() {
        return;
    }
    let key = MasterKey::generate();
    let _env = KeyEnv::new(Some(&key));
    let tmp = tempfile::tempdir().unwrap();
    let url = bare_remote(tmp.path());
    let a = encrypted_vault(tmp.path(), &key);
    set_remote_in(&a, &url).unwrap();
    assert!(backup_with_exe(&a, "올림", Some(&key), exe()).unwrap().pushed);
    let msg = "이 저장소의 암호화 열쇠가 이 PC에 없습니다. 복구 코드를 먼저 넣어 주세요";

    let dest = tmp.path().join("받음");
    let e = clone_in(&url, &dest, None, exe()).unwrap_err().to_string();
    assert_eq!(e, msg);
    assert!(!dest.exists());

    let other = MasterKey::generate();
    let e = clone_in(&url, &dest, Some(&other), exe()).unwrap_err().to_string();
    assert_eq!(e, msg);
    assert!(!dest.exists());

    // A pre-existing empty folder stays, emptied again.
    let empty = vault(tmp.path(), "비어 있음");
    assert!(clone_in(&url, &empty, None, exe()).is_err());
    assert!(empty.is_dir());
    assert_eq!(std::fs::read_dir(&empty).unwrap().count(), 0);
}

#[test]
fn clone_refuses_a_non_empty_folder() {
    if !installed() {
        return;
    }
    let key = MasterKey::generate();
    let _env = KeyEnv::new(Some(&key));
    let tmp = tempfile::tempdir().unwrap();
    let url = bare_remote(tmp.path());
    let a = encrypted_vault(tmp.path(), &key);
    set_remote_in(&a, &url).unwrap();
    assert!(backup_with_exe(&a, "올림", Some(&key), exe()).unwrap().pushed);

    let dest = vault(tmp.path(), "받음");
    std::fs::write(dest.join("내 노트.md"), "지우면 안 됨\n").unwrap();
    let e = clone_in(&url, &dest, Some(&key), exe()).unwrap_err().to_string();
    assert_eq!(e, "받을 폴더가 비어 있지 않습니다");
    assert_eq!(read(&dest.join("내 노트.md")), "지우면 안 됨\n");
    assert_eq!(std::fs::read_dir(&dest).unwrap().count(), 1);
}

#[test]
fn clone_of_a_plain_repository_works() {
    if !installed() {
        return;
    }
    let _env = KeyEnv::new(None);
    let tmp = tempfile::tempdir().unwrap();
    let url = bare_remote(tmp.path());
    let p = vault(tmp.path(), "plain");
    std::fs::write(p.join("회의.md"), "평문\n").unwrap();
    set_remote_in(&p, &url).unwrap();
    assert!(backup_in(&p, "평문", None).unwrap().pushed);

    let dest = tmp.path().join("받음");
    clone_in(&url, &dest, None, exe()).unwrap();
    assert_eq!(read(&dest.join("회의.md")), "평문\n");
    assert!(git_raw(&dest, &["config", "--local", "--get", "filter.notevine.process"]).stdout.is_empty());
    assert!(!status_with_key(&dest, None).unwrap().encrypted);
}

#[test]
fn clone_of_a_master_head_remote_is_refused() {
    if !installed() {
        return;
    }
    let key = MasterKey::generate();
    let _env = KeyEnv::new(Some(&key));
    let tmp = tempfile::tempdir().unwrap();
    // The remote's HEAD names `master`, but Notevine pushed `main`.
    let remote = tmp.path().join("remote.git");
    std::fs::create_dir(&remote).unwrap();
    git(&remote, &["init", "-q", "--bare", "-b", "master"]);
    let url = remote.to_string_lossy().to_string();
    let a = encrypted_vault(tmp.path(), &key);
    set_remote_in(&a, &url).unwrap();
    assert!(backup_with_exe(&a, "올림", Some(&key), exe()).unwrap().pushed);

    let dest = tmp.path().join("받음");
    let e = clone_in(&url, &dest, Some(&key), exe()).unwrap_err().to_string();
    assert_eq!(e, "원격 저장소의 기본 브랜치를 찾지 못했습니다");
    assert!(!dest.exists());
}

#[test]
fn backup_refuses_a_remote_with_only_other_branches() {
    if !installed() {
        return;
    }
    let key = MasterKey::generate();
    let _env = KeyEnv::new(Some(&key));
    let tmp = tempfile::tempdir().unwrap();
    let url = bare_remote(tmp.path());
    let a = encrypted_vault(tmp.path(), &key);
    set_remote_in(&a, &url).unwrap();
    git(&a, &["push", "-q", "origin", "main:other"]);
    let before = git(Path::new(&url), &["for-each-ref"]);

    std::fs::write(a.join("회의.md"), "예산 확정\n바뀜\n").unwrap();
    let e = backup_with_exe(&a, "백업", Some(&key), exe()).unwrap_err().to_string();
    assert_eq!(e, NOT_THIS_REPO);
    assert_eq!(git(Path::new(&url), &["for-each-ref"]), before, "nothing was sent");
}

#[test]
fn clone_refuses_a_relative_folder() {
    let key = MasterKey::generate();
    let e = clone_in("x", Path::new("x/y"), Some(&key), exe()).unwrap_err().to_string();
    assert_eq!(e, "받을 폴더는 전체 경로로 주세요");
}

const ENCRYPTED_REMOTE: &str = "원격 저장소가 암호화 저장소입니다. 이 노트 폴더도 암호화를 켠 뒤 백업하세요";
const NOT_SENT: &str = "원격으로 보낼 백업에 암호화되지 않은 내용이 있어 보내지 않았습니다: ";

fn bare_named(root: &Path, name: &str) -> String {
    let r = root.join(name);
    std::fs::create_dir(&r).unwrap();
    git(&r, &["init", "-q", "--bare", "-b", "main"]);
    r.to_string_lossy().to_string()
}

/// An encrypted remote with one backup on `main`; returns its address.
fn encrypted_remote(root: &Path, key: &MasterKey) -> String {
    let url = bare_remote(root);
    let a = encrypted_vault(root, key);
    set_remote_in(&a, &url).unwrap();
    assert!(backup_with_exe(&a, "올림", Some(key), exe()).unwrap().pushed);
    url
}

#[test]
fn a_plain_vault_on_another_branch_is_not_pushed_to_an_encrypted_remote() {
    if !installed() {
        return;
    }
    let key = MasterKey::generate();
    let _env = KeyEnv::new(Some(&key));
    let tmp = tempfile::tempdir().unwrap();
    let url = encrypted_remote(tmp.path(), &key);
    let before = git(Path::new(&url), &["for-each-ref"]);

    let p = vault(tmp.path(), "plain");
    git(&p, &["init", "-q", "-b", "master"]);
    init_in(&p).unwrap();
    std::fs::write(p.join("평문.md"), "평문 비밀\n").unwrap();
    set_remote_in(&p, &url).unwrap();
    let e = backup_in(&p, "평문", None).unwrap_err().to_string();
    assert_eq!(e, ENCRYPTED_REMOTE);
    assert_eq!(git(Path::new(&url), &["for-each-ref"]), before, "nothing was sent");
}

#[test]
fn a_plain_vault_with_unrelated_history_gets_a_korean_message() {
    if !installed() {
        return;
    }
    let key = MasterKey::generate();
    let _env = KeyEnv::new(Some(&key));
    let tmp = tempfile::tempdir().unwrap();
    let url = encrypted_remote(tmp.path(), &key);
    let before = git(Path::new(&url), &["for-each-ref"]);

    let p = vault(tmp.path(), "plain");
    std::fs::write(p.join("평문.md"), "평문 비밀\n").unwrap();
    init_in(&p).unwrap();
    assert!(backup_in(&p, "평문", None).unwrap().committed);
    set_remote_in(&p, &url).unwrap();
    let e = backup_in(&p, "평문 2", None).unwrap_err().to_string();
    assert_eq!(e, ENCRYPTED_REMOTE);
    assert!(!p.join("회의.md").exists(), "nothing came in");
    assert_eq!(git(Path::new(&url), &["for-each-ref"]), before, "nothing was sent");
}

#[test]
fn a_corrected_remote_works_after_a_refused_one() {
    if !installed() {
        return;
    }
    let key = MasterKey::generate();
    let _env = KeyEnv::new(Some(&key));
    let tmp = tempfile::tempdir().unwrap();
    let plain_url = bare_named(tmp.path(), "plain.git");
    let p = vault(tmp.path(), "plain");
    std::fs::write(p.join("x.md"), "평문\n").unwrap();
    set_remote_in(&p, &plain_url).unwrap();
    assert!(backup_in(&p, "평문", None).unwrap().pushed);

    let a = encrypted_vault(tmp.path(), &key);
    set_remote_in(&a, &plain_url).unwrap();
    let e = backup_with_exe(&a, "A", Some(&key), exe()).unwrap_err().to_string();
    assert_eq!(e, NOT_THIS_REPO);

    let new_url = bare_named(tmp.path(), "new.git");
    set_remote_in(&a, &new_url).unwrap();
    let r = backup_with_exe(&a, "A", Some(&key), exe()).unwrap();
    assert!(r.pushed, "{r:?}");
    assert!(git_raw(Path::new(&new_url), &["cat-file", "-p", "HEAD:회의.md"]).stdout.starts_with(b"NVENC"));
}

#[test]
fn status_reports_a_filter_that_cannot_start_and_the_refresh_fixes_it() {
    if !installed() {
        return;
    }
    let key = MasterKey::generate();
    let _env = KeyEnv::new(Some(&key));
    let tmp = tempfile::tempdir().unwrap();
    let a = encrypted_vault(tmp.path(), &key);
    // The app was moved: the configured filter is gone.
    git(&a, &["config", "--local", "filter.notevine.process", "'C:/nowhere/notevine.exe' --git-filter"]);
    // The same size, so Git has to run the filter to tell whether it changed.
    std::fs::write(a.join("회의.md"), "예산 변경\n").unwrap();

    let s = status_with_key(&a, Some(&key)).unwrap();
    assert!(s.problem.is_some(), "{s:?}");

    refresh_filter(&a, exe()).unwrap();
    let s = status_with_key(&a, Some(&key)).unwrap();
    assert_eq!((s.problem.clone(), s.changed), (None, 1), "{s:?}");

    let s = status_with_key(&a, None).unwrap();
    assert_eq!(s.problem.as_deref(), Some(NO_KEY));
}

#[test]
fn a_commit_that_bypassed_the_filter_is_never_pushed() {
    if !installed() {
        return;
    }
    let key = MasterKey::generate();
    let _env = KeyEnv::new(Some(&key));
    let tmp = tempfile::tempdir().unwrap();
    let url = bare_remote(tmp.path());
    let a = encrypted_vault(tmp.path(), &key);
    set_remote_in(&a, &url).unwrap();
    assert!(backup_with_exe(&a, "올림", Some(&key), exe()).unwrap().pushed);
    let before = git(Path::new(&url), &["for-each-ref"]);

    // Another tool commits without the filter.
    std::fs::write(a.join("비밀.md"), "평문 비밀\n").unwrap();
    let off = ["-c", "filter.notevine.process=", "-c", "filter.notevine.required=false"];
    git(&a, &[&off[..], &["add", "비밀.md"]].concat());
    git(&a, &[&off[..], &["commit", "-q", "-m", "몰래"]].concat());
    assert_eq!(git(&a, &["cat-file", "-p", "HEAD:비밀.md"]), "평문 비밀", "the commit holds plain text");

    let e = backup_with_exe(&a, "백업", Some(&key), exe()).unwrap_err().to_string();
    assert!(e.starts_with(NOT_SENT) && e.contains("비밀.md"), "{e}");
    assert_eq!(git(Path::new(&url), &["for-each-ref"]), before, "nothing was sent");
}
