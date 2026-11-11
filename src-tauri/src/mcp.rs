//! MCP (Model Context Protocol) server: AI tools on this PC (Claude Code, Claude
//! Desktop, Codex) search, read and — if allowed — write the notes of one vault.
//!
//! Started as `notevine --mcp [--vault <folder>]` by the AI tool itself, it talks
//! JSON-RPC over stdin/stdout, one message per line. No port is ever opened.
//! Without `--vault` it follows the vault last opened in the app, checked before each
//! tool call, so switching vaults there needs no change in the AI tool.
//!
//! Rules this module keeps:
//! - stdout carries protocol messages only. Anything else goes to stderr.
//! - Nothing is allowed until the user turns it on for this vault in the app's
//!   settings ([`McpGrant`], kept outside the vault in `vault-trust.json`). The grant
//!   is read again on every call, so turning it off takes effect at once.
//! - Writing is a second, separate permission.
//! - `#비공개` notes, dot-folders (`.app`, `.git`, ...) and the folders the user
//!   excluded are never listed, searched, read or written.
//! - Every write goes through [`Vault::save_note_from`], so it is in the note's
//!   history (origin "mcp") and can be undone.

use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread::JoinHandle;

use serde::Serialize;
use serde_json::{Value, json};

use crate::ai::is_private;
use crate::drive;
use crate::error::{AppError, AppResult};
use crate::history::Origin;
use crate::index::Index;
use crate::paths::{check_rel, is_hidden, is_note, name_key, normalize_rel};
use crate::recent::RecentStore;
use crate::search::{DateField, DateFilter, PropFilter, SearchQuery, search};
use crate::trust::{McpGrant, TrustStore};
use crate::vault::{EntryKind, TreeNode, Vault, content_hash};

/// Same as `identifier` in `tauri.conf.json` (checked by a test): the app's
/// settings live in `%APPDATA%\<identifier>`, its local data in `%LOCALAPPDATA%\<identifier>`.
const IDENTIFIER: &str = "net.notevine.app";
/// Newest first. The answer to `initialize` is the client's version when listed here.
const PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];
/// Characters of one note returned at most (same as a document sent to AI in `ai.rs`).
const NOTE_CAP: usize = 40_000;
const TRUNCATED: &str = "\n…(이하 생략)";
const DEFAULT_SEARCH: u32 = 20;
const MAX_SEARCH: u32 = 100;
/// Entries `list_notes` returns at most.
const MAX_LIST: usize = 1_000;
const DEFAULT_HISTORY: usize = 20;
/// Lines kept in the activity log the settings screen shows.
const ACTIVITY_KEEP: usize = 200;
pub const ACTIVITY_FILE: &str = "mcp-activity.jsonl";

const OFF: &str = "이 노트 폴더는 AI 도구 연결이 꺼져 있습니다. Notevine 설정 → AI → 외부 AI 도구 연결에서 켜 주세요.";
const NO_WRITE: &str = "이 노트 폴더는 AI 도구의 노트 만들기·고치기가 허용되지 않았습니다. Notevine 설정 → AI → 외부 AI 도구 연결에서 허용할 수 있습니다.";
const HIDDEN: &str = "AI 도구에 보이지 않는 노트나 폴더입니다(#비공개, 연결하지 않을 폴더, 숨김 폴더).";

const INSTRUCTIONS: &str = "Notevine note folder (vault) of Markdown notes. Paths are vault-relative with '/' (e.g. '업무일지/2026-11-10.md'). \
Notes link with [[wiki links]] and carry #tags and YAML frontmatter properties. \
Use search_notes to find notes, read_note to read one (it returns a hash), and update_note with that hash to change it. \
Notes tagged #비공개 and folders the user excluded are invisible on purpose; do not try to reach them. \
Every write is kept in the note's history in Notevine, where the user can undo it. The vault is the one last opened in the Notevine app; a tool answer says so when it changed.";

/// `%APPDATA%\net.notevine.app`, or `…\net.notevine.app.dev` for a development build,
/// like `config_dir` in `lib.rs`.
pub fn config_dir() -> AppResult<PathBuf> {
    let base = std::env::var_os("APPDATA").ok_or_else(|| AppError::System("APPDATA가 없습니다".into()))?;
    let name = if crate::DEV_BUILD { format!("{IDENTIFIER}.dev") } else { IDENTIFIER.to_string() };
    Ok(PathBuf::from(base).join(name))
}

/// `%LOCALAPPDATA%\net.notevine.app`, where drive vaults keep their databases.
fn local_base() -> AppResult<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA").ok_or_else(|| AppError::System("LOCALAPPDATA가 없습니다".into()))?;
    Ok(PathBuf::from(base).join(IDENTIFIER))
}

/// Runs the server until stdin closes. Returns the process exit code.
pub fn serve(args: &[String]) -> i32 {
    match start(args) {
        Ok(mut server) => {
            let stdin = std::io::stdin();
            let stdout = std::io::stdout();
            server.run(stdin.lock(), stdout.lock());
            0
        }
        Err(e) => {
            eprintln!("notevine mcp: {e}");
            1
        }
    }
}

fn start(args: &[String]) -> AppResult<Server> {
    let config = config_dir()?;
    let root = match arg_value(args, "--vault") {
        Some(p) => PathBuf::from(p),
        None => {
            RecentStore::new(&config).list().into_iter().next().map(|v| PathBuf::from(v.path)).ok_or_else(|| {
                AppError::System("--vault로 노트 폴더를 알려 주세요 (최근에 연 노트 폴더가 없습니다)".into())
            })?
        }
    };
    let local_base = local_base()?;
    let vault = Vault::open_placed(&root, &local_base, &drive::installed())?;
    let mut server = Server::new(vault, &config);
    if arg_value(args, "--vault").is_none() {
        server.follow = Some(local_base);
    }
    if !server.grant().enabled {
        eprintln!("notevine mcp: {OFF} ({})", server.vault.root().display());
    }
    server.scanning = Mutex::new(Some(start_scan(&server.vault)));
    Ok(server)
}

/// Notes changed while the app was closed: brings the index up to date on its own
/// connection, so `initialize` and reading answer at once even in a large vault.
/// Tools that use the index wait for it ([`Server::index_ready`]).
fn start_scan(vault: &Vault) -> JoinHandle<()> {
    let store = vault.store_dir();
    let root = vault.root().to_path_buf();
    std::thread::spawn(move || {
        if let Err(e) = Index::open(&store.join("index.db")).and_then(|ix| ix.scan(&root)) {
            eprintln!("notevine mcp: 검색 인덱스: {e}");
        }
    })
}

fn arg_value<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    let i = args.iter().position(|a| a == name)?;
    args.get(i + 1).map(String::as_str)
}

/// One line of the activity log: which tool touched what, never note text.
#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct Activity {
    /// ms since epoch
    pub at: i64,
    pub vault: String,
    pub tool: String,
    pub target: String,
    pub ok: bool,
}

/// Recent activity for one vault, newest first.
pub fn read_activity(config: &Path, vault: &Path) -> Vec<Activity> {
    let want = vault.display().to_string();
    let mut out: Vec<Activity> = fs::read_to_string(config.join(ACTIVITY_FILE))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Activity>(l).ok())
        .filter(|a| a.vault.eq_ignore_ascii_case(&want))
        .collect();
    out.reverse();
    out
}

fn append_activity(config: &Path, a: &Activity) -> AppResult<()> {
    let file = config.join(ACTIVITY_FILE);
    let mut lines: Vec<String> = fs::read_to_string(&file).unwrap_or_default().lines().map(str::to_string).collect();
    lines.push(serde_json::to_string(a)?);
    let skip = lines.len().saturating_sub(ACTIVITY_KEEP);
    fs::create_dir_all(config)?;
    fs::write(&file, lines[skip..].join("\n") + "\n")?;
    Ok(())
}

pub struct Server {
    vault: Vault,
    trust: TrustStore,
    config: PathBuf,
    /// The start-up index scan, until a tool that needs the index has waited for it.
    scanning: Mutex<Option<JoinHandle<()>>>,
    /// Started without `--vault`: before each tool, switch to the vault last opened in
    /// the app (its `local_base`), so changing vaults there needs nothing here.
    follow: Option<PathBuf>,
}

/// A tool's failure the AI should read (MCP `isError`), as opposed to a protocol error.
struct ToolError(String);

impl From<AppError> for ToolError {
    fn from(e: AppError) -> Self {
        ToolError(e.to_string())
    }
}

impl From<serde_json::Error> for ToolError {
    fn from(e: serde_json::Error) -> Self {
        ToolError(e.to_string())
    }
}

type ToolResult = Result<(String, String), ToolError>;

impl Server {
    pub fn new(vault: Vault, config: &Path) -> Self {
        Self {
            vault,
            trust: TrustStore::new(config),
            config: config.to_path_buf(),
            scanning: Mutex::new(None),
            follow: None,
        }
    }

    /// In follow mode, opens the vault the app opened last if it is another one.
    /// Returns the notice for the AI when the vault changed.
    fn follow_app(&mut self) -> Result<Option<String>, ToolError> {
        let Some(local_base) = &self.follow else { return Ok(None) };
        let Some(latest) = RecentStore::new(&self.config).list().into_iter().next() else { return Ok(None) };
        if latest.path.eq_ignore_ascii_case(&self.vault.root().display().to_string()) {
            return Ok(None);
        }
        let vault = Vault::open_placed(Path::new(&latest.path), local_base, &drive::installed()).map_err(|e| {
            ToolError(format!("Notevine에서 마지막으로 연 노트 폴더를 열지 못했습니다 ({}): {e}", latest.path))
        })?;
        // The old vault's scan, if still running, finishes on its own.
        self.scanning = Mutex::new(Some(start_scan(&vault)));
        self.vault = vault;
        Ok(Some(format!(
            "(Notevine에서 연 노트 폴더가 바뀌었습니다: {}. 이전 폴더에서 읽은 경로·hash는 이 폴더와 맞지 않습니다.)\n\n",
            self.vault.root().display()
        )))
    }

    /// Waits for the start-up scan: before it ends, a new vault's index is empty and
    /// a search would find nothing.
    fn index_ready(&self) {
        let scan = self.scanning.lock().expect("scan lock poisoned").take();
        if let Some(scan) = scan {
            let _ = scan.join();
        }
    }

    fn grant(&self) -> McpGrant {
        self.trust.get(self.vault.root()).mcp
    }

    /// Reads one message per line until the input ends.
    pub fn run(&mut self, input: impl BufRead, mut output: impl Write) {
        for line in input.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            let reply = match serde_json::from_str::<Value>(&line) {
                Ok(Value::Array(batch)) => {
                    let replies: Vec<Value> = batch.into_iter().filter_map(|m| self.handle(m)).collect();
                    (!replies.is_empty()).then_some(Value::Array(replies))
                }
                Ok(msg) => self.handle(msg),
                Err(e) => Some(rpc_error(Value::Null, -32700, &format!("parse error: {e}"))),
            };
            if let Some(reply) = reply {
                let ok = writeln!(output, "{reply}").and_then(|_| output.flush());
                if ok.is_err() {
                    break;
                }
            }
        }
    }

    /// The reply to one message; `None` for a notification.
    pub fn handle(&mut self, msg: Value) -> Option<Value> {
        let id = msg.get("id").cloned();
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        // A notification (no id) never gets an answer, whatever it is.
        let id = id?;
        Some(match method {
            "initialize" => rpc_result(id, self.initialize(&params)),
            "ping" => rpc_result(id, json!({})),
            "tools/list" => rpc_result(id, json!({ "tools": tool_list() })),
            "tools/call" => match self.call(&params) {
                Ok(v) => rpc_result(id, v),
                Err((code, m)) => rpc_error(id, code, &m),
            },
            "resources/list" => rpc_result(id, json!({ "resources": [] })),
            "prompts/list" => rpc_result(id, json!({ "prompts": [] })),
            _ => rpc_error(id, -32601, &format!("method not found: {method}")),
        })
    }

    fn initialize(&self, params: &Value) -> Value {
        let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
        let version = PROTOCOL_VERSIONS.iter().find(|v| **v == asked).copied().unwrap_or(PROTOCOL_VERSIONS[0]);
        json!({
            "protocolVersion": version,
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": "notevine", "title": "Notevine", "version": env!("CARGO_PKG_VERSION") },
            "instructions": INSTRUCTIONS,
        })
    }

    fn call(&mut self, params: &Value) -> Result<Value, (i64, String)> {
        let name = params.get("name").and_then(Value::as_str).ok_or((-32602, "missing tool name".to_string()))?;
        let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
        let tool = TOOLS.iter().find(|t| t.name == name).ok_or((-32602, format!("unknown tool: {name}")))?;
        let result = self.follow_app().and_then(|notice| {
            let (text, target) = self.run_tool(tool, &args)?;
            Ok((notice.unwrap_or_default() + &text, target))
        });
        let target = match &result {
            Ok((_, target)) => target.clone(),
            Err(_) => args.get("path").or_else(|| args.get("folder")).and_then(Value::as_str).unwrap_or("").to_string(),
        };
        let activity = Activity {
            at: crate::history::now_ms(),
            vault: self.vault.root().display().to_string(),
            tool: name.to_string(),
            target,
            ok: result.is_ok(),
        };
        if let Err(e) = append_activity(&self.config, &activity) {
            eprintln!("notevine mcp: 활동 기록: {e}");
        }
        Ok(match result {
            Ok((text, _)) => json!({ "content": [{ "type": "text", "text": text }], "isError": false }),
            Err(ToolError(m)) => json!({ "content": [{ "type": "text", "text": m }], "isError": true }),
        })
    }

    /// Runs a tool: `(text for the AI, target for the activity log)`.
    fn run_tool(&self, tool: &Tool, args: &Value) -> ToolResult {
        let grant = self.grant();
        if !grant.enabled {
            return Err(ToolError(OFF.into()));
        }
        if tool.writes && !grant.write {
            return Err(ToolError(NO_WRITE.into()));
        }
        let gate = Gate::new(&grant);
        match tool.name {
            "list_notes" => self.list_notes(&gate, args),
            "read_note" => self.read_note(&gate, args),
            "search_notes" => self.search_notes(&gate, args),
            "get_backlinks" => self.get_backlinks(&gate, args),
            "get_note_history" => self.get_note_history(&gate, args),
            "create_note" => self.create_note(&gate, args),
            "append_to_note" => self.append_to_note(&gate, args),
            "update_note" => self.update_note(&gate, args),
            _ => Err(ToolError(format!("unknown tool: {}", tool.name))),
        }
    }

    /// A note AI tools may see: allowed path, an existing `.md`, not `#비공개`.
    fn visible_note(&self, gate: &Gate, path: &str) -> Result<(String, String), ToolError> {
        let rel = gate.path(path)?;
        if !is_note(&rel) {
            return Err(ToolError(format!("노트(.md)가 아닙니다: {rel}")));
        }
        let content = self.vault.read_note(&rel)?;
        if is_private(&content) {
            return Err(ToolError(HIDDEN.into()));
        }
        Ok((rel, content))
    }

    fn private_notes(&self) -> HashSet<String> {
        self.index_ready();
        let sql = "SELECT DISTINCT n.path FROM tags t JOIN notes n ON n.id = t.note_id
                   WHERE t.tag_key = ?1 OR t.tag_key LIKE ?2";
        let tag = crate::ai::PRIVATE_TAG;
        let Ok(mut st) = self.vault.index().conn().prepare(sql) else { return HashSet::new() };
        st.query_map([tag.to_string(), format!("{tag}/%")], |r| r.get::<_, String>(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    fn list_notes(&self, gate: &Gate, args: &Value) -> ToolResult {
        let folder = gate.folder(str_arg(args, "folder").unwrap_or(""))?;
        let tree = self.vault.tree()?;
        let nodes = if folder.is_empty() {
            tree
        } else {
            find_children(tree, &folder).ok_or_else(|| ToolError(format!("폴더가 없습니다: {folder}")))?
        };
        let private = self.private_notes();
        let mut out = Vec::new();
        let mut truncated = false;
        flatten(&nodes, gate, &private, &mut out, &mut truncated);
        let text = serde_json::to_string_pretty(&json!({ "folder": folder, "entries": out, "truncated": truncated }))?;
        Ok((text, folder))
    }

    fn read_note(&self, gate: &Gate, args: &Value) -> ToolResult {
        let (rel, content) = self.visible_note(gate, required(args, "path")?)?;
        let hash = content_hash(&content);
        let mut body: String = content.chars().take(NOTE_CAP).collect();
        if body.len() < content.len() {
            body.push_str(TRUNCATED);
        }
        Ok((format!("path: {rel}\nhash: {hash}\n\n{body}"), rel))
    }

    fn search_notes(&self, gate: &Gate, args: &Value) -> ToolResult {
        let limit =
            args.get("limit").and_then(Value::as_u64).map(|n| n as u32).unwrap_or(DEFAULT_SEARCH).clamp(1, MAX_SEARCH);
        let date = match (date_arg(args, "modified_from", false)?, date_arg(args, "modified_to", true)?) {
            (None, None) => None,
            (from, to) => Some(DateFilter { field: DateField::Modified, from, to }),
        };
        let props: Vec<PropFilter> = match args.get("props") {
            Some(p) => serde_json::from_value(p.clone())?,
            None => Vec::new(),
        };
        let q = SearchQuery {
            text: str_list(args, "text"),
            tags: str_list(args, "tags"),
            props,
            date,
            limit: Some(limit * 2),
        };
        if q.text.is_empty() && q.tags.is_empty() && q.props.is_empty() && q.date.is_none() {
            return Err(ToolError("text, tags, props, modified_from/to 중 하나는 있어야 합니다".into()));
        }
        self.index_ready();
        let found = search(self.vault.index(), &q)?;
        let private = self.private_notes();
        let mut hits = Vec::new();
        for h in found.hits {
            if hits.len() as u32 >= limit {
                break;
            }
            if !gate.allows(&h.path) || private.contains(&h.path) {
                continue;
            }
            // The index may lag a tag typed a moment ago: the file decides.
            if self.vault.abs(&h.path).ok().and_then(|p| fs::read_to_string(p).ok()).is_some_and(|c| is_private(&c)) {
                continue;
            }
            let snippet: String = h.parts.iter().map(|p| p.text.as_str()).collect();
            hits.push(json!({ "path": h.path, "title": h.title, "modified": iso(h.mtime), "line": h.line, "snippet": snippet }));
        }
        let target = q.text.join(" ");
        let text = serde_json::to_string_pretty(&json!({ "hits": hits, "total_matches": found.total }))?;
        Ok((text, target))
    }

    fn get_backlinks(&self, gate: &Gate, args: &Value) -> ToolResult {
        let (rel, _) = self.visible_note(gate, required(args, "path")?)?;
        let private = self.private_notes(); // waits for the index, which backlinks need too
        let links: Vec<Value> = self
            .vault
            .backlinks(&rel)?
            .into_iter()
            .filter(|b| gate.allows(&b.path) && !private.contains(&b.path))
            .map(|b| json!({ "path": b.path, "title": b.title, "line": b.line, "context": b.context }))
            .collect();
        Ok((serde_json::to_string_pretty(&json!({ "path": rel, "backlinks": links }))?, rel))
    }

    fn get_note_history(&self, gate: &Gate, args: &Value) -> ToolResult {
        let (rel, _) = self.visible_note(gate, required(args, "path")?)?;
        let limit =
            args.get("limit").and_then(Value::as_u64).map(|n| n as usize).unwrap_or(DEFAULT_HISTORY).clamp(1, 200);
        let versions: Vec<Value> = self
            .vault
            .history()
            .list(&rel)?
            .into_iter()
            .take(limit)
            .map(|v| json!({ "saved_at": iso(v.saved_at), "origin": v.origin, "size": v.size }))
            .collect();
        Ok((serde_json::to_string_pretty(&json!({ "path": rel, "versions": versions }))?, rel))
    }

    fn create_note(&self, gate: &Gate, args: &Value) -> ToolResult {
        let folder = gate.folder(str_arg(args, "folder").unwrap_or(""))?;
        let content = required(args, "content")?;
        let name = str_arg(args, "name").map(str::trim).filter(|n| !n.is_empty());
        if let Some(n) = name
            && (n.contains('/') || n.contains('\\'))
        {
            return Err(ToolError("name에는 폴더를 넣지 말고 folder로 주세요".into()));
        }
        let rel = match name {
            Some(n) => {
                let n = n.strip_suffix(".md").unwrap_or(n);
                let file = self.vault.unique_name(&folder, n, ".md")?;
                self.vault.create_note_from(&folder, Some(&file), content, Origin::Mcp)?
            }
            None => self.vault.create_note_from(&folder, None, content, Origin::Mcp)?,
        };
        Ok((format!("만들었습니다: {rel}\nhash: {}", content_hash(content)), rel))
    }

    fn append_to_note(&self, gate: &Gate, args: &Value) -> ToolResult {
        let (rel, current) = self.visible_note(gate, required(args, "path")?)?;
        let addition = required(args, "content")?;
        let next = match str_arg(args, "heading").map(str::trim).filter(|h| !h.is_empty()) {
            Some(h) => insert_under_heading(&current, h, addition)
                .ok_or_else(|| ToolError(format!("제목을 찾지 못했습니다: {h}")))?,
            None => append_end(&current, addition),
        };
        self.save(&rel, &next)
    }

    fn update_note(&self, gate: &Gate, args: &Value) -> ToolResult {
        let (rel, current) = self.visible_note(gate, required(args, "path")?)?;
        let expected = required(args, "expected_hash")?;
        if content_hash(&current) != expected.trim() {
            return Err(ToolError("그사이 노트가 바뀌었습니다. read_note로 다시 읽은 뒤 고쳐 주세요.".into()));
        }
        self.save(&rel, required(args, "content")?)
    }

    fn save(&self, rel: &str, content: &str) -> ToolResult {
        let outcome = self.vault.save_note_from(rel, content, true, Origin::Mcp)?;
        if let Some(conflict) = outcome.conflict {
            return Err(ToolError(format!(
                "그사이 노트가 바뀌어 원본은 그대로 두고 새 내용을 {conflict}에 저장했습니다"
            )));
        }
        let mut text = format!("저장했습니다: {rel}\nhash: {}", content_hash(content));
        if let Some(w) = outcome.warning {
            text.push_str(&format!("\n주의: {w}"));
        }
        Ok((text, rel.to_string()))
    }
}

/// Which vault paths AI tools may reach.
struct Gate {
    /// `name_key` of each excluded folder.
    excluded: Vec<String>,
}

impl Gate {
    fn new(grant: &McpGrant) -> Self {
        Self {
            excluded: grant.excluded.iter().map(|f| name_key(&normalize_rel(f))).filter(|f| !f.is_empty()).collect(),
        }
    }

    fn allows(&self, rel: &str) -> bool {
        if rel.split('/').any(is_hidden) {
            return false;
        }
        let key = name_key(rel);
        !self.excluded.iter().any(|ex| key == *ex || key.starts_with(&format!("{ex}/")))
    }

    fn path(&self, raw: &str) -> Result<String, ToolError> {
        let rel = normalize_rel(raw);
        // `..` survives `normalize_rel` and is refused here.
        check_rel(&rel)?;
        if rel.is_empty() || !self.allows(&rel) {
            return Err(ToolError(HIDDEN.into()));
        }
        Ok(rel)
    }

    /// A folder, where "" is the vault itself.
    fn folder(&self, raw: &str) -> Result<String, ToolError> {
        if normalize_rel(raw).is_empty() {
            return Ok(String::new());
        }
        self.path(raw)
    }
}

fn find_children(nodes: Vec<TreeNode>, folder: &str) -> Option<Vec<TreeNode>> {
    let key = name_key(folder);
    for n in nodes {
        if n.kind != EntryKind::Folder {
            continue;
        }
        let k = name_key(&n.path);
        if k == key {
            return n.children;
        }
        if key.starts_with(&format!("{k}/")) {
            return find_children(n.children.unwrap_or_default(), folder);
        }
    }
    None
}

fn flatten(nodes: &[TreeNode], gate: &Gate, private: &HashSet<String>, out: &mut Vec<Value>, truncated: &mut bool) {
    for n in nodes {
        if out.len() >= MAX_LIST {
            *truncated = true;
            return;
        }
        if !gate.allows(&n.path) || private.contains(&n.path) {
            continue;
        }
        let kind = match n.kind {
            EntryKind::Folder => "folder",
            EntryKind::Note => "note",
            EntryKind::File => "file",
        };
        out.push(json!({ "path": n.path, "kind": kind, "modified": iso(n.mtime as i64) }));
        if let Some(children) = &n.children {
            flatten(children, gate, private, out, truncated);
        }
    }
}

/// Puts `addition` at the end of the section under the heading named `heading`
/// (before the next heading of the same or a higher level).
fn insert_under_heading(content: &str, heading: &str, addition: &str) -> Option<String> {
    let want = name_key(heading.trim_start_matches('#').trim());
    let lines: Vec<&str> = content.split_inclusive('\n').collect();
    let level_of = |l: &str| {
        let t = l.trim_end();
        let hashes = t.chars().take_while(|c| *c == '#').count();
        (hashes > 0 && hashes <= 6 && t[hashes..].starts_with(' ')).then(|| (hashes, t[hashes..].trim().to_string()))
    };
    let mut in_code = false;
    let mut start = None;
    let mut end = lines.len();
    for (i, l) in lines.iter().enumerate() {
        if l.trim_start().starts_with("```") {
            in_code = !in_code;
            continue;
        }
        if in_code {
            continue;
        }
        if let Some((level, text)) = level_of(l) {
            match start {
                None if name_key(&text) == want => start = Some(level),
                Some(open) if level <= open => {
                    end = i;
                    break;
                }
                _ => {}
            }
        }
    }
    start?;
    let before: String = lines[..end].concat();
    let after: String = lines[end..].concat();
    let mut out = append_end(&before, addition);
    if !after.is_empty() {
        out.push('\n');
        out.push_str(&after);
    }
    Some(out)
}

fn append_end(content: &str, addition: &str) -> String {
    let base = content.trim_end_matches('\n');
    let add = addition.trim_matches('\n');
    if base.is_empty() { format!("{add}\n") } else { format!("{base}\n\n{add}\n") }
}

fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default()
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn required<'a>(args: &'a Value, key: &str) -> Result<&'a str, ToolError> {
    str_arg(args, key).ok_or_else(|| ToolError(format!("{key}가 필요합니다")))
}

fn str_list(args: &Value, key: &str) -> Vec<String> {
    match args.get(key) {
        Some(Value::String(s)) if !s.trim().is_empty() => vec![s.trim().to_string()],
        Some(Value::Array(a)) => {
            a.iter().filter_map(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect()
        }
        _ => Vec::new(),
    }
}

/// `YYYY-MM-DD` as ms at the start of that day here, or its end for `end_of_day`.
fn date_arg(args: &Value, key: &str, end_of_day: bool) -> Result<Option<i64>, ToolError> {
    let Some(s) = str_arg(args, key).map(str::trim).filter(|s| !s.is_empty()) else { return Ok(None) };
    let day = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map_err(|_| ToolError(format!("{key}는 YYYY-MM-DD로 주세요: {s}")))?;
    let time = if end_of_day { day.and_hms_milli_opt(23, 59, 59, 999) } else { day.and_hms_opt(0, 0, 0) };
    let ms = time.and_then(|t| t.and_local_timezone(chrono::Local).earliest()).map(|t| t.timestamp_millis());
    Ok(ms)
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

struct Tool {
    name: &'static str,
    writes: bool,
    description: &'static str,
    schema: fn() -> Value,
}

const TOOLS: [Tool; 8] = [
    Tool {
        name: "list_notes",
        writes: false,
        description: "List folders and notes of the vault, or of one folder, with their last modified time.",
        schema: || json!({ "type": "object", "properties": { "folder": { "type": "string", "description": "Vault-relative folder; empty or omitted for the whole vault" } } }),
    },
    Tool {
        name: "read_note",
        writes: false,
        description: "Read one note (Markdown with frontmatter). Returns its hash, needed by update_note.",
        schema: || json!({ "type": "object", "properties": { "path": { "type": "string", "description": "Vault-relative .md path" } }, "required": ["path"] }),
    },
    Tool {
        name: "search_notes",
        writes: false,
        description: "Full-text search of notes. All terms, tags and property filters must match (AND). A phrase is one text element. A tag also matches its sub-tags.",
        schema: || {
            json!({ "type": "object", "properties": {
                "text": { "type": "array", "items": { "type": "string" }, "description": "Words or phrases, all required" },
                "tags": { "type": "array", "items": { "type": "string" }, "description": "Tags without '#'" },
                "props": { "type": "array", "description": "Frontmatter property filters", "items": { "type": "object", "properties": {
                    "key": { "type": "string" }, "op": { "type": "string", "enum": ["eq", "ne", "contains", "empty"] }, "value": { "type": "string" } }, "required": ["key", "op"] } },
                "modified_from": { "type": "string", "description": "YYYY-MM-DD" },
                "modified_to": { "type": "string", "description": "YYYY-MM-DD" },
                "limit": { "type": "integer", "minimum": 1, "maximum": MAX_SEARCH, "default": DEFAULT_SEARCH }
            } })
        },
    },
    Tool {
        name: "get_backlinks",
        writes: false,
        description: "Notes that link to this note, with the linking line.",
        schema: || json!({ "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] }),
    },
    Tool {
        name: "get_note_history",
        writes: false,
        description: "Saved versions of a note, newest first (time, origin: app/external/restore/mcp, size).",
        schema: || json!({ "type": "object", "properties": { "path": { "type": "string" }, "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": DEFAULT_HISTORY } }, "required": ["path"] }),
    },
    Tool {
        name: "create_note",
        writes: true,
        description: "Create a new note. A taken name gets a number added. Needs write permission in Notevine.",
        schema: || {
            json!({ "type": "object", "properties": {
                "folder": { "type": "string", "description": "Vault-relative folder, created if missing; empty for the vault root" },
                "name": { "type": "string", "description": "File name without folder; '.md' optional; omitted gives '제목 없음'" },
                "content": { "type": "string", "description": "Markdown" }
            }, "required": ["content"] })
        },
    },
    Tool {
        name: "append_to_note",
        writes: true,
        description: "Add text at the end of a note, or at the end of the section under a heading. Needs write permission in Notevine.",
        schema: || {
            json!({ "type": "object", "properties": {
                "path": { "type": "string" },
                "content": { "type": "string", "description": "Markdown to add" },
                "heading": { "type": "string", "description": "Heading text (without '#') whose section gets the text" }
            }, "required": ["path", "content"] })
        },
    },
    Tool {
        name: "update_note",
        writes: true,
        description: "Replace a note's whole text. expected_hash must be the hash read_note returned; if the note changed since, nothing is written. Needs write permission in Notevine.",
        schema: || {
            json!({ "type": "object", "properties": {
                "path": { "type": "string" },
                "content": { "type": "string", "description": "The note's full new Markdown" },
                "expected_hash": { "type": "string" }
            }, "required": ["path", "content", "expected_hash"] })
        },
    },
];

fn tool_list() -> Vec<Value> {
    TOOLS
        .iter()
        .map(|t| {
            json!({
                "name": t.name,
                "description": t.description,
                "inputSchema": (t.schema)(),
                "annotations": { "readOnlyHint": !t.writes, "destructiveHint": t.name == "update_note", "openWorldHint": false },
            })
        })
        .collect()
}

/// The settings screen's part (설정 → AI → 외부 AI 도구 연결).
pub mod cmd {
    use serde::Serialize;
    use tauri::State;

    use super::{Activity, read_activity};
    use crate::commands::AppState;
    use crate::error::{AppError, AppResult};
    use crate::paths::{name_key, normalize_rel};
    use crate::trust::{McpGrant, vault_root};

    /// Activity lines the screen shows.
    const SHOWN: usize = 20;

    #[derive(Debug, Clone, Serialize)]
    pub struct McpStatus {
        pub grant: McpGrant,
        /// This app's executable, for the connection commands.
        pub exe: String,
        pub vault: String,
        pub activity: Vec<Activity>,
    }

    fn status(state: &State<AppState>) -> AppResult<McpStatus> {
        let root = vault_root(state)?;
        let exe = std::env::current_exe().map_err(|e| AppError::System(e.to_string()))?;
        let mut activity = read_activity(&super::config_dir()?, &root);
        activity.truncate(SHOWN);
        Ok(McpStatus {
            grant: state.trust.get(&root).mcp,
            exe: exe.display().to_string(),
            vault: root.display().to_string(),
            activity,
        })
    }

    #[tauri::command]
    pub fn mcp_status(state: State<AppState>) -> AppResult<McpStatus> {
        status(&state)
    }

    #[tauri::command]
    pub fn set_mcp(state: State<AppState>, enabled: bool, write: bool, excluded: Vec<String>) -> AppResult<McpStatus> {
        let mut folders: Vec<String> = Vec::new();
        for f in excluded.iter().map(|f| normalize_rel(f)).filter(|f| !f.is_empty()) {
            if !folders.iter().any(|g| name_key(g) == name_key(&f)) {
                folders.push(f);
            }
        }
        let root = vault_root(&state)?;
        state.trust.update(&root, |t| t.mcp = McpGrant { enabled, write, excluded: folders })?;
        status(&state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        _vault_dir: tempfile::TempDir,
        config: tempfile::TempDir,
        server: Server,
    }

    fn fixture(grant: McpGrant) -> Fixture {
        let vault_dir = tempfile::tempdir().unwrap();
        let root = vault_dir.path();
        fs::create_dir_all(root.join("업무")).unwrap();
        fs::create_dir_all(root.join("개인")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join("업무/회의.md"), "# 회의\n\n## 결정\n- 예산 확정\n\n## 다음\n- 일정\n").unwrap();
        fs::write(root.join("업무/메모.md"), "[[회의]] 참고. 예산 이야기\n").unwrap();
        fs::write(root.join("업무/비밀.md"), "예산 비밀 #비공개\n").unwrap();
        fs::write(root.join("개인/일기.md"), "오늘 예산 걱정\n").unwrap();
        fs::write(root.join(".git/config.md"), "예산\n").unwrap();
        let vault = Vault::open(root).unwrap();
        vault.index().scan(vault.root()).unwrap();
        let config = tempfile::tempdir().unwrap();
        let trust = TrustStore::new(config.path());
        trust.update(vault.root(), |t| t.mcp = grant).unwrap();
        let server = Server::new(vault, config.path());
        Fixture { _vault_dir: vault_dir, config, server }
    }

    fn on(write: bool) -> McpGrant {
        McpGrant { enabled: true, write, excluded: vec!["개인".into()] }
    }

    /// The tool's text and whether it failed.
    fn call(server: &mut Server, name: &str, args: Value) -> (String, bool) {
        let reply = server.handle(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": name, "arguments": args } })).unwrap();
        let r = &reply["result"];
        (r["content"][0]["text"].as_str().unwrap().to_string(), r["isError"].as_bool().unwrap())
    }

    #[test]
    fn identifier_matches_tauri_conf() {
        let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], IDENTIFIER);
    }

    #[test]
    fn initialize_answers_the_clients_version_or_the_newest() {
        let mut f = fixture(McpGrant::default());
        let r = f.server.handle(json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } })).unwrap();
        assert_eq!(r["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(r["result"]["serverInfo"]["name"], "notevine");
        let r = f.server.handle(json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": { "protocolVersion": "1999-01-01" } })).unwrap();
        assert_eq!(r["result"]["protocolVersion"], PROTOCOL_VERSIONS[0]);
    }

    #[test]
    fn notifications_get_no_answer_and_unknown_methods_an_error() {
        let mut f = fixture(McpGrant::default());
        assert!(f.server.handle(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).is_none());
        let r = f.server.handle(json!({ "jsonrpc": "2.0", "id": 5, "method": "nope" })).unwrap();
        assert_eq!(r["error"]["code"], -32601);
        let r = f.server.handle(json!({ "jsonrpc": "2.0", "id": 6, "method": "tools/list" })).unwrap();
        assert_eq!(r["result"]["tools"].as_array().unwrap().len(), TOOLS.len());
    }

    #[test]
    fn run_writes_one_json_line_per_reply_and_nothing_else() {
        let mut f = fixture(McpGrant::default());
        let input = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\nnot json\n";
        let mut out = Vec::new();
        f.server.run(input.as_bytes(), &mut out);
        let out = String::from_utf8(out).unwrap();
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(serde_json::from_str::<Value>(lines[0]).unwrap()["id"], 1);
        assert_eq!(serde_json::from_str::<Value>(lines[1]).unwrap()["error"]["code"], -32700);
    }

    #[test]
    fn nothing_is_allowed_until_turned_on() {
        let mut f = fixture(McpGrant::default());
        let (text, err) = call(&mut f.server, "read_note", json!({ "path": "업무/회의.md" }));
        assert!(err);
        assert_eq!(text, OFF);
    }

    #[test]
    fn turning_off_in_the_app_takes_effect_at_once() {
        let mut f = fixture(on(false));
        assert!(!call(&mut f.server, "read_note", json!({ "path": "업무/회의.md" })).1);
        TrustStore::new(f.config.path()).update(f.server.vault.root(), |t| t.mcp.enabled = false).unwrap();
        assert!(call(&mut f.server, "read_note", json!({ "path": "업무/회의.md" })).1);
    }

    #[test]
    fn writing_needs_its_own_permission() {
        let mut f = fixture(on(false));
        let (text, err) = call(&mut f.server, "create_note", json!({ "folder": "업무", "content": "x" }));
        assert!(err);
        assert_eq!(text, NO_WRITE);
    }

    #[test]
    fn private_excluded_and_hidden_notes_stay_out_of_sight() {
        let mut f = fixture(on(true));
        for path in
            ["업무/비밀.md", "개인/일기.md", "개인/../개인/일기.md", ".git/config.md", "../밖.md", ".app/history.db"]
        {
            assert!(call(&mut f.server, "read_note", json!({ "path": path })).1, "{path} must not be readable");
            assert!(
                call(&mut f.server, "append_to_note", json!({ "path": path, "content": "x" })).1,
                "{path} must not be writable"
            );
        }
        assert!(call(&mut f.server, "create_note", json!({ "folder": "개인", "content": "x" })).1);

        let (list, _) = call(&mut f.server, "list_notes", json!({}));
        assert!(list.contains("업무/회의.md"));
        for hidden in ["비밀", "개인", ".git"] {
            assert!(!list.contains(hidden), "{hidden} listed: {list}");
        }

        let (hits, err) = call(&mut f.server, "search_notes", json!({ "text": ["예산"] }));
        assert!(!err, "{hits}");
        assert!(hits.contains("업무/회의.md") && hits.contains("업무/메모.md"));
        for hidden in ["비밀", "일기", ".git"] {
            assert!(!hits.contains(hidden), "{hidden} found: {hits}");
        }
    }

    #[test]
    fn search_waits_for_the_start_up_scan_of_a_new_vault() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("회의.md"), "예산 확정\n").unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        let config = tempfile::tempdir().unwrap();
        TrustStore::new(config.path()).update(vault.root(), |t| t.mcp.enabled = true).unwrap();
        let (store, root) = (vault.store_dir(), vault.root().to_path_buf());
        let mut server = Server::new(vault, config.path());
        server.scanning = Mutex::new(Some(std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(200));
            Index::open(&store.join("index.db")).and_then(|ix| ix.scan(&root)).unwrap();
        })));
        let (hits, err) = call(&mut server, "search_notes", json!({ "text": ["예산"] }));
        assert!(!err && hits.contains("회의.md"), "{hits}");
    }

    #[test]
    fn a_note_tagged_private_after_indexing_is_still_hidden_from_search() {
        let mut f = fixture(on(false));
        let root = f.server.vault.root().to_path_buf();
        fs::write(root.join("업무/메모.md"), "예산 이야기 #비공개\n").unwrap();
        let (hits, _) = call(&mut f.server, "search_notes", json!({ "text": ["예산"] }));
        assert!(!hits.contains("메모"), "{hits}");
    }

    #[test]
    fn read_then_update_with_the_hash_and_it_lands_in_history() {
        let mut f = fixture(on(true));
        let (text, err) = call(&mut f.server, "read_note", json!({ "path": "업무/회의.md" }));
        assert!(!err);
        let hash = text.lines().find_map(|l| l.strip_prefix("hash: ")).unwrap().to_string();
        assert!(
            call(
                &mut f.server,
                "update_note",
                json!({ "path": "업무/회의.md", "content": "새 내용\n", "expected_hash": "다른값" })
            )
            .1
        );
        let (_, err) = call(
            &mut f.server,
            "update_note",
            json!({ "path": "업무/회의.md", "content": "새 내용\n", "expected_hash": hash }),
        );
        assert!(!err);
        let root = f.server.vault.root().to_path_buf();
        assert_eq!(fs::read_to_string(root.join("업무/회의.md")).unwrap(), "새 내용\n");
        let versions = f.server.vault.history().list("업무/회의.md").unwrap();
        assert_eq!(versions[0].origin, Origin::Mcp);
        assert!(versions.len() >= 2, "the text before the change is kept");
    }

    #[test]
    fn create_numbers_a_taken_name_and_append_goes_under_the_heading() {
        let mut f = fixture(on(true));
        let (text, err) =
            call(&mut f.server, "create_note", json!({ "folder": "업무", "name": "회의", "content": "둘째" }));
        assert!(!err, "{text}");
        assert!(text.contains("업무/회의 1.md"));
        let (_, err) = call(
            &mut f.server,
            "append_to_note",
            json!({ "path": "업무/회의.md", "heading": "결정", "content": "- 인력 확정" }),
        );
        assert!(!err);
        let root = f.server.vault.root().to_path_buf();
        let note = fs::read_to_string(root.join("업무/회의.md")).unwrap();
        assert_eq!(note, "# 회의\n\n## 결정\n- 예산 확정\n\n- 인력 확정\n\n## 다음\n- 일정\n");
    }

    #[test]
    fn every_call_is_logged_without_note_text() {
        let mut f = fixture(on(false));
        call(&mut f.server, "read_note", json!({ "path": "업무/회의.md" }));
        call(&mut f.server, "read_note", json!({ "path": "업무/비밀.md" }));
        let log = read_activity(f.config.path(), f.server.vault.root());
        assert_eq!(log.len(), 2);
        assert_eq!((log[0].target.as_str(), log[0].ok), ("업무/비밀.md", false));
        assert_eq!((log[1].target.as_str(), log[1].ok), ("업무/회의.md", true));
        let raw = fs::read_to_string(f.config.path().join(ACTIVITY_FILE)).unwrap();
        assert!(!raw.contains("예산"));
    }

    /// A vault with one note, the MCP connection turned on in `config`.
    fn enabled_vault(config: &Path, note: &str, text: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(note), text).unwrap();
        let root = Vault::open(dir.path()).unwrap().root().to_path_buf();
        TrustStore::new(config).update(&root, |t| t.mcp.enabled = true).unwrap();
        dir
    }

    fn open_in_app(config: &Path, dir: &tempfile::TempDir) {
        let v = Vault::open(dir.path()).unwrap();
        let info = v.info();
        RecentStore::new(config).touch(&info.root, &info.name).unwrap();
    }

    #[test]
    fn without_vault_argument_it_follows_the_vault_opened_in_the_app() {
        let config = tempfile::tempdir().unwrap();
        let local = tempfile::tempdir().unwrap();
        let a = enabled_vault(config.path(), "가.md", "첫 폴더\n");
        let b = enabled_vault(config.path(), "나.md", "둘째 폴더\n");
        open_in_app(config.path(), &a);
        let mut server = Server::new(Vault::open(a.path()).unwrap(), config.path());
        server.follow = Some(local.path().to_path_buf());

        let (text, err) = call(&mut server, "read_note", json!({ "path": "가.md" }));
        assert!(!err && !text.contains("바뀌었습니다"), "{text}");

        open_in_app(config.path(), &b);
        let (text, err) = call(&mut server, "read_note", json!({ "path": "나.md" }));
        assert!(!err, "{text}");
        assert!(text.contains("노트 폴더가 바뀌었습니다") && text.contains("둘째 폴더"), "{text}");
        let (hits, _) = call(&mut server, "search_notes", json!({ "text": ["둘째"] }));
        assert!(hits.contains("나.md"), "the new vault is indexed: {hits}");
        let (text, _) = call(&mut server, "read_note", json!({ "path": "나.md" }));
        assert!(!text.contains("바뀌었습니다"), "said only once: {text}");
        assert_eq!(read_activity(config.path(), server.vault.root()).len(), 3);
    }

    #[test]
    fn a_vault_given_by_argument_stays_put() {
        let config = tempfile::tempdir().unwrap();
        let a = enabled_vault(config.path(), "가.md", "첫 폴더\n");
        let b = enabled_vault(config.path(), "나.md", "둘째 폴더\n");
        let mut server = Server::new(Vault::open(a.path()).unwrap(), config.path());
        open_in_app(config.path(), &b);
        let (text, err) = call(&mut server, "read_note", json!({ "path": "가.md" }));
        assert!(!err && text.contains("첫 폴더"), "{text}");
    }

    #[test]
    fn append_end_and_heading_edge_cases() {
        assert_eq!(append_end("", "a"), "a\n");
        assert_eq!(append_end("x\n\n", "\na\n"), "x\n\na\n");
        assert_eq!(insert_under_heading("# A\nx\n", "B", "y"), None);
        assert_eq!(
            insert_under_heading("# A\nx\n```\n# B\n```\n", "B", "y"),
            None,
            "a heading in code is not a heading"
        );
        assert_eq!(insert_under_heading("# A\nx\n", "a", "y").unwrap(), "# A\nx\n\ny\n");
    }
}
