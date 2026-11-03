//! Asking AI through the user's own, already logged-in official CLIs:
//! Claude Code (`claude`) and OpenAI Codex CLI (`codex`).
//!
//! Privacy rules this module keeps:
//! - It never reads any credential, token, cookie or config of the CLIs (or of
//!   browsers). It only *runs* the official binaries, which use their own login.
//!   (The only CLI-related file it reads is the npm `.cmd` launcher shim, to find
//!   the node script it starts.)
//! - The CLIs get no tools that could touch the user's files: they run in a
//!   fresh empty temp directory, Claude with `--tools ""`, Codex read-only.
//!   A web research run (`web`) adds only web search/fetch: Claude
//!   `WebSearch,WebFetch`, Codex `--search`.
//! - Note content goes over stdin, never on the command line.
//! - Nothing is sent unless [`ai_run`] is called; the frontend calls it only
//!   after the user confirmed which notes to send.
//!
//! API keys (Anthropic, OpenAI) and Ollama go through `ai_api.rs` instead of a CLI.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, mpsc};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tauri::State;
use tauri::ipc::Channel;
use unicode_normalization::UnicodeNormalization;

use crate::commands::{AppState, with_vault};
use crate::error::{AppError, AppResult};
use crate::paths::{file_name, is_note, normalize_rel};
use crate::search::{SearchQuery, SnippetPart, search};
use crate::vault::Vault;

/// Longest a single AI run may take.
const RUN_TIMEOUT: Duration = Duration::from_secs(300);
/// `--version` / login status probes.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// Longest a login window may stay open.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(600);
const PROVIDER_CACHE_TTL: Duration = Duration::from_secs(60);
/// Characters of one note sent at most.
const NOTE_CAP: usize = 12_000;
/// Characters of all note contents together sent at most.
const BLOCK_CAP: usize = 60_000;
const TRUNCATED: &str = "…(이하 생략)";
const SNIPPET_MAX: usize = 160;
const DEFAULT_CONTEXT_LIMIT: u32 = 8;
const MAX_CONTEXT_LIMIT: u32 = 20;
const MAX_KEYWORDS: usize = 10;
/// Hits per keyword considered when ranking context notes.
const HITS_PER_KEYWORD: u32 = 500;
/// Characters of stderr quoted in an error message.
const STDERR_TAIL: usize = 400;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Variables a parent Claude Code session sets for its children. A nested
/// `claude` would think it runs inside that session, so they are not passed on.
const SESSION_ENV: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_PID",
];

// ---------------------------------------------------------------------------
// Contract types (the TS side mirrors these)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AiProvider {
    /// "claude" | "codex"
    pub id: String,
    pub name: String,
    pub available: bool,
    pub version: Option<String>,
    /// From `claude auth status` / `codex login status`; None when the CLI did not say.
    pub logged_in: Option<bool>,
    /// Korean hint when unavailable.
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ContextNote {
    pub path: String,
    pub title: String,
    /// At most [`SNIPPET_MAX`] characters around a hit.
    pub snippet: String,
    /// Note length in characters.
    pub chars: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AiEvent {
    Started {
        model: Option<String>,
    },
    Delta {
        text: String,
    },
    Notice {
        message: String,
    },
    /// What the AI is doing during a web research run (search query, page read).
    Progress {
        message: String,
    },
    Done {
        text: String,
        cost_usd: Option<f64>,
    },
    Error {
        message: String,
    },
}

impl AiEvent {
    fn is_terminal(&self) -> bool {
        matches!(self, AiEvent::Done { .. } | AiEvent::Error { .. })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Provider {
    Claude,
    Codex,
}

impl Provider {
    fn parse(id: &str) -> Option<Self> {
        match id {
            "claude" => Some(Provider::Claude),
            "codex" => Some(Provider::Codex),
            _ => None,
        }
    }

    fn id(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Provider::Claude => "Claude Code",
            Provider::Codex => "Codex (ChatGPT)",
        }
    }

    fn not_installed(self) -> &'static str {
        match self {
            Provider::Claude => "Claude Code가 설치되어 있지 않습니다",
            Provider::Codex => "Codex CLI가 설치되어 있지 않습니다",
        }
    }

    fn login_hint(self) -> &'static str {
        match self {
            Provider::Claude => "Claude Code에 로그인되어 있지 않습니다. 로그인 버튼을 눌러 로그인하세요",
            Provider::Codex => "Codex에 로그인되어 있지 않습니다. 로그인 버튼을 눌러 로그인하세요",
        }
    }

    /// The CLI's own interactive login (opens the browser).
    fn login_args(self) -> &'static [&'static str] {
        match self {
            Provider::Claude => &["auth", "login"],
            Provider::Codex => &["login"],
        }
    }

    fn status_args(self) -> &'static [&'static str] {
        match self {
            Provider::Claude => &["auth", "status", "--json"],
            Provider::Codex => &["login", "status"],
        }
    }

    /// Logged in? from the status command's output.
    fn parse_status(self, ok: bool, out: &str) -> Option<bool> {
        match self {
            Provider::Claude => parse_claude_auth(out),
            Provider::Codex => parse_login(ok, out),
        }
    }
}

fn other_err(msg: impl Into<String>) -> AppError {
    AppError::Io(std::io::Error::other(msg.into()))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Installed CLIs and their state. Probing runs off the main thread and is
/// cached for a minute; `refresh` probes again now.
#[tauri::command]
pub async fn ai_providers(state: State<'_, AppState>, refresh: Option<bool>) -> AppResult<Vec<AiProvider>> {
    if refresh == Some(true) {
        clear_provider_cache();
    }
    let ollama = state.settings.load().ollama_url;
    tauri::async_runtime::spawn_blocking(move || {
        let mut all = providers_cached();
        all.extend(crate::ai_api::providers(&ollama));
        all
    })
    .await
    .map_err(|e| other_err(e.to_string()))
}

/// Opens the CLI's own login in a console window (it opens the browser) and
/// waits until that window closes. Returns the provider's state afterwards.
/// Notevine never sees what is typed there; the CLI keeps the login itself.
#[tauri::command]
pub async fn ai_login(provider: String) -> AppResult<AiProvider> {
    let p = Provider::parse(&provider).ok_or_else(|| other_err(format!("알 수 없는 AI 제공자입니다: {provider}")))?;
    tauri::async_runtime::spawn_blocking(move || login_blocking(p)).await.map_err(|e| other_err(e.to_string()))?
}

/// Notes tagged with this (or a sub-tag like `#비공개/회사`) are never sent to AI.
pub const PRIVATE_TAG: &str = "비공개";

/// True when the note's text carries the private tag, inline or in frontmatter `tags`.
/// Decided from the text itself so a tag typed a moment ago already counts.
pub fn is_private(content: &str) -> bool {
    crate::parse::parse(content).tags.iter().any(|t| {
        let k = crate::paths::name_key(t);
        k == PRIVATE_TAG || k.starts_with(&format!("{PRIVATE_TAG}/"))
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct ContextResult {
    pub notes: Vec<ContextNote>,
    /// Relevant notes left out because they are private.
    pub private_excluded: Vec<String>,
}

/// Notes relevant to a natural-language question, for the user to pick from.
/// Private notes are never offered.
#[tauri::command]
pub fn ai_context(state: State<AppState>, question: String, limit: u32) -> AppResult<ContextResult> {
    with_vault(&state, |v| context_notes(v, &question, limit))
}

/// Which of these notes are private (so the UI can refuse to send them or their text).
#[tauri::command]
pub fn ai_private_notes(state: State<AppState>, paths: Vec<String>) -> AppResult<Vec<String>> {
    with_vault(&state, |v| {
        Ok(paths.into_iter().filter(|p| load_note(v, p).map(|d| is_private(&d.content)).unwrap_or(false)).collect())
    })
}

/// Starts a run and returns right away; progress arrives on `on_event`, ending
/// with exactly one `done` or `error`.
/// Tauri passes each argument separately, so this mirrors the TS call 1:1.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn ai_run(
    state: State<AppState>,
    request_id: String,
    provider: String,
    system: String,
    prompt: String,
    notes: Vec<String>,
    model: Option<String>,
    web: Option<bool>,
    on_event: Channel<AiEvent>,
) -> AppResult<()> {
    let api = crate::ai_api::Api::parse(&provider);
    let p = Provider::parse(&provider).or(api.map(|_| Provider::Claude));
    let p = p.ok_or_else(|| other_err(format!("알 수 없는 AI 제공자입니다: {provider}")))?;
    let docs = if notes.is_empty() {
        Vec::new()
    } else {
        with_vault(&state, |v| notes.iter().map(|rel| load_note(v, rel)).collect::<AppResult<Vec<_>>>())?
    };
    // Last line of defence: whatever the UI did, a private note never leaves.
    if let Some(d) = docs.iter().find(|d| is_private(&d.content)) {
        return Err(other_err(format!("#{PRIVATE_TAG} 태그가 있는 노트는 AI로 보낼 수 없습니다: {}", d.title)));
    }
    let (block, notice) = notes_block(&docs);
    let cancel = register_run(&request_id)?;
    if let Some(api) = api {
        let ollama = state.settings.load().ollama_url;
        let input = format!("{block}{prompt}");
        std::thread::spawn(move || {
            let sink = |ev: AiEvent| {
                let _ = on_event.send(ev);
            };
            if let Some(message) = notice {
                sink(AiEvent::Notice { message });
            }
            if web == Some(true) {
                sink(AiEvent::Notice {
                    message: "API 키·Ollama 연결에서는 웹 검색 없이 노트로만 답합니다".into()
                });
            }
            let model = model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
            crate::ai_api::run(api, &system, &input, model.as_deref(), &ollama, &cancel, &sink);
            unregister_run(&request_id);
        });
        return Ok(());
    }
    let input = build_input(p, &system, &block, &prompt);
    std::thread::spawn(move || {
        let sink = |ev: AiEvent| {
            let _ = on_event.send(ev);
        };
        if let Some(message) = notice {
            sink(AiEvent::Notice { message });
        }
        let model = model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
        let job = Job { p, system: &system, input: &input, web: web == Some(true) };
        run_with_model(&request_id, job, model.as_deref(), &cancel, &sink);
        unregister_run(&request_id);
    });
    Ok(())
}

/// Stops a run. False when it already finished (or never existed).
#[tauri::command]
pub fn ai_cancel(request_id: String) -> AppResult<bool> {
    let pid = {
        let runs = RUNS.lock().expect("ai runs lock poisoned");
        let Some(run) = runs.get(&request_id) else {
            return Ok(false);
        };
        run.cancel.store(true, Ordering::SeqCst);
        run.pid
    };
    if let Some(pid) = pid {
        kill_tree(pid);
    }
    Ok(true)
}

// ---------------------------------------------------------------------------
// Running requests
// ---------------------------------------------------------------------------

struct RunHandle {
    pid: Option<u32>,
    cancel: Arc<AtomicBool>,
}

static RUNS: LazyLock<Mutex<HashMap<String, RunHandle>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn register_run(request_id: &str) -> AppResult<Arc<AtomicBool>> {
    let mut runs = RUNS.lock().expect("ai runs lock poisoned");
    if runs.contains_key(request_id) {
        return Err(other_err(format!("이미 실행 중인 요청입니다: {request_id}")));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    runs.insert(request_id.to_string(), RunHandle { pid: None, cancel: cancel.clone() });
    Ok(cancel)
}

fn set_run_pid(request_id: &str, pid: Option<u32>) {
    if let Some(run) = RUNS.lock().expect("ai runs lock poisoned").get_mut(request_id) {
        run.pid = pid;
    }
}

fn unregister_run(request_id: &str) {
    RUNS.lock().expect("ai runs lock poisoned").remove(request_id);
}

/// True when the service refused the requested model (e.g. a ChatGPT account
/// asking Codex for a model it doesn't offer), so retrying without it may work.
fn is_model_rejected(message: &str) -> bool {
    let m = message.to_lowercase();
    m.contains("model")
        && (m.contains("not supported")
            || m.contains("does not exist")
            || m.contains("not found")
            || m.contains("unknown model")
            || m.contains("invalid model"))
}

/// One request to a CLI.
#[derive(Clone, Copy)]
struct Job<'a> {
    p: Provider,
    system: &'a str,
    /// Full stdin text (see [`build_input`]).
    input: &'a str,
    /// Allow web search and page reading (and nothing else).
    web: bool,
}

/// Runs with the model the user chose in settings; if the service rejects that
/// model before any text arrived, runs again with the CLI's default model.
fn run_with_model(request_id: &str, job: Job, model: Option<&str>, cancel: &Arc<AtomicBool>, sink: &dyn Fn(AiEvent)) {
    let Some(model) = model else {
        return run_request(request_id, job, None, cancel, sink);
    };
    let got_text = std::cell::Cell::new(false);
    let rejected = std::cell::RefCell::new(None::<String>);
    let first = |ev: AiEvent| match ev {
        AiEvent::Error { message } if !got_text.get() && is_model_rejected(&message) => {
            *rejected.borrow_mut() = Some(message);
        }
        ev => {
            if matches!(ev, AiEvent::Delta { .. } | AiEvent::Done { .. }) {
                got_text.set(true);
            }
            sink(ev)
        }
    };
    run_request(request_id, job, Some(model), cancel, &first);
    if rejected.borrow().is_some() && !cancel.load(Ordering::SeqCst) {
        sink(AiEvent::Notice {
            message: format!("설정한 모델 '{model}'을(를) 이 계정에서 쓸 수 없어 기본 모델로 다시 보냈습니다"),
        });
        run_request(request_id, job, None, cancel, sink);
    }
}

/// Locates the CLI, runs it in an empty temp directory and streams events to
/// `sink`. Blocks until the run ends; always emits exactly one terminal event.
fn run_request(request_id: &str, job: Job, model: Option<&str>, cancel: &Arc<AtomicBool>, sink: &dyn Fn(AiEvent)) {
    let p = job.p;
    let Some(launcher) = locate(p) else {
        sink(AiEvent::Error { message: p.not_installed().to_string() });
        return;
    };
    let workdir = match make_workdir() {
        Ok(d) => d,
        Err(e) => {
            sink(AiEvent::Error { message: format!("임시 폴더를 만들지 못했습니다: {e}") });
            return;
        }
    };
    let mut args = match p {
        Provider::Claude => claude_args(job.system, job.web),
        Provider::Codex => codex_args(&workdir, job.web),
    };
    if let Some(m) = model {
        // Before the trailing "-" (stdin) for codex; anywhere for claude.
        let at = if p == Provider::Codex { args.len() - 1 } else { args.len() };
        args.splice(at..at, [OsString::from(if p == Provider::Codex { "-m" } else { "--model" }), m.into()]);
    }
    execute(request_id, job, &launcher, &args, &workdir, cancel, sink);
    let _ = fs::remove_dir_all(&workdir);
}

/// A fresh, empty directory under the system temp dir.
fn make_workdir() -> std::io::Result<PathBuf> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = std::env::temp_dir().join("notevine-ai").join(format!(
        "{}-{nanos}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Claude's built-in web tools; nothing else is ever enabled.
const CLAUDE_WEB_TOOLS: &str = "WebSearch,WebFetch";

fn claude_args(system: &str, web: bool) -> Vec<OsString> {
    let tools: &[&str] =
        if web { &["--tools", CLAUDE_WEB_TOOLS, "--allowedTools", CLAUDE_WEB_TOOLS] } else { &["--tools", ""] };
    let mut a: Vec<OsString> = std::iter::once("-p")
        .chain(tools.iter().copied())
        .chain([
            "--no-session-persistence",
            "--setting-sources",
            "",
            "--strict-mcp-config",
            "--output-format",
            "stream-json",
            "--include-partial-messages",
            "--verbose",
        ])
        .map(OsString::from)
        .collect();
    if !system.trim().is_empty() {
        a.push("--system-prompt".into());
        a.push(system.into());
    }
    a
}

fn codex_args(workdir: &Path, web: bool) -> Vec<OsString> {
    // `--search` is a top-level option, so it goes before `exec`.
    let search: &[&str] = if web { &["--search"] } else { &[] };
    let mut a: Vec<OsString> = search
        .iter()
        .copied()
        .chain([
            "exec",
            "--json",
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "--ephemeral",
            "--ignore-user-config",
            "-C",
        ])
        .map(OsString::from)
        .collect();
    a.push(workdir.as_os_str().to_owned());
    a.push("-".into());
    a
}

/// Forwards events until the first terminal one, then drops everything else.
struct Emitter<'a> {
    sink: &'a dyn Fn(AiEvent),
    finished: bool,
}

impl Emitter<'_> {
    fn emit(&mut self, ev: AiEvent) {
        if self.finished {
            return;
        }
        self.finished = ev.is_terminal();
        (self.sink)(ev);
    }
}

#[allow(clippy::too_many_arguments)]
fn execute(
    request_id: &str,
    job: Job,
    launcher: &Launcher,
    args: &[OsString],
    workdir: &Path,
    cancel: &Arc<AtomicBool>,
    sink: &dyn Fn(AiEvent),
) {
    let (p, input) = (job.p, job.input);
    let mut out = Emitter { sink, finished: false };
    let mut cmd = launcher.command();
    cmd.args(args).current_dir(workdir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            out.emit(AiEvent::Error { message: p.not_installed().to_string() });
            return;
        }
        Err(e) => {
            out.emit(AiEvent::Error { message: format!("{}을(를) 실행하지 못했습니다: {e}", p.name()) });
            return;
        }
    };
    let pid = child.id();
    set_run_pid(request_id, Some(pid));
    if cancel.load(Ordering::SeqCst) {
        kill_tree(pid);
    }

    if let Some(mut stdin) = child.stdin.take() {
        let input = input.to_string();
        std::thread::spawn(move || {
            let _ = stdin.write_all(input.as_bytes());
        });
    }
    let stderr_rx = child.stderr.take().map(read_all_in_background);
    let (tx, rx) = mpsc::channel::<String>();
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if tx.send(String::from_utf8_lossy(&buf).into_owned()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
    }

    let deadline = Instant::now() + RUN_TIMEOUT;
    let mut parser = Parser::new(p, job.web);
    let mut timed_out = false;
    loop {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        let now = Instant::now();
        if now >= deadline {
            timed_out = true;
            break;
        }
        match rx.recv_timeout((deadline - now).min(Duration::from_millis(200))) {
            Ok(line) => {
                if cancel.load(Ordering::SeqCst) {
                    break;
                }
                for ev in parser.feed(&line) {
                    out.emit(ev);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let cancelled = cancel.load(Ordering::SeqCst);
    if cancelled || timed_out {
        kill_tree(pid);
    }
    let status = wait_until(&mut child, deadline);
    if status.is_none() {
        timed_out = true;
        kill_tree(pid);
        let _ = child.wait();
    }
    set_run_pid(request_id, None);
    let stderr = stderr_rx.and_then(|rx| rx.recv_timeout(Duration::from_secs(2)).ok()).unwrap_or_default();

    if out.finished {
        return;
    }
    let ev = if cancelled {
        AiEvent::Error { message: "요청을 취소했습니다".into() }
    } else if timed_out {
        AiEvent::Error { message: format!("{} 응답 시간이 초과되었습니다 (5분)", p.name()) }
    } else {
        let ok = status.is_some_and(|s| s.success());
        parser.finish(ok, status.and_then(|s| s.code()), &stderr)
    };
    out.emit(ev);
}

/// Waits for the child until `deadline`; None when it is still running then.
fn wait_until(child: &mut Child, deadline: Instant) -> Option<std::process::ExitStatus> {
    loop {
        match child.try_wait() {
            Ok(Some(s)) => return Some(s),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => return None,
            Err(_) => return child.wait().ok(),
        }
    }
}

/// Reads a pipe to the end on its own thread; the text arrives on the channel.
fn read_all_in_background<R: Read + Send + 'static>(mut r: R) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = r.read_to_end(&mut buf);
        let _ = tx.send(String::from_utf8_lossy(&buf).into_owned());
    });
    rx
}

/// Kills a process and all its children.
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let mut c = Command::new("taskkill");
        c.args(["/PID", &pid.to_string(), "/T", "/F"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        hide_window(&mut c);
        let _ = c.status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(windows)]
fn hide_window(c: &mut Command) {
    use std::os::windows::process::CommandExt;
    c.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_window(_c: &mut Command) {}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/// Turns CLI output lines into [`AiEvent`]s.
enum Parser {
    Claude,
    /// `final_only`: the answer is the last message only (web runs narrate
    /// their steps in earlier messages).
    Codex {
        texts: Vec<String>,
        last_error: Option<String>,
        final_only: bool,
    },
}

impl Parser {
    fn new(p: Provider, web: bool) -> Self {
        match p {
            Provider::Claude => Parser::Claude,
            Provider::Codex => Parser::Codex { texts: Vec::new(), last_error: None, final_only: web },
        }
    }

    fn provider(&self) -> Provider {
        match self {
            Parser::Claude => Provider::Claude,
            Parser::Codex { .. } => Provider::Codex,
        }
    }

    /// Events for one output line. Lines that are not JSON objects are ignored.
    fn feed(&mut self, line: &str) -> Vec<AiEvent> {
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            return Vec::new();
        };
        let ty = v.get("type").and_then(Value::as_str).unwrap_or("");
        match self {
            Parser::Claude => claude_event(&v, ty).into_iter().collect(),
            Parser::Codex { texts, last_error, final_only } => match ty {
                "thread.started" => vec![AiEvent::Started { model: None }],
                "item.completed" => {
                    let item = &v["item"];
                    match item.get("type").and_then(Value::as_str) {
                        Some("agent_message") => {}
                        Some("web_search") => return codex_web_progress(item).into_iter().collect(),
                        _ => return Vec::new(),
                    }
                    let text = item.get("text").and_then(Value::as_str).unwrap_or("").to_string();
                    let delta = if texts.is_empty() { text.clone() } else { format!("\n\n{text}") };
                    texts.push(text);
                    vec![AiEvent::Delta { text: delta }]
                }
                // Codex also reports recoverable problems (e.g. reconnects) this way;
                // only remember it in case the run fails.
                "error" => {
                    *last_error = v.get("message").and_then(Value::as_str).map(str::to_string);
                    Vec::new()
                }
                "turn.failed" => {
                    let msg = v
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .or_else(|| last_error.clone())
                        .unwrap_or_else(|| "알 수 없는 오류".into());
                    vec![AiEvent::Error { message: error_message(Provider::Codex, &msg) }]
                }
                "turn.completed" => vec![AiEvent::Done { text: answer(texts, *final_only), cost_usd: None }],
                _ => Vec::new(),
            },
        }
    }

    /// The terminal event when the process ended without sending one.
    fn finish(&self, exit_ok: bool, code: Option<i32>, stderr: &str) -> AiEvent {
        let p = self.provider();
        if let Parser::Codex { texts, last_error, final_only } = self {
            if exit_ok && !texts.is_empty() {
                return AiEvent::Done { text: answer(texts, *final_only), cost_usd: None };
            }
            if let Some(e) = last_error {
                return AiEvent::Error { message: error_message(p, e) };
            }
        }
        let stderr = stderr.trim();
        let message = if !stderr.is_empty() {
            error_message(p, stderr)
        } else if exit_ok {
            format!("{}이(가) 응답 없이 종료되었습니다", p.name())
        } else {
            match code {
                Some(c) => format!("{}이(가) 오류로 종료되었습니다 (종료 코드 {c})", p.name()),
                None => format!("{}이(가) 비정상 종료되었습니다", p.name()),
            }
        };
        AiEvent::Error { message }
    }
}

/// Codex's answer: all its messages, or only the last one.
fn answer(texts: &[String], final_only: bool) -> String {
    if final_only { texts.last().cloned().unwrap_or_default() } else { texts.join("\n\n") }
}

/// "웹 검색: …" / "페이지 읽기: …" for a step of a web research run.
fn web_step(tool: &str, query: Option<&str>, url: Option<&str>) -> Option<AiEvent> {
    let message = match (tool, query.filter(|q| !q.is_empty()), url.filter(|u| !u.is_empty())) {
        ("search", Some(q), _) => format!("웹 검색: {q}"),
        ("open", _, Some(u)) => format!("페이지 읽기: {u}"),
        _ => return None,
    };
    Some(AiEvent::Progress { message })
}

fn codex_web_progress(item: &Value) -> Option<AiEvent> {
    let action = &item["action"];
    match action.get("type").and_then(Value::as_str) {
        Some("search") => web_step(
            "search",
            action.get("query").and_then(Value::as_str).or_else(|| item.get("query").and_then(Value::as_str)),
            None,
        ),
        Some("open_page") => web_step("open", None, action.get("url").and_then(Value::as_str)),
        _ => web_step("search", item.get("query").and_then(Value::as_str), None),
    }
}

/// Tool calls in a Claude `assistant` message, as one progress line.
fn claude_tool_progress(v: &Value) -> Option<AiEvent> {
    let steps: Vec<String> = v
        .pointer("/message/content")
        .and_then(Value::as_array)?
        .iter()
        .filter(|c| c.get("type").and_then(Value::as_str) == Some("tool_use"))
        .filter_map(|c| {
            let input = &c["input"];
            let ev = match c.get("name").and_then(Value::as_str)? {
                "WebSearch" => web_step("search", input.get("query").and_then(Value::as_str), None),
                "WebFetch" => web_step("open", None, input.get("url").and_then(Value::as_str)),
                _ => None,
            };
            match ev {
                Some(AiEvent::Progress { message }) => Some(message),
                _ => None,
            }
        })
        .collect();
    (!steps.is_empty()).then(|| AiEvent::Progress { message: steps.join("\n") })
}

fn claude_event(v: &Value, ty: &str) -> Option<AiEvent> {
    match ty {
        "assistant" => claude_tool_progress(v),
        "system" if v.get("subtype").and_then(Value::as_str) == Some("init") => {
            Some(AiEvent::Started { model: v.get("model").and_then(Value::as_str).map(str::to_string) })
        }
        "stream_event" => {
            let ev = &v["event"];
            if ev.get("type").and_then(Value::as_str) != Some("content_block_delta") {
                return None;
            }
            let delta = &ev["delta"];
            if delta.get("type").and_then(Value::as_str) != Some("text_delta") {
                return None;
            }
            let text = delta.get("text").and_then(Value::as_str)?;
            Some(AiEvent::Delta { text: text.to_string() })
        }
        "result" => {
            let is_error = v.get("is_error").and_then(Value::as_bool).unwrap_or(false)
                || v.get("subtype").and_then(Value::as_str).is_some_and(|s| s != "success");
            let text = v.get("result").and_then(Value::as_str).unwrap_or("");
            if is_error {
                let raw = if text.trim().is_empty() {
                    v.get("subtype").and_then(Value::as_str).unwrap_or("알 수 없는 오류")
                } else {
                    text
                };
                Some(AiEvent::Error { message: error_message(Provider::Claude, raw) })
            } else {
                Some(AiEvent::Done {
                    text: text.to_string(),
                    cost_usd: v.get("total_cost_usd").and_then(Value::as_f64),
                })
            }
        }
        _ => None,
    }
}

fn looks_like_auth_error(msg: &str) -> bool {
    let m = msg.to_lowercase();
    [
        "/login",
        "not logged in",
        "log in",
        "login",
        "authenticat",
        "unauthorized",
        "401",
        "invalid api key",
        "api key",
        "token expired",
        "refresh token",
    ]
    .iter()
    .any(|k| m.contains(k))
}

/// Korean, actionable error text for a raw CLI error message.
fn error_message(p: Provider, raw: &str) -> String {
    if looks_like_auth_error(raw) {
        return p.login_hint().to_string();
    }
    format!("{} 오류: {}", p.name(), tail_chars(raw.trim(), STDERR_TAIL))
}

fn tail_chars(s: &str, n: usize) -> String {
    let count = s.chars().count();
    if count <= n { s.to_string() } else { format!("…{}", s.chars().skip(count - n).collect::<String>()) }
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/// A note to send: vault-relative path, title, full text.
#[derive(Debug, Clone)]
struct NoteDoc {
    path: String,
    title: String,
    content: String,
}

fn title_of(rel: &str) -> String {
    let name = file_name(rel);
    if is_note(name) { name[..name.len() - 3].to_string() } else { name.to_string() }
}

/// Reads a note for sending; the path must be a note inside the vault.
fn load_note(v: &Vault, rel: &str) -> AppResult<NoteDoc> {
    let rel = normalize_rel(rel);
    let abs = v.abs(&rel)?;
    if !is_note(&rel) || !abs.is_file() {
        return Err(AppError::NotFound(rel));
    }
    let content = fs::read_to_string(&abs)?;
    Ok(NoteDoc { title: title_of(&rel), path: rel, content })
}

fn attr(s: &str) -> String {
    s.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;").replace('>', "&gt;")
}

fn take_chars(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

fn thousands(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// The `<참고 노트>` block (empty without notes) and, when something had to be
/// cut, a notice saying what. Each note is capped at [`NOTE_CAP`] characters and
/// all contents together at [`BLOCK_CAP`]; notes past the budget are left out.
fn notes_block(docs: &[NoteDoc]) -> (String, Option<String>) {
    if docs.is_empty() {
        return (String::new(), None);
    }
    let mut out = String::from("<참고 노트>\n");
    let mut budget = BLOCK_CAP;
    let mut cut: Vec<String> = Vec::new();
    let mut dropped: Vec<String> = Vec::new();
    for d in docs {
        if budget == 0 {
            dropped.push(d.title.clone());
            continue;
        }
        let len = d.content.chars().count();
        let cap = NOTE_CAP.min(budget);
        let body = if len > cap {
            cut.push(format!("{}(앞 {}자)", d.title, thousands(cap)));
            budget -= cap;
            format!("{}\n{TRUNCATED}", take_chars(&d.content, cap))
        } else {
            budget -= len;
            d.content.clone()
        };
        out.push_str(&format!("<note path=\"{}\" title=\"{}\">\n", attr(&d.path), attr(&d.title)));
        out.push_str(body.trim_end_matches('\n'));
        out.push_str("\n</note>\n");
    }
    out.push_str("</참고 노트>\n\n");

    let mut parts = Vec::new();
    if !cut.is_empty() {
        parts.push(format!("길어서 앞부분만 보낸 노트: {}", cut.join(", ")));
    }
    if !dropped.is_empty() {
        parts.push(format!(
            "전체 분량 한도({}자)를 넘어 보내지 않은 노트: {}",
            thousands(BLOCK_CAP),
            dropped.join(", ")
        ));
    }
    let notice = (!parts.is_empty()).then(|| parts.join(" / "));
    (out, notice)
}

/// What goes to the CLI's stdin. Claude gets the system prompt as a flag;
/// Codex has none, so it is put in front.
fn build_input(p: Provider, system: &str, block: &str, prompt: &str) -> String {
    match p {
        Provider::Claude => format!("{block}{prompt}"),
        Provider::Codex if system.trim().is_empty() => format!("{block}{prompt}"),
        Provider::Codex => format!("<지침>\n{system}\n</지침>\n\n{block}{prompt}"),
    }
}

// ---------------------------------------------------------------------------
// Context notes
// ---------------------------------------------------------------------------

/// Endings stripped from the end of a word (longest first wins).
#[rustfmt::skip]
const PARTICLES: &[&str] = &[
    "은", "는", "이", "가", "을", "를", "에", "에서", "에게", "의", "로", "으로", "과", "와", "도", "만", "까지", "부터", "이랑", "랑",
    "한테", "께", "께서", "보다", "처럼", "마다", "에는", "에서는", "으로는", "로는", "에서의", "에도", "들", "들은", "들이", "들을", "했나",
    "했어", "했지", "했던", "했다", "했는지", "했나요", "했어요", "했지요", "인가", "인가요", "일까", "일까요", "이야", "이에요", "예요", "에요",
    "요", "였지", "였나", "였어", "이었지", "이었나", "인지", "한", "하는", "하고", "이고", "이나", "나요", "할까", "해야", "합니다", "입니다",
    "이다", "야",
];

#[rustfmt::skip]
const STOPWORDS: &[&str] = &[
    "무엇", "뭐", "뭘", "뭔가", "무슨", "어떻게", "어떤", "언제", "어디", "어디서", "누구", "누가", "왜", "얼마", "몇", "정리", "정리해",
    "정리해줘", "알려", "알려줘", "해줘", "줘", "요약", "요약해", "요약해줘", "찾아", "찾아줘", "보여", "보여줘", "설명", "설명해", "설명해줘", "대해",
    "대해서", "대한", "관련", "관련된", "내용", "노트", "있어", "있나", "있는", "있었", "그거", "이거", "저거", "그것", "이것", "그리고", "그런데",
    "지금", "우리", "나의", "내가", "제가", "the", "an", "of", "to", "in", "is", "are", "what", "how", "when", "where",
    "who", "why", "which", "please", "and", "or", "about",
];

fn is_stopword(w: &str) -> bool {
    STOPWORDS.contains(&w)
}

fn strip_particles(word: &str) -> String {
    let mut w = word.to_string();
    for _ in 0..3 {
        let n = w.chars().count();
        let Some(suffix) = PARTICLES
            .iter()
            .filter(|p| w.ends_with(**p) && n - p.chars().count() >= 2)
            .max_by_key(|p| p.chars().count())
        else {
            break;
        };
        w.truncate(w.len() - suffix.len());
    }
    w
}

/// Search keywords from a natural-language (mostly Korean) question: words with
/// particles/endings stripped, stopwords and 1-character words dropped, deduplicated.
fn extract_keywords(question: &str) -> Vec<String> {
    let q: String = question.nfc().collect();
    let mut out: Vec<String> = Vec::new();
    for raw in q.split(|c: char| !c.is_alphanumeric()) {
        if raw.is_empty() {
            continue;
        }
        let lower = raw.to_lowercase();
        if is_stopword(&lower) {
            continue;
        }
        let w = strip_particles(&lower);
        if w.chars().count() < 2 || is_stopword(&w) || out.contains(&w) {
            continue;
        }
        out.push(w);
        if out.len() == MAX_KEYWORDS {
            break;
        }
    }
    out
}

fn snippet_text(parts: &[SnippetPart]) -> String {
    let s: String = parts.iter().map(|p| p.text.as_str()).collect();
    if s.chars().count() > SNIPPET_MAX { format!("{}…", take_chars(&s, SNIPPET_MAX - 1)) } else { s }
}

struct Scored {
    path: String,
    title: String,
    mtime: i64,
    score: u32,
    snippet: String,
}

/// Notes matching any keyword of the question, ranked by the number of distinct
/// keywords hit (a title hit counts double), then by modification time.
fn context_notes(v: &Vault, question: &str, limit: u32) -> AppResult<ContextResult> {
    let limit = if limit == 0 { DEFAULT_CONTEXT_LIMIT } else { limit.min(MAX_CONTEXT_LIMIT) } as usize;
    let mut scored: HashMap<String, Scored> = HashMap::new();
    for kw in extract_keywords(question) {
        let q = SearchQuery { text: vec![kw.clone()], limit: Some(HITS_PER_KEYWORD), ..Default::default() };
        for h in search(v.index(), &q)?.hits {
            let weight = if h.title.to_lowercase().contains(&kw) { 2 } else { 1 };
            let e = scored.entry(h.path.clone()).or_insert_with(|| Scored {
                snippet: snippet_text(&h.parts),
                path: h.path,
                title: h.title,
                mtime: h.mtime,
                score: 0,
            });
            e.score += weight;
        }
    }
    let mut ranked: Vec<Scored> = scored.into_values().collect();
    ranked.sort_by(|a, b| b.score.cmp(&a.score).then(b.mtime.cmp(&a.mtime)).then_with(|| a.path.cmp(&b.path)));
    let mut notes = Vec::new();
    let mut private_excluded = Vec::new();
    for s in ranked {
        if notes.len() >= limit {
            break;
        }
        let content = v.abs(&s.path).ok().and_then(|p| fs::read_to_string(p).ok()).unwrap_or_default();
        if is_private(&content) {
            private_excluded.push(s.path);
            continue;
        }
        let chars = u32::try_from(content.chars().count()).unwrap_or(u32::MAX);
        notes.push(ContextNote { path: s.path, title: s.title, snippet: s.snippet, chars });
    }
    Ok(ContextResult { notes, private_excluded })
}

// ---------------------------------------------------------------------------
// Locating and probing the CLIs
// ---------------------------------------------------------------------------

/// How to start a CLI: a program plus leading arguments (node + script for npm shims).
#[derive(Debug, Clone)]
struct Launcher {
    program: PathBuf,
    pre_args: Vec<OsString>,
}

impl Launcher {
    fn command(&self) -> Command {
        let mut c = Command::new(&self.program);
        c.args(&self.pre_args);
        for k in SESSION_ENV {
            c.env_remove(k);
        }
        hide_window(&mut c);
        c
    }
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ".bat"] } else { &[""] };
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for ext in exts {
            let p = dir.join(format!("{name}{ext}"));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// The node script an npm `.cmd` shim starts, relative to the shim's folder.
fn npm_shim_script(shim: &str) -> Option<String> {
    const MARK: &str = "\"%dp0%\\";
    let start = shim.rfind(MARK)? + MARK.len();
    let rest = &shim[start..];
    let rel = &rest[..rest.find('"')?];
    rel.to_lowercase().ends_with(".js").then(|| rel.replace('\\', "/"))
}

/// npm installs a `.cmd` shim on Windows. Starting node with the script directly
/// avoids `cmd.exe` argument quoting and leaves a plain process tree to kill.
/// Falls back to the shim itself (Rust escapes arguments for batch files).
fn launcher_for(path: PathBuf) -> Launcher {
    let is_shim =
        path.extension().and_then(|e| e.to_str()).is_some_and(|e| matches!(e.to_lowercase().as_str(), "cmd" | "bat"));
    if is_shim {
        let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
        let script = fs::read_to_string(&path).ok().and_then(|t| npm_shim_script(&t)).map(|rel| dir.join(rel));
        if let Some(script) = script.filter(|s| s.is_file()) {
            let local_node = dir.join("node.exe");
            let node = if local_node.is_file() { Some(local_node) } else { find_on_path("node") };
            if let Some(node) = node {
                return Launcher { program: node, pre_args: vec![script.into_os_string()] };
            }
        }
    }
    Launcher { program: path, pre_args: Vec::new() }
}

fn locate(p: Provider) -> Option<Launcher> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    let appdata = std::env::var_os("APPDATA").map(PathBuf::from);
    let mut extra: Vec<PathBuf> = Vec::new();
    match p {
        Provider::Claude => {
            if let Some(h) = &home {
                extra.push(h.join(".local").join("bin").join(if cfg!(windows) { "claude.exe" } else { "claude" }));
            }
            if let Some(a) = &appdata {
                extra.push(a.join("npm").join("claude.cmd"));
            }
        }
        Provider::Codex => {
            if let Some(a) = &appdata {
                extra.push(a.join("npm").join("codex.cmd"));
            }
        }
    }
    find_on_path(p.id()).or_else(|| extra.into_iter().find(|x| x.is_file())).map(launcher_for)
}

/// Output of a short probe command (stdout and stderr together).
struct Capture {
    ok: bool,
    text: String,
}

/// Runs a probe with a timeout; None when it could not start or timed out.
fn run_capture(l: &Launcher, args: &[&str], timeout: Duration) -> Option<Capture> {
    let mut cmd = l.command();
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().ok()?;
    let out_rx = child.stdout.take().map(read_all_in_background);
    let err_rx = child.stderr.take().map(read_all_in_background);
    let Some(status) = wait_until(&mut child, Instant::now() + timeout) else {
        kill_tree(child.id());
        let _ = child.wait();
        return None;
    };
    let read = |rx: Option<mpsc::Receiver<String>>| {
        rx.and_then(|rx| rx.recv_timeout(Duration::from_secs(1)).ok()).unwrap_or_default()
    };
    let text = format!("{}\n{}", read(out_rx), read(err_rx));
    Some(Capture { ok: status.success(), text })
}

/// First word that looks like a version number ("2.1.312 (Claude Code)" → "2.1.312").
fn parse_version(out: &str) -> Option<String> {
    out.split_whitespace()
        .map(|w| w.trim_matches(|c: char| !c.is_ascii_alphanumeric()).trim_start_matches('v'))
        .find(|w| w.starts_with(|c: char| c.is_ascii_digit()) && w.contains('.'))
        .map(str::to_string)
}

/// `codex login status` → logged in? None when it says nothing recognizable.
fn parse_login(ok: bool, out: &str) -> Option<bool> {
    let m = out.to_lowercase();
    if m.contains("not logged in") {
        Some(false)
    } else if m.contains("logged in") {
        Some(ok)
    } else if !ok {
        Some(false)
    } else {
        None
    }
}

/// `claude auth status --json` → logged in? Only the `loggedIn` flag is read;
/// the account details it also prints are ignored. None for CLIs too old to have it.
fn parse_claude_auth(out: &str) -> Option<bool> {
    let (start, end) = (out.find('{')?, out.rfind('}')?);
    serde_json::from_str::<Value>(out.get(start..=end)?).ok()?.get("loggedIn")?.as_bool()
}

/// Provider status from probe results. `installed`: binary found;
/// `version_out`: `--version` output when it exited successfully;
/// `logged_in`: what the login status check said, if anything.
fn provider_status(p: Provider, installed: bool, version_out: Option<&str>, logged_in: Option<bool>) -> AiProvider {
    let mut s = AiProvider {
        id: p.id().into(),
        name: p.name().into(),
        available: false,
        version: None,
        logged_in: None,
        detail: None,
    };
    if !installed {
        s.detail = Some(p.not_installed().into());
        return s;
    }
    let Some(out) = version_out else {
        s.detail = Some(format!("{}을(를) 실행할 수 없습니다 ({} --version 실패)", p.name(), p.id()));
        return s;
    };
    s.version = parse_version(out);
    s.logged_in = logged_in;
    s.available = s.logged_in != Some(false);
    if s.logged_in == Some(false) {
        s.detail = Some("로그인이 필요합니다".into());
    }
    s
}

fn probe(p: Provider) -> AiProvider {
    let Some(l) = locate(p) else {
        return provider_status(p, false, None, None);
    };
    let login = {
        let l = l.clone();
        std::thread::spawn(move || run_capture(&l, p.status_args(), PROBE_TIMEOUT))
    };
    let version = run_capture(&l, &["--version"], PROBE_TIMEOUT).filter(|c| c.ok);
    let logged_in = login.join().ok().flatten().and_then(|c| p.parse_status(c.ok, &c.text));
    provider_status(p, true, version.as_ref().map(|c| c.text.as_str()), logged_in)
}

fn detect_providers() -> Vec<AiProvider> {
    let handles: Vec<_> =
        [Provider::Claude, Provider::Codex].into_iter().map(|p| (p, std::thread::spawn(move || probe(p)))).collect();
    handles.into_iter().map(|(p, h)| h.join().unwrap_or_else(|_| provider_status(p, false, None, None))).collect()
}

static PROVIDER_CACHE: Mutex<Option<(Instant, Vec<AiProvider>)>> = Mutex::new(None);

fn providers_cached() -> Vec<AiProvider> {
    if let Some((at, list)) = PROVIDER_CACHE.lock().expect("provider cache lock poisoned").as_ref()
        && at.elapsed() < PROVIDER_CACHE_TTL
    {
        return list.clone();
    }
    let list = detect_providers();
    *PROVIDER_CACHE.lock().expect("provider cache lock poisoned") = Some((Instant::now(), list.clone()));
    list
}

pub(crate) fn clear_provider_cache() {
    *PROVIDER_CACHE.lock().expect("provider cache lock poisoned") = None;
}

/// Only one login window at a time.
static LOGIN_OPEN: AtomicBool = AtomicBool::new(false);

struct LoginSlot;

impl LoginSlot {
    fn take() -> Option<Self> {
        (!LOGIN_OPEN.swap(true, Ordering::SeqCst)).then_some(LoginSlot)
    }
}

impl Drop for LoginSlot {
    fn drop(&mut self) {
        LOGIN_OPEN.store(false, Ordering::SeqCst);
    }
}

fn login_blocking(p: Provider) -> AppResult<AiProvider> {
    let l = locate(p).ok_or_else(|| other_err(p.not_installed()))?;
    let _slot =
        LoginSlot::take().ok_or_else(|| other_err("이미 로그인 창이 열려 있습니다. 그 창에서 로그인을 마쳐 주세요"))?;
    let title = format!("{} 로그인 - Notevine", p.name());
    let mut child = console_command(&l, &title, p.login_args())
        .spawn()
        .map_err(|e| other_err(format!("{} 로그인 창을 열지 못했습니다: {e}", p.name())))?;
    if wait_until(&mut child, Instant::now() + LOGIN_TIMEOUT).is_none() {
        kill_tree(child.id());
        let _ = child.wait();
    }
    clear_provider_cache();
    Ok(probe(p))
}

/// The CLI with `args` in a new console window the user can type in; the
/// returned process ends when that window closes.
#[cfg(windows)]
fn console_command(l: &Launcher, title: &str, args: &[&str]) -> Command {
    use std::os::windows::process::CommandExt;
    // `start` gives the CLI a console of its own; cmd itself stays hidden.
    // Paths cannot contain `"`, so quoting each part is enough.
    let program = std::iter::once(l.program.as_os_str())
        .chain(l.pre_args.iter().map(|a| a.as_os_str()))
        .map(|a| format!("\"{}\"", a.to_string_lossy()))
        .collect::<Vec<_>>()
        .join(" ");
    let mut c = Command::new(std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into()));
    c.raw_arg(format!("/d /c start \"{title}\" /wait {program} {}", args.join(" ")));
    for k in SESSION_ENV {
        c.env_remove(k);
    }
    if let Some(home) = std::env::var_os("USERPROFILE") {
        c.current_dir(home);
    }
    c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    hide_window(&mut c);
    c
}

#[cfg(not(windows))]
fn console_command(l: &Launcher, _title: &str, args: &[&str]) -> Command {
    let mut c = l.command();
    c.args(args);
    c
}

#[cfg(test)]
mod tests {
    #[test]
    fn private_tag_inline_frontmatter_and_subtags() {
        assert!(super::is_private("회사 일 #비공개"));
        assert!(super::is_private("---\ntags: [업무, 비공개]\n---\n본문"));
        assert!(super::is_private("메모 #비공개/회사"));
        assert!(!super::is_private("공개해도 되는 노트 #비공개아님"));
        assert!(!super::is_private("```\n#비공개\n```\n코드 안 태그는 태그가 아님"));
    }

    #[test]
    fn private_notes_are_never_offered_or_sent() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        v.create_note("", Some("공개 회의"), "배포 회의 결정").unwrap();
        v.create_note("", Some("비밀 회의"), "배포 회의 연봉 #비공개").unwrap();
        let r = super::context_notes(&v, "배포 회의", 8).unwrap();
        let titles: Vec<_> = r.notes.iter().map(|n| n.title.as_str()).collect();
        assert_eq!(titles, ["공개 회의"]);
        assert_eq!(r.private_excluded, ["비밀 회의.md"]);
    }

    #[test]
    fn recognizes_model_rejections_only() {
        assert!(super::is_model_rejected(
            "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."
        ));
        assert!(super::is_model_rejected("model: does not exist"));
        assert!(!super::is_model_rejected("unexpected status 401 Unauthorized"));
        assert!(!super::is_model_rejected("요청을 취소했습니다"));
    }

    use super::*;

    // ----- keywords -----

    #[test]
    fn keywords_strip_particles_and_endings() {
        assert_eq!(extract_keywords("지난주 회의에서 결정한 예산은 얼마였지?"), vec!["지난주", "회의", "결정", "예산"]);
        assert_eq!(extract_keywords("Notevine 프로젝트에서도 일정을 정리해줘"), vec!["notevine", "프로젝트", "일정"]);
        assert_eq!(extract_keywords("대한민국의 수도는 어디야?"), vec!["대한민국", "수도"]);
    }

    #[test]
    fn keywords_drop_stopwords_short_words_and_duplicates() {
        assert_eq!(extract_keywords("서울 서울은 서울이, 서울에서!"), vec!["서울"]);
        assert!(extract_keywords("뭐 어떻게 해줘 a 무엇을 알려줘").is_empty());
        assert!(extract_keywords("").is_empty());
        // a 2-char word is not stripped down to one char
        assert_eq!(extract_keywords("평가 사이"), vec!["평가", "사이"]);
    }

    #[test]
    fn keywords_split_on_punctuation_and_cap_count() {
        assert_eq!(extract_keywords("API/서버·배포(일정)"), vec!["api", "서버", "배포", "일정"]);
        let many = (0..30).map(|i| format!("단어{i}")).collect::<Vec<_>>().join(" ");
        assert_eq!(extract_keywords(&many).len(), MAX_KEYWORDS);
    }

    // ----- prompt assembly -----

    fn doc(path: &str, content: &str) -> NoteDoc {
        NoteDoc { path: path.into(), title: title_of(path), content: content.into() }
    }

    #[test]
    fn notes_block_wraps_each_note() {
        let (block, notice) = notes_block(&[doc("a/회의.md", "본문\n"), doc("b \"q\".md", "x")]);
        assert_eq!(
            block,
            "<참고 노트>\n<note path=\"a/회의.md\" title=\"회의\">\n본문\n</note>\n\
             <note path=\"b &quot;q&quot;.md\" title=\"b &quot;q&quot;\">\nx\n</note>\n</참고 노트>\n\n"
        );
        assert_eq!(notice, None);
        assert_eq!(notes_block(&[]), (String::new(), None));
    }

    #[test]
    fn notes_block_truncates_long_note_and_says_so() {
        let long = "가".repeat(NOTE_CAP + 5);
        let (block, notice) = notes_block(&[doc("긴.md", &long)]);
        assert!(block.contains(&format!("{}\n{TRUNCATED}\n</note>", "가".repeat(NOTE_CAP))));
        assert!(!block.contains(&"가".repeat(NOTE_CAP + 1)));
        assert_eq!(notice.as_deref(), Some("길어서 앞부분만 보낸 노트: 긴(앞 12,000자)"));
    }

    #[test]
    fn notes_block_caps_total_and_drops_the_rest() {
        let docs: Vec<NoteDoc> = (0..7).map(|i| doc(&format!("n{i}.md"), &"x".repeat(11_000))).collect();
        let (block, notice) = notes_block(&docs);
        // 5 × 11,000 = 55,000; the sixth gets the remaining 5,000; the seventh is left out.
        assert_eq!(block.matches("<note ").count(), 6);
        assert_eq!(block.matches('x').count(), BLOCK_CAP);
        assert_eq!(
            notice.as_deref(),
            Some("길어서 앞부분만 보낸 노트: n5(앞 5,000자) / 전체 분량 한도(60,000자)를 넘어 보내지 않은 노트: n6")
        );
    }

    #[test]
    fn input_per_provider() {
        let block = "<참고 노트>\n</참고 노트>\n\n";
        assert_eq!(build_input(Provider::Claude, "sys", block, "질문"), format!("{block}질문"));
        assert_eq!(build_input(Provider::Codex, "sys", block, "질문"), format!("<지침>\nsys\n</지침>\n\n{block}질문"));
        assert_eq!(build_input(Provider::Codex, " ", "", "질문"), "질문");
    }

    #[test]
    fn cli_args_keep_tools_off() {
        let a = claude_args("시스템", false);
        let s: Vec<&str> = a.iter().map(|x| x.to_str().unwrap()).collect();
        assert_eq!(&s[..3], &["-p", "--tools", ""]);
        assert!(s.ends_with(&["--system-prompt", "시스템"]));
        assert!(!s.iter().any(|x| x.contains("Web")));
        let c = codex_args(Path::new("T"), false);
        let s: Vec<&str> = c.iter().map(|x| x.to_str().unwrap()).collect();
        assert_eq!(
            s,
            [
                "exec",
                "--json",
                "--sandbox",
                "read-only",
                "--skip-git-repo-check",
                "--ephemeral",
                "--ignore-user-config",
                "-C",
                "T",
                "-"
            ]
        );
    }

    #[test]
    fn web_runs_add_only_web_tools() {
        let a = claude_args("", true);
        let s: Vec<&str> = a.iter().map(|x| x.to_str().unwrap()).collect();
        assert_eq!(&s[..5], &["-p", "--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch,WebFetch"]);
        let c = codex_args(Path::new("T"), true);
        let s: Vec<&str> = c.iter().map(|x| x.to_str().unwrap()).collect();
        assert_eq!(&s[..2], &["--search", "exec"]);
        assert!(s.windows(2).any(|w| w == ["--sandbox", "read-only"]));
    }

    #[test]
    fn web_steps_become_progress() {
        let mut claude = Parser::new(Provider::Claude, true);
        let evs = claude.feed(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"찾아보겠습니다"},{"type":"tool_use","name":"WebSearch","input":{"query":"tauri 최신 버전"}},{"type":"tool_use","name":"WebFetch","input":{"url":"https://v2.tauri.app/release/","prompt":"x"}}]}}"#,
        );
        assert_eq!(
            evs,
            vec![AiEvent::Progress {
                message: "웹 검색: tauri 최신 버전\n페이지 읽기: https://v2.tauri.app/release/".into()
            }]
        );
        assert!(claude.feed(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"답"}]}}"#).is_empty());

        let mut codex = Parser::new(Provider::Codex, true);
        let lines = [
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"확인하겠습니다."}}"#,
            r#"{"type":"item.completed","item":{"type":"web_search","query":"q","action":{"type":"search","query":"tauri releases"}}}"#,
            r#"{"type":"item.completed","item":{"type":"web_search","query":"u","action":{"type":"open_page","url":"https://v2.tauri.app/release/tauri/"}}}"#,
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"최신은 2.12.3입니다."}}"#,
            r#"{"type":"turn.completed"}"#,
        ];
        let evs: Vec<AiEvent> = lines.iter().flat_map(|l| codex.feed(l)).collect();
        assert!(evs.contains(&AiEvent::Progress { message: "웹 검색: tauri releases".into() }));
        assert!(
            evs.contains(&AiEvent::Progress {
                message: "페이지 읽기: https://v2.tauri.app/release/tauri/".into()
            })
        );
        assert_eq!(evs.last(), Some(&AiEvent::Done { text: "최신은 2.12.3입니다.".into(), cost_usd: None }));
    }

    // ----- parsing -----

    fn feed_all(p: Provider, lines: &[&str]) -> (Parser, Vec<AiEvent>) {
        let mut parser = Parser::new(p, false);
        let evs = lines.iter().flat_map(|l| parser.feed(l)).collect();
        (parser, evs)
    }

    #[test]
    fn claude_stream_success() {
        let (_, evs) = feed_all(
            Provider::Claude,
            &[
                r#"{"type":"system","subtype":"init","model":"claude-opus-5-5","tools":[]}"#,
                r#"{"type":"stream_event","event":{"type":"message_start","message":{}}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"서"}}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{"}}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"울"}}}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"서울"}]}}"#,
                "not json at all",
                "",
                r#"{"type":"result","subtype":"success","is_error":false,"result":"서울","total_cost_usd":0.0178}"#,
            ],
        );
        assert_eq!(
            evs,
            vec![
                AiEvent::Started { model: Some("claude-opus-5-5".into()) },
                AiEvent::Delta { text: "서".into() },
                AiEvent::Delta { text: "울".into() },
                AiEvent::Done { text: "서울".into(), cost_usd: Some(0.0178) },
            ]
        );
    }

    #[test]
    fn claude_errors() {
        let (_, evs) = feed_all(
            Provider::Claude,
            &[r#"{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}"#],
        );
        assert_eq!(evs, vec![AiEvent::Error { message: Provider::Claude.login_hint().into() }]);

        let (_, evs) =
            feed_all(Provider::Claude, &[r#"{"type":"result","subtype":"error_during_execution","is_error":true}"#]);
        assert_eq!(evs, vec![AiEvent::Error { message: "Claude Code 오류: error_during_execution".into() }]);

        let p = Parser::new(Provider::Claude, false);
        assert_eq!(
            p.finish(false, Some(1), "Error: Invalid API key\n"),
            AiEvent::Error { message: Provider::Claude.login_hint().into() }
        );
        assert_eq!(
            p.finish(false, Some(2), ""),
            AiEvent::Error { message: "Claude Code이(가) 오류로 종료되었습니다 (종료 코드 2)".into() }
        );
        assert_eq!(p.finish(false, Some(1), "boom"), AiEvent::Error { message: "Claude Code 오류: boom".into() });
    }

    #[test]
    fn codex_stream_success() {
        let (parser, evs) = feed_all(
            Provider::Codex,
            &[
                "2026-10-28T01:02:03Z WARN codex_core: something noisy",
                r#"{"type":"thread.started","thread_id":"t1"}"#,
                r#"{"type":"turn.started"}"#,
                r#"{"type":"item.completed","item":{"id":"i0","type":"reasoning","text":"생각"}}"#,
                r#"{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"서울"}}"#,
                r#"{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"입니다"}}"#,
                r#"{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}"#,
            ],
        );
        assert_eq!(
            evs,
            vec![
                AiEvent::Started { model: None },
                AiEvent::Delta { text: "서울".into() },
                AiEvent::Delta { text: "\n\n입니다".into() },
                AiEvent::Done { text: "서울\n\n입니다".into(), cost_usd: None },
            ]
        );
        // exiting cleanly after messages but without turn.completed still counts as done
        assert_eq!(parser.finish(true, Some(0), ""), AiEvent::Done { text: "서울\n\n입니다".into(), cost_usd: None });
    }

    #[test]
    fn codex_errors() {
        let (parser, evs) = feed_all(
            Provider::Codex,
            &[
                r#"{"type":"thread.started"}"#,
                r#"{"type":"error","message":"Reconnecting... 1/5"}"#,
                r#"{"type":"turn.failed","error":{"message":"The 'gpt-x' model is not supported"}}"#,
            ],
        );
        assert_eq!(
            evs,
            vec![
                AiEvent::Started { model: None },
                AiEvent::Error { message: "Codex (ChatGPT) 오류: The 'gpt-x' model is not supported".into() },
            ]
        );
        assert!(matches!(parser.finish(false, Some(1), ""), AiEvent::Error { .. }));

        let (parser, evs) =
            feed_all(Provider::Codex, &[r#"{"type":"error","message":"unexpected status 401 Unauthorized"}"#]);
        assert!(evs.is_empty());
        assert_eq!(
            parser.finish(false, Some(1), "ignored"),
            AiEvent::Error { message: Provider::Codex.login_hint().into() }
        );

        let parser = Parser::new(Provider::Codex, false);
        assert_eq!(
            parser.finish(true, Some(0), ""),
            AiEvent::Error { message: "Codex (ChatGPT)이(가) 응답 없이 종료되었습니다".into() }
        );
    }

    #[test]
    fn emitter_sends_one_terminal_event() {
        let got = std::cell::RefCell::new(Vec::new());
        let sink = |e: AiEvent| got.borrow_mut().push(e);
        let mut em = Emitter { sink: &sink, finished: false };
        em.emit(AiEvent::Delta { text: "a".into() });
        em.emit(AiEvent::Done { text: "a".into(), cost_usd: None });
        em.emit(AiEvent::Error { message: "late".into() });
        em.emit(AiEvent::Delta { text: "b".into() });
        assert_eq!(got.borrow().len(), 2);
    }

    #[test]
    fn event_json_shape() {
        let j = |e: AiEvent| serde_json::to_string(&e).unwrap();
        assert_eq!(j(AiEvent::Started { model: None }), r#"{"kind":"started","model":null}"#);
        assert_eq!(
            j(AiEvent::Done { text: "t".into(), cost_usd: Some(0.5) }),
            r#"{"kind":"done","text":"t","cost_usd":0.5}"#
        );
        assert_eq!(j(AiEvent::Error { message: "m".into() }), r#"{"kind":"error","message":"m"}"#);
    }

    // ----- provider detection -----

    #[test]
    fn version_and_login_parsing() {
        assert_eq!(parse_version("2.1.312 (Claude Code)\n").as_deref(), Some("2.1.312"));
        assert_eq!(parse_version("codex-cli 0.154.0\n\n").as_deref(), Some("0.154.0"));
        assert_eq!(parse_version("tool v1.2.3").as_deref(), Some("1.2.3"));
        assert_eq!(parse_version("no version here"), None);

        assert_eq!(parse_login(true, "Logged in using ChatGPT\n"), Some(true));
        assert_eq!(parse_login(false, "Not logged in\n"), Some(false));
        assert_eq!(parse_login(false, "error: something"), Some(false));
        assert_eq!(parse_login(true, ""), None);

        let out = r#"{ "loggedIn": true, "authMethod": "claude.ai", "email": "a@b.c" }"#;
        assert_eq!(parse_claude_auth(out), Some(true));
        assert_eq!(parse_claude_auth("warning\n{\"loggedIn\": false}\n"), Some(false));
        assert_eq!(parse_claude_auth("error: unknown command 'auth'"), None);
        assert_eq!(Provider::Codex.parse_status(false, "Not logged in"), Some(false));
    }

    #[test]
    fn provider_status_cases() {
        let s = provider_status(Provider::Claude, false, None, None);
        assert!(!s.available);
        assert_eq!(s.detail.as_deref(), Some("Claude Code가 설치되어 있지 않습니다"));

        let s = provider_status(Provider::Claude, true, Some("2.1.312 (Claude Code)"), None);
        assert_eq!(
            s,
            AiProvider {
                id: "claude".into(),
                name: "Claude Code".into(),
                available: true,
                version: Some("2.1.312".into()),
                logged_in: None,
                detail: None,
            }
        );

        let s = provider_status(Provider::Codex, true, Some("codex-cli 0.154.0"), Some(true));
        assert!(s.available);
        assert_eq!(s.logged_in, Some(true));
        assert_eq!(s.name, "Codex (ChatGPT)");

        let s = provider_status(Provider::Claude, true, Some("2.1.312 (Claude Code)"), Some(false));
        assert!(!s.available);
        assert_eq!(s.detail.as_deref(), Some("로그인이 필요합니다"));

        let s = provider_status(Provider::Codex, true, None, None);
        assert!(!s.available);
        assert!(s.detail.unwrap().contains("--version"));
    }

    #[test]
    #[ignore = "opens a console window; needs claude or codex installed"]
    fn console_command_runs_and_waits() {
        let l = locate(Provider::Codex).or_else(|| locate(Provider::Claude)).expect("no AI CLI installed");
        let started = Instant::now();
        let st = console_command(&l, "Notevine 테스트", &["--version"]).status().unwrap();
        assert!(st.success(), "{st:?}");
        assert!(started.elapsed() > Duration::from_millis(100), "returned before the CLI ran");
    }

    #[test]
    fn npm_shim_parsing() {
        let shim = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\n\
                    CALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n\
                    \x20 SET \"_prog=node\"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || \
                    title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n";
        assert_eq!(npm_shim_script(shim).as_deref(), Some("node_modules/@openai/codex/bin/codex.js"));
        assert_eq!(npm_shim_script("@ECHO off\r\n\"%dp0%\\node.exe\" \"%dp0%\\x.exe\" %*"), None);
    }

    // ----- context notes -----

    #[test]
    fn context_notes_rank_by_keyword_hits() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        fs::write(dir.path().join("예산 회의.md"), "회의에서 예산을 정했다.").unwrap();
        fs::write(dir.path().join("일기.md"), "오늘 회의가 길었다.").unwrap();
        fs::write(dir.path().join("무관.md"), "아무 내용 없음").unwrap();
        v.index().scan(v.root()).unwrap();

        let got = context_notes(&v, "예산 회의는 언제였지?", 0).unwrap().notes;
        let paths: Vec<&str> = got.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(paths, ["예산 회의.md", "일기.md"]);
        assert_eq!(got[0].title, "예산 회의");
        assert_eq!(got[0].chars, "회의에서 예산을 정했다.".chars().count() as u32);
        assert!(got[1].snippet.contains("회의"));
        assert!(got.iter().all(|c| c.snippet.chars().count() <= SNIPPET_MAX));
        assert!(context_notes(&v, "뭐 알려줘", 5).unwrap().notes.is_empty());
    }

    #[test]
    fn load_note_stays_inside_vault() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        fs::write(dir.path().join("a.md"), "hi").unwrap();
        assert_eq!(load_note(&v, "a.md").unwrap().content, "hi");
        assert!(load_note(&v, "../a.md").is_err());
        assert!(load_note(&v, ".app/index.db").is_err());
        assert!(load_note(&v, "missing.md").is_err());
    }

    #[test]
    fn cancel_kills_the_process_and_reports_once() {
        let (program, args): (&str, Vec<OsString>) = if cfg!(windows) {
            ("ping", ["-n", "30", "127.0.0.1"].iter().map(OsString::from).collect())
        } else {
            ("sleep", vec!["30".into()])
        };
        let launcher = Launcher { program: program.into(), pre_args: Vec::new() };
        let id = "test-cancel";
        let cancel = register_run(id).unwrap();
        let workdir = make_workdir().unwrap();
        let canceller = std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(500));
            ai_cancel("test-cancel".into()).unwrap()
        });
        let events = std::cell::RefCell::new(Vec::new());
        let sink = |e: AiEvent| events.borrow_mut().push(e);
        let started = Instant::now();
        let job = Job { p: Provider::Codex, system: "", input: "", web: false };
        execute(id, job, &launcher, &args, &workdir, &cancel, &sink);
        unregister_run(id);
        let _ = fs::remove_dir_all(&workdir);
        assert!(canceller.join().unwrap());
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(events.into_inner(), vec![AiEvent::Error { message: "요청을 취소했습니다".into() }]);
        assert!(!ai_cancel(id.into()).unwrap());
    }

    // ----- live (uses the real CLIs and the user's subscription) -----

    #[test]
    #[ignore]
    fn detect_live() {
        let t = Instant::now();
        let list = detect_providers();
        println!("detection took {:?}: {list:#?}", t.elapsed());
    }

    #[test]
    #[ignore]
    fn ai_live() {
        let t = Instant::now();
        let providers = detect_providers();
        println!("detection took {:?}: {providers:#?}", t.elapsed());
        let mut ran = 0;
        for p in [Provider::Claude, Provider::Codex] {
            let status = providers.iter().find(|s| s.id == p.id()).unwrap();
            if !status.available {
                println!("{}: skipped ({:?})", p.id(), status.detail);
                continue;
            }
            ran += 1;
            let id = format!("live-{}", p.id());
            let cancel = register_run(&id).unwrap();
            let events = std::cell::RefCell::new(Vec::new());
            let sink = |e: AiEvent| events.borrow_mut().push(e);
            let system = "질문에 아주 짧게 답한다.";
            let input = build_input(p, system, "", "한 단어로만 답해: 대한민국의 수도는?");
            let started = Instant::now();
            run_request(&id, Job { p, system, input: &input, web: false }, None, &cancel, &sink);
            unregister_run(&id);
            let events = events.into_inner();
            println!("{} ({:?}): {events:?}", p.id(), started.elapsed());
            assert_eq!(events.iter().filter(|e| e.is_terminal()).count(), 1);
            match events.last().unwrap() {
                AiEvent::Done { text, .. } => assert!(text.contains("서울"), "{text}"),
                other => panic!("{}: {other:?}", p.id()),
            }
        }
        assert!(ran > 0, "no AI CLI available");
    }
}
