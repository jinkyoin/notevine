//! Git's side of backup encryption: `notevine` runs as Git's long-running process filter
//! (clean = encrypt on `git add`, smudge = decrypt on checkout), as a textconv (readable
//! diffs) and as a merge driver (decrypt the three versions, merge, encrypt again).
//!
//! stdout carries only the protocol (or the textconv text); messages go to stderr.

use std::io::{Read, Write};
use std::path::Path;

use crate::crypt::{self, MasterKey};
use crate::error::{AppError, AppResult};

const MAGIC: &[u8] = b"NVENC";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const NO_HOOKS: &str = "core.hooksPath=NUL";
#[cfg(not(windows))]
const NO_HOOKS: &str = "core.hooksPath=/dev/null";

/// Most bytes one pkt-line may carry (65520 minus the 4-digit length).
const MAX_PKT: usize = 65516;

enum Pkt {
    Flush,
    Data(Vec<u8>),
}

fn bad_protocol() -> AppError {
    AppError::System("Git 필터 통신 형식이 올바르지 않습니다".into())
}

/// One pkt-line; `None` when the stream ended before it.
fn read_pkt(r: &mut impl Read) -> AppResult<Option<Pkt>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let n = std::str::from_utf8(&len).ok().and_then(|s| usize::from_str_radix(s, 16).ok()).ok_or_else(bad_protocol)?;
    if n == 0 {
        return Ok(Some(Pkt::Flush));
    }
    if !(4..=MAX_PKT + 4).contains(&n) {
        return Err(bad_protocol());
    }
    let mut data = vec![0u8; n - 4];
    r.read_exact(&mut data)?;
    Ok(Some(Pkt::Data(data)))
}

fn write_pkt(w: &mut impl Write, data: &[u8]) -> AppResult<()> {
    debug_assert!(data.len() <= MAX_PKT);
    write!(w, "{:04x}", data.len() + 4)?;
    w.write_all(data)?;
    Ok(())
}

fn write_flush(w: &mut impl Write) -> AppResult<()> {
    w.write_all(b"0000")?;
    Ok(())
}

fn write_text(w: &mut impl Write, line: &str) -> AppResult<()> {
    write_pkt(w, format!("{line}\n").as_bytes())
}

/// Text lines up to the next flush; `None` at end of stream.
fn read_list(r: &mut impl Read) -> AppResult<Option<Vec<String>>> {
    let mut lines = Vec::new();
    loop {
        match read_pkt(r)? {
            None => return Ok(if lines.is_empty() { None } else { Some(lines) }),
            Some(Pkt::Flush) => return Ok(Some(lines)),
            Some(Pkt::Data(d)) => lines.push(String::from_utf8_lossy(&d).trim_end_matches('\n').to_string()),
        }
    }
}

fn read_content(r: &mut impl Read) -> AppResult<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        match read_pkt(r)? {
            None => return Err(AppError::System("Git 필터 입력이 중간에 끊겼습니다".into())),
            Some(Pkt::Flush) => return Ok(out),
            Some(Pkt::Data(d)) => out.extend_from_slice(&d),
        }
    }
}

fn no_key() -> AppError {
    AppError::System("암호화 열쇠가 이 PC에 없어 암호화·복호화할 수 없습니다".into())
}

/// Only data that is really ours (full header, known version) is left as it is; any
/// other input, even one that happens to start with the magic, is plain text to encrypt.
fn clean(data: Vec<u8>, key: Option<&MasterKey>) -> AppResult<Vec<u8>> {
    if crypt::is_encrypted(&data) {
        return Ok(data);
    }
    Ok(crypt::encrypt(key.ok_or_else(no_key)?, &data))
}

/// Ours: decrypt (a failure is an error). Magic without a valid header (a newer format)
/// is an error too, never passed through. Anything else is plain text, as it is.
fn smudge(data: Vec<u8>, key: Option<&MasterKey>) -> AppResult<Vec<u8>> {
    if crypt::is_encrypted(&data) {
        return crypt::decrypt(key.ok_or_else(no_key)?, &data);
    }
    if data.starts_with(MAGIC) {
        return Err(AppError::System(
            "알 수 없는 형식의 암호화 파일입니다. Notevine을 최신 버전으로 업데이트하세요".into(),
        ));
    }
    Ok(data)
}

/// Git's long-running filter protocol (version 2) with the `clean` and `smudge` commands.
pub fn run_process_filter(mut input: impl Read, mut output: impl Write, key: Option<&MasterKey>) -> AppResult<()> {
    let hello = read_list(&mut input)?.unwrap_or_default();
    if hello.first().map(String::as_str) != Some("git-filter-client") || !hello.iter().any(|l| l == "version=2") {
        return Err(AppError::System("Git 필터 인사말이 올바르지 않습니다".into()));
    }
    write_text(&mut output, "git-filter-server")?;
    write_text(&mut output, "version=2")?;
    write_flush(&mut output)?;
    // Git sends its capabilities only after it has read this welcome.
    output.flush()?;
    let offered = read_list(&mut input)?.unwrap_or_default();
    for cap in ["clean", "smudge"] {
        if offered.iter().any(|l| l.strip_prefix("capability=") == Some(cap)) {
            write_text(&mut output, &format!("capability={cap}"))?;
        }
    }
    write_flush(&mut output)?;
    output.flush()?;

    while let Some(header) = read_list(&mut input)? {
        let command = header.iter().find_map(|l| l.strip_prefix("command=")).unwrap_or("").to_string();
        let data = read_content(&mut input)?;
        let result = match command.as_str() {
            "clean" => clean(data, key),
            "smudge" => smudge(data, key),
            other => Err(AppError::System(format!("알 수 없는 Git 필터 명령입니다: {other}"))),
        };
        match result {
            Ok(bytes) => {
                write_text(&mut output, "status=success")?;
                write_flush(&mut output)?;
                for chunk in bytes.chunks(MAX_PKT) {
                    write_pkt(&mut output, chunk)?;
                }
                write_flush(&mut output)?;
                write_flush(&mut output)?; // empty status list: keep success
            }
            Err(e) => {
                eprintln!("notevine git-filter: {e}");
                write_text(&mut output, "status=error")?;
                write_flush(&mut output)?;
            }
        }
        output.flush()?;
    }
    Ok(())
}

/// Writes the readable text of a (possibly encrypted) file, for `git diff`.
pub fn textconv(path: &Path, key: Option<&MasterKey>, mut out: impl Write) -> AppResult<()> {
    // A working-tree file Git compares is plain text, even if it starts with the magic.
    let data = std::fs::read(path)?;
    let data = if crypt::is_encrypted(&data) { smudge(data, key)? } else { data };
    out.write_all(&data)?;
    Ok(())
}

fn read_plain(path: &Path, key: &MasterKey) -> AppResult<Vec<u8>> {
    smudge(std::fs::read(path)?, Some(key))
}

/// Merges `ours` and `theirs` over `base`, all encrypted; the result goes to `ours`,
/// encrypted. `true` = merged cleanly; `false` = conflict (`ours` left as it was).
pub fn merge_driver(base: &Path, ours: &Path, theirs: &Path, key: &MasterKey) -> AppResult<bool> {
    let (b, o, t) = (read_plain(base, key)?, read_plain(ours, key)?, read_plain(theirs, key)?);
    if [&b, &o, &t].iter().any(|v| std::str::from_utf8(v).is_err()) {
        return Ok(false);
    }
    // Next to `ours` (inside the repository), so a crash never leaves plain copies in %TEMP%.
    let parent = ours.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let dir = tempfile::tempdir_in(parent)?;
    let (fb, fo, ft) = (dir.path().join("base"), dir.path().join("ours"), dir.path().join("theirs"));
    std::fs::write(&fb, &b)?;
    std::fs::write(&fo, &o)?;
    std::fs::write(&ft, &t)?;

    // Same hardening as backup.rs `git()`: a repository's own settings never run commands.
    let mut c = std::process::Command::new("git");
    c.args(["-c", "core.quotepath=false"])
        .args(["-c", "core.fsmonitor=false", "-c", NO_HOOKS, "-c", "protocol.ext.allow=never"])
        .args(["merge-file", "--stdout", "-L", "이 PC", "-L", "공통", "-L", "다른 PC"])
        .arg(&fo)
        .arg(&fb)
        .arg(&ft)
        .current_dir(dir.path())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(std::process::Stdio::null());
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
    match out.status.code() {
        Some(0) => {
            std::fs::write(ours, crypt::encrypt(key, &out.stdout))?;
            Ok(true)
        }
        // 1..=127 = number of conflicts; anything else is a failure of git itself.
        Some(1..=127) => Ok(false),
        _ => Err(AppError::System(format!(
            "git merge-file이 실패했습니다: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))),
    }
}

/// `--git-filter`, `--git-textconv <file>` or `--git-merge <O> <A> <B> <P>` was given.
pub fn requested(args: &[String]) -> bool {
    args.get(1).is_some_and(|a| matches!(a.as_str(), "--git-filter" | "--git-textconv" | "--git-merge"))
}

/// Runs the requested tool; exit code 0 = done, 1 = merge conflict, 2 = error.
pub fn run(args: &[String]) -> i32 {
    match run_inner(args) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("notevine: {e}");
            2
        }
    }
}

fn load_key() -> AppResult<Option<MasterKey>> {
    crate::crypt_key::key_store().load()
}

fn usage() -> AppError {
    AppError::System("사용법: notevine --git-filter | --git-textconv <파일> | --git-merge <O> <A> <B> <P>".into())
}

fn run_inner(args: &[String]) -> AppResult<i32> {
    match args.get(1).map(String::as_str) {
        Some("--git-filter") => {
            let key = load_key().unwrap_or_else(|e| {
                eprintln!("notevine: {e}");
                None
            });
            let stdin = std::io::stdin().lock();
            let stdout = std::io::stdout().lock();
            run_process_filter(std::io::BufReader::new(stdin), std::io::BufWriter::new(stdout), key.as_ref())?;
            Ok(0)
        }
        Some("--git-textconv") => {
            let file = args.get(2).ok_or_else(usage)?;
            let key = load_key()?;
            let mut out = std::io::BufWriter::new(std::io::stdout().lock());
            textconv(Path::new(file), key.as_ref(), &mut out)?;
            out.flush()?;
            Ok(0)
        }
        Some("--git-merge") => {
            // %O (base) %A (ours, result goes here) %B (theirs) %P (path, unused)
            let (base, ours, theirs) = match (args.get(2), args.get(3), args.get(4)) {
                (Some(o), Some(a), Some(b)) => (o, a, b),
                _ => return Err(usage()),
            };
            let key = load_key()?.ok_or_else(no_key)?;
            let merged = merge_driver(Path::new(base), Path::new(ours), Path::new(theirs), &key)?;
            Ok(if merged { 0 } else { 1 })
        }
        _ => Err(usage()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pkt(data: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        write_pkt(&mut v, data).unwrap();
        v
    }

    /// What Git sends: handshake, then one command per `(command, content)`.
    fn client(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut v = Vec::new();
        for l in ["git-filter-client\n", "version=2\n"] {
            v.extend(pkt(l.as_bytes()));
        }
        v.extend(b"0000");
        for l in ["capability=clean\n", "capability=smudge\n"] {
            v.extend(pkt(l.as_bytes()));
        }
        v.extend(b"0000");
        for (cmd, content) in files {
            v.extend(pkt(format!("command={cmd}\n").as_bytes()));
            v.extend(pkt(b"pathname=a.md\n"));
            v.extend(b"0000");
            for chunk in content.chunks(MAX_PKT) {
                v.extend(pkt(chunk));
            }
            v.extend(b"0000");
        }
        v
    }

    type Answer = (Vec<String>, Vec<(String, Vec<u8>)>);

    /// Splits the server's answer into: handshake lines, then per file (status, content).
    fn parse(out: &[u8], files: usize) -> Answer {
        let mut r = out;
        let mut hello = Vec::new();
        for _ in 0..2 {
            hello.extend(read_list(&mut r).unwrap().unwrap());
        }
        let mut results = Vec::new();
        for _ in 0..files {
            let status = read_list(&mut r).unwrap().unwrap().join(",");
            let mut content = Vec::new();
            if status == "status=success" {
                content = read_content(&mut r).unwrap();
                assert!(read_list(&mut r).unwrap().unwrap().is_empty());
            }
            results.push((status, content));
        }
        assert!(r.is_empty());
        (hello, results)
    }

    fn run_filter(files: &[(&str, &[u8])], key: Option<&MasterKey>) -> Answer {
        let mut out = Vec::new();
        run_process_filter(client(files).as_slice(), &mut out, key).unwrap();
        parse(&out, files.len())
    }

    #[test]
    fn handshake_and_clean_smudge_roundtrip() {
        let key = MasterKey::generate();
        let (hello, r) = run_filter(&[("clean", "안녕\r\n노트".as_bytes())], Some(&key));
        assert_eq!(hello, ["git-filter-server", "version=2", "capability=clean", "capability=smudge"]);
        assert_eq!(r[0].0, "status=success");
        assert!(crypt::is_encrypted(&r[0].1));
        let (_, r2) = run_filter(&[("smudge", &r[0].1)], Some(&key));
        assert_eq!(r2[0].1, "안녕\r\n노트".as_bytes());
    }

    #[test]
    fn clean_without_key_reports_error() {
        let (_, r) = run_filter(&[("clean", b"secret plain text")], None);
        assert_eq!(r[0].0, "status=error");
        assert!(r[0].1.is_empty());
    }

    #[test]
    fn clean_passes_only_real_ciphertext_and_smudge_rejects_unknown_magic() {
        let key = MasterKey::generate();
        let enc = crypt::encrypt(&key, b"x");
        let (_, r) = run_filter(&[("clean", &enc)], Some(&key));
        assert_eq!(r[0].1, enc);
        let future = b"NVENC\x09whatever".to_vec();
        let (_, r) = run_filter(&[("smudge", &future)], Some(&key));
        assert_eq!(r[0].0, "status=error");
    }

    #[test]
    fn clean_encrypts_plain_text_that_starts_with_the_magic() {
        let key = MasterKey::generate();
        let plain = b"NVENC vs x264\n";
        let (_, r) = run_filter(&[("clean", plain)], Some(&key));
        assert!(crypt::is_encrypted(&r[0].1));
        let (_, r2) = run_filter(&[("smudge", &r[0].1)], Some(&key));
        assert_eq!(r2[0].1, plain);
    }

    #[test]
    fn oversized_pkt_is_a_protocol_error() {
        assert!(read_pkt(&mut &b"fff1"[..]).is_err()); // 65521
        assert!(read_pkt(&mut &b"0003"[..]).is_err());
        let mut ok = b"fff0".to_vec();
        ok.extend(vec![b'x'; MAX_PKT]);
        assert!(matches!(read_pkt(&mut ok.as_slice()), Ok(Some(Pkt::Data(_)))));
    }

    #[test]
    fn handshake_offers_only_what_git_offered() {
        let mut input = Vec::new();
        for l in ["git-filter-client\n", "version=2\n"] {
            input.extend(pkt(l.as_bytes()));
        }
        input.extend(b"0000");
        input.extend(pkt(b"capability=smudge\n"));
        input.extend(pkt(b"capability=delay\n"));
        input.extend(b"0000");
        let mut out = Vec::new();
        run_process_filter(input.as_slice(), &mut out, None).unwrap();
        let mut r = out.as_slice();
        read_list(&mut r).unwrap();
        assert_eq!(read_list(&mut r).unwrap().unwrap(), ["capability=smudge"]);
    }

    #[test]
    fn process_filter_roundtrips_a_large_binary() {
        let key = MasterKey::generate();
        let mut big = vec![0u8; 3 * 1024 * 1024];
        getrandom::getrandom(&mut big).unwrap();
        let (_, r) = run_filter(&[("clean", &big)], Some(&key));
        assert!(crypt::is_encrypted(&r[0].1));
        let (_, r2) = run_filter(&[("smudge", &r[0].1)], Some(&key));
        assert_eq!(r2[0].1, big);
    }

    #[test]
    fn smudge_of_plain_passes_through() {
        let (_, r) = run_filter(&[("smudge", b"plain note")], None);
        assert_eq!(r[0], ("status=success".to_string(), b"plain note".to_vec()));
    }

    #[test]
    fn smudge_with_wrong_key_is_error() {
        let (a, b) = (MasterKey::generate(), MasterKey::generate());
        let enc = crypt::encrypt(&a, b"x");
        let (_, r) = run_filter(&[("smudge", &enc), ("smudge", b"after")], Some(&b));
        assert_eq!(r[0].0, "status=error");
        assert_eq!(r[1].1, b"after");
    }

    fn write_enc(dir: &Path, name: &str, key: &MasterKey, text: &[u8]) -> std::path::PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, crypt::encrypt(key, text)).unwrap();
        p
    }

    #[test]
    fn merge_driver_merges_separate_edits() {
        let key = MasterKey::generate();
        let d = tempfile::tempdir().unwrap();
        let base = write_enc(d.path(), "b", &key, b"a\nb\nc\n");
        let ours = write_enc(d.path(), "o", &key, b"A\nb\nc\n");
        let theirs = write_enc(d.path(), "t", &key, b"a\nb\nC\n");
        assert!(merge_driver(&base, &ours, &theirs, &key).unwrap());
        let merged = std::fs::read(&ours).unwrap();
        assert!(crypt::is_encrypted(&merged));
        assert_eq!(crypt::decrypt(&key, &merged).unwrap(), b"A\nb\nC\n");
    }

    #[test]
    fn merge_driver_reports_overlapping_edits() {
        let key = MasterKey::generate();
        let d = tempfile::tempdir().unwrap();
        let base = write_enc(d.path(), "b", &key, b"a\nb\nc\n");
        let ours = write_enc(d.path(), "o", &key, b"a\nX\nc\n");
        let theirs = write_enc(d.path(), "t", &key, b"a\nY\nc\n");
        let before = std::fs::read(&ours).unwrap();
        assert!(!merge_driver(&base, &ours, &theirs, &key).unwrap());
        assert_eq!(std::fs::read(&ours).unwrap(), before);
    }

    #[test]
    fn merge_driver_leaves_binary_as_conflict() {
        let key = MasterKey::generate();
        let d = tempfile::tempdir().unwrap();
        let base = write_enc(d.path(), "b", &key, b"a\n");
        let ours = write_enc(d.path(), "o", &key, &[0xff, 0xfe, 0x00, 0x01]);
        let theirs = write_enc(d.path(), "t", &key, b"b\n");
        let before = std::fs::read(&ours).unwrap();
        assert!(!merge_driver(&base, &ours, &theirs, &key).unwrap());
        assert_eq!(std::fs::read(&ours).unwrap(), before);
    }

    #[test]
    fn textconv_shows_plain_text() {
        let key = MasterKey::generate();
        let d = tempfile::tempdir().unwrap();
        let p = write_enc(d.path(), "f", &key, "본문".as_bytes());
        let mut out = Vec::new();
        textconv(&p, Some(&key), &mut out).unwrap();
        assert_eq!(out, "본문".as_bytes());
    }
}
