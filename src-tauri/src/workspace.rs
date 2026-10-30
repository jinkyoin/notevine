//! Vault settings (`.app/config.json`, DR-04), the "기록 관리" preset (FR-PRS-01·02,
//! DR-05), templates (FR-PRP-04), the daily work journal (FR-PRS-03), quick memo
//! (FR-PRS-04) and the idea list (FR-PRS-05·06).
//!
//! The preset itself (folders and template text) lives in `presets/default.json`;
//! this module only knows how to apply it.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Datelike, Local};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::{AppState, with_vault};
use crate::error::{AppError, AppResult};
use crate::parse;
use crate::paths::{
    APP_DIR, file_name, is_hidden, is_note, join_rel, name_key, normalize_rel, parent_rel, validate_name,
};
use crate::vault::{UNTITLED, Vault};

const PRESET_JSON: &str = include_str!("../presets/default.json");

// ---------- config ----------

/// Per-vault settings in `.app/config.json`. Missing fields take their defaults
/// and unknown fields are ignored (and kept on save).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct VaultConfig {
    pub preset_enabled: bool,
    pub inbox_folder: String,
    /// PARA (Tiago Forte): Projects, Areas, Resources, Archives.
    pub project_folder: String,
    pub area_folder: String,
    pub resource_folder: String,
    pub archive_folder: String,
    pub journal_folder: String,
    pub idea_folder: String,
    pub research_folder: String,
    pub template_folder: String,
    pub attachment_folder: String,
    /// Vault-relative path of a day's journal; template variables allowed.
    pub journal_path: String,
    pub idea_statuses: Vec<String>,
    /// "ctrl" | "click"
    pub link_click: String,
    pub update_links_on_rename: bool,
    pub autosave_ms: u32,
    /// "system" | "light" | "dark"
    pub theme: String,
    /// "ko" | "en"
    pub language: String,
    /// Folder path → color of its name in the file tree; notes and folders inside take it too.
    pub folder_colors: BTreeMap<String, String>,
}

impl Default for VaultConfig {
    fn default() -> Self {
        Self {
            preset_enabled: false,
            inbox_folder: "00.Inbox".into(),
            project_folder: "10.프로젝트".into(),
            area_folder: "20.영역".into(),
            resource_folder: "30.자료".into(),
            archive_folder: "40.보관".into(),
            journal_folder: "20.영역/업무일지".into(),
            idea_folder: "30.자료/아이디어".into(),
            research_folder: "30.자료/조사자료".into(),
            template_folder: "90.템플릿".into(),
            attachment_folder: "첨부".into(),
            journal_path: "20.영역/업무일지/{{YYYY}}/{{YYYY-MM-DD}}.md".into(),
            idea_statuses: ["아이디어", "검토", "진행", "완료", "보류"].map(String::from).to_vec(),
            link_click: "ctrl".into(),
            update_links_on_rename: true,
            autosave_ms: 1000,
            theme: "system".into(),
            language: "ko".into(),
            folder_colors: BTreeMap::new(),
        }
    }
}

impl VaultConfig {
    /// Folder for a preset folder key (`"inbox_folder"`, ...). Any other string is
    /// taken as a folder path itself, so a preset can add folders of its own.
    fn folder_for<'a>(&'a self, key: &'a str) -> &'a str {
        match key {
            "inbox_folder" => &self.inbox_folder,
            "project_folder" => &self.project_folder,
            "area_folder" => &self.area_folder,
            "resource_folder" => &self.resource_folder,
            "archive_folder" => &self.archive_folder,
            "journal_folder" => &self.journal_folder,
            "idea_folder" => &self.idea_folder,
            "research_folder" => &self.research_folder,
            "template_folder" => &self.template_folder,
            "attachment_folder" => &self.attachment_folder,
            other => other,
        }
    }

    fn first_status(&self) -> &str {
        self.idea_statuses.first().map(String::as_str).unwrap_or("")
    }
}

fn config_path(v: &Vault) -> PathBuf {
    v.root().join(APP_DIR).join("config.json")
}

pub fn load_config(v: &Vault) -> AppResult<VaultConfig> {
    match fs::read_to_string(config_path(v)) {
        Ok(s) => Ok(serde_json::from_str(&s)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(VaultConfig::default()),
        Err(e) => Err(e.into()),
    }
}

/// Writes the config as pretty JSON. Keys this version doesn't know (written by a
/// newer version or another part of the app) are kept.
pub fn save_config(v: &Vault, config: &VaultConfig) -> AppResult<()> {
    let path = config_path(v);
    let mut obj = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| match v {
            serde_json::Value::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default();
    if let serde_json::Value::Object(new) = serde_json::to_value(config)? {
        obj.extend(new);
    }
    fs::write(path, serde_json::to_string_pretty(&serde_json::Value::Object(obj))?)?;
    Ok(())
}

// ---------- template rendering ----------

const WEEKDAYS: [&str; 7] = ["월", "화", "수", "목", "금", "토", "일"];

/// Replaces `{{title}}`, `{{date}}`, `{{time}}`, `{{datetime}}`, `{{YYYY}}`, `{{MM}}`,
/// `{{DD}}`, `{{YYYY-MM-DD}}` and `{{weekday}}` (월..일). Unknown `{{x}}` stays as is.
pub fn render_template(template: &str, title: &str, now: DateTime<Local>) -> String {
    substitute(template, |key| {
        Some(match key {
            "title" => title.to_string(),
            "date" | "YYYY-MM-DD" => now.format("%Y-%m-%d").to_string(),
            "time" => now.format("%H:%M").to_string(),
            "datetime" => now.format("%Y-%m-%d %H:%M").to_string(),
            "YYYY" => now.format("%Y").to_string(),
            "MM" => now.format("%m").to_string(),
            "DD" => now.format("%d").to_string(),
            "weekday" => WEEKDAYS[now.weekday().num_days_from_monday() as usize].to_string(),
            _ => return None,
        })
    })
}

/// Replaces each `{{key}}` (whitespace inside the braces ignored) for which
/// `value` returns something; leaves the rest untouched.
fn substitute(text: &str, value: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else { break };
        out.push_str(&rest[..start]);
        match value(after[..end].trim()) {
            Some(v) => out.push_str(&v),
            None => out.push_str(&rest[start..start + 2 + end + 2]),
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}

/// A YAML scalar for a frontmatter line, quoted only when it has to be.
fn yaml_scalar(s: &str) -> String {
    let needs_quotes = s.is_empty()
        || s != s.trim()
        || s.contains(": ")
        || s.contains(" #")
        || s.ends_with(':')
        || s.starts_with([
            '-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', '\'', '"', '%', '@', '`',
        ])
        || s.contains(['\n', '\r', '\t']);
    if needs_quotes { serde_json::to_string(s).unwrap_or_default() } else { s.to_string() }
}

/// Splits `content` into its frontmatter block (with delimiters) and the rest.
fn split_frontmatter(content: &str) -> Option<(&str, &str)> {
    let mut lines = content.split_inclusive('\n');
    let first = lines.next()?;
    if first.trim_end() != "---" {
        return None;
    }
    let mut pos = first.len();
    for line in lines {
        pos += line.len();
        let t = line.trim_end();
        if t == "---" || t == "..." {
            return Some((&content[..pos], &content[pos..]));
        }
    }
    None
}

/// Removes the top-level `folder:` key (template metadata) from the frontmatter,
/// with any indented or list continuation lines. Everything else is kept byte for byte.
fn strip_folder_key(content: &str) -> String {
    let (bom, body) = match content.strip_prefix('\u{feff}') {
        Some(rest) => ("\u{feff}", rest),
        None => ("", content),
    };
    let Some((fm, rest)) = split_frontmatter(body) else {
        return content.to_string();
    };
    let mut out = String::from(bom);
    let mut skipping = false;
    for (i, line) in fm.split_inclusive('\n').enumerate() {
        let delimiter = matches!(line.trim_end(), "---" | "...");
        let is_key_line = i > 0 && !line.starts_with([' ', '\t', '-', '#']) && !line.trim().is_empty();
        let continuation = line.starts_with([' ', '\t']) || (line.starts_with('-') && !delimiter);
        if skipping && continuation {
            continue;
        }
        skipping = false;
        if is_key_line
            && let Some((key, _)) = line.split_once(':')
            && key.trim().eq_ignore_ascii_case("folder")
        {
            skipping = true;
            continue;
        }
        out.push_str(line);
    }
    out.push_str(rest);
    out
}

// ---------- preset ----------

#[derive(Debug, Deserialize)]
struct Preset {
    folders: Vec<String>,
    templates: Vec<PresetTemplate>,
    /// Folder key → file tree color, for folders that have none yet.
    #[serde(default)]
    colors: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct PresetTemplate {
    name: String,
    lines: Vec<String>,
}

fn preset() -> AppResult<Preset> {
    Ok(serde_json::from_str(PRESET_JSON)?)
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct PresetResult {
    pub created_folders: Vec<String>,
    pub created_templates: Vec<String>,
    /// Folders and templates that already existed and were left untouched.
    pub skipped: Vec<String>,
}

/// Checks each segment of a vault-relative folder path from the config.
fn checked_dir(rel: &str) -> AppResult<String> {
    let rel = normalize_rel(rel);
    for seg in rel.split('/').filter(|s| !s.is_empty()) {
        validate_name(seg)?;
    }
    Ok(rel)
}

/// Creates the preset folders and templates (FR-PRS-02). Anything that already
/// exists is reported in `skipped` and never touched. Turns the preset on.
pub fn apply_preset_to(v: &Vault) -> AppResult<PresetResult> {
    let mut config = load_config(v)?;
    let preset = preset()?;
    let mut res = PresetResult::default();

    for key in &preset.folders {
        let rel = checked_dir(config.folder_for(key))?;
        if rel.is_empty() || res.created_folders.contains(&rel) || res.skipped.contains(&rel) {
            continue;
        }
        let abs = v.abs(&rel)?;
        if abs.exists() {
            res.skipped.push(rel);
        } else {
            fs::create_dir_all(abs)?;
            res.created_folders.push(rel);
        }
    }

    let tpl_dir = checked_dir(&config.template_folder)?;
    for t in &preset.templates {
        let name = format!("{}.md", t.name);
        let rel = join_rel(&tpl_dir, &name);
        if v.abs(&rel)?.exists() {
            res.skipped.push(rel);
            continue;
        }
        let text = t.lines.join("\n");
        let text = substitute(&text, |key| match key {
            "idea_status" => Some(yaml_scalar(config.first_status())),
            k if k.ends_with("_folder") && config.folder_for(k) != k => Some(yaml_scalar(config.folder_for(k))),
            _ => None,
        });
        match v.create_note(&tpl_dir, Some(&name), &text) {
            Ok(rel) => res.created_templates.push(rel),
            Err(AppError::AlreadyExists(rel)) => res.skipped.push(rel),
            Err(e) => return Err(e),
        }
    }

    // Colors keep a folder's own color if it already has one.
    for (key, color) in &preset.colors {
        let rel = checked_dir(config.folder_for(key))?;
        if !rel.is_empty() {
            config.folder_colors.entry(rel).or_insert_with(|| color.clone());
        }
    }

    config.preset_enabled = true;
    save_config(v, &config)?;
    Ok(res)
}

// ---------- templates ----------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TemplateRef {
    pub path: String,
    pub title: String,
    /// First few non-empty body lines (frontmatter removed), at most 160 chars.
    pub preview: String,
    /// The template's `folder` property: where notes made from it go by default.
    pub folder: Option<String>,
}

fn stem(name: &str) -> &str {
    if is_note(name) { &name[..name.len() - 3] } else { name }
}

fn collect_notes(dir: &Path, root: &Path, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if is_hidden(&name) {
            continue;
        }
        let path = e.path();
        if path.is_dir() {
            collect_notes(&path, root, out);
        } else if is_note(&name)
            && let Some(rel) = crate::paths::to_rel(root, &path)
        {
            out.push(rel);
        }
    }
}

/// Every `.md` file in the template folder (nested ones too), sorted by title.
pub fn templates_in(v: &Vault) -> AppResult<Vec<TemplateRef>> {
    let config = load_config(v)?;
    let dir = v.abs(&checked_dir(&config.template_folder)?)?;
    let mut paths = Vec::new();
    if dir.is_dir() {
        collect_notes(&dir, v.root(), &mut paths);
    }
    let mut out: Vec<TemplateRef> = paths
        .into_iter()
        .filter_map(|rel| {
            let content = fs::read_to_string(v.abs(&rel).ok()?).ok()?;
            let parsed = parse::parse(&content);
            let preview: String = parsed
                .body
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .take(3)
                .collect::<Vec<_>>()
                .join("\n")
                .chars()
                .take(160)
                .collect();
            let folder = parsed
                .properties
                .iter()
                .find(|p| p.key.eq_ignore_ascii_case("folder"))
                .map(|p| p.value.trim().to_string())
                .filter(|f| !f.is_empty());
            Some(TemplateRef { title: stem(file_name(&rel)).to_string(), path: rel, preview, folder })
        })
        .collect();
    out.sort_by(|a, b| name_key(&a.title).cmp(&name_key(&b.title)).then_with(|| a.path.cmp(&b.path)));
    Ok(out)
}

/// Creates a note in `dir` from a template (FR-PRP-04). Without a name it is
/// "제목 없음" (numbered if taken); without a template it is empty.
pub fn create_from_template_at(
    v: &Vault,
    dir: &str,
    name: Option<&str>,
    template: Option<&str>,
    now: DateTime<Local>,
) -> AppResult<String> {
    let dir = normalize_rel(dir);
    let name = match name.map(str::trim).filter(|n| !n.is_empty()) {
        Some(n) => n.to_string(),
        None => v.unique_name(&dir, UNTITLED, ".md")?,
    };
    let content = match template {
        Some(t) => render_template_file(v, t, stem(&name), now)?,
        None => String::new(),
    };
    v.create_note(&dir, Some(&name), &content)
}

/// A template's text with its variables filled in and the `folder` key removed:
/// what a note made from it starts with, or what "템플릿 삽입" puts into one.
pub fn render_template_file(v: &Vault, template: &str, title: &str, now: DateTime<Local>) -> AppResult<String> {
    let p = v.abs(template)?;
    if !p.is_file() {
        return Err(AppError::NotFound(normalize_rel(template)));
    }
    Ok(strip_folder_key(&render_template(&fs::read_to_string(p)?, title, now)))
}

// ---------- daily journal ----------

/// Opens today's journal, creating it (and its folders) from the "업무일지"
/// template when it doesn't exist yet (FR-PRS-03). Returns its path.
pub fn open_journal_at(v: &Vault, now: DateTime<Local>) -> AppResult<String> {
    let config = load_config(v)?;
    let date = now.format("%Y-%m-%d").to_string();
    let rel = normalize_rel(&render_template(&config.journal_path, &date, now));
    let rel = if is_note(&rel) { rel } else { format!("{rel}.md") };
    checked_dir(&rel)?;
    if v.abs(&rel)?.is_file() {
        return Ok(rel);
    }
    let name = file_name(&rel).to_string();
    let title = stem(&name).to_string();
    let template = templates_in(v)?.into_iter().find(|t| name_key(&t.title) == name_key("업무일지"));
    let content = match template {
        Some(t) => strip_folder_key(&render_template(&fs::read_to_string(v.abs(&t.path)?)?, &title, now)),
        None => render_template("# {{YYYY-MM-DD}} 업무일지\n", &title, now),
    };
    v.create_note(parent_rel(&rel), Some(&name), &content)
}

// ---------- quick memo ----------

/// File name from a user-typed memo title: characters Windows refuses are
/// dropped; `None` when nothing usable remains.
fn memo_name(title: &str) -> Option<String> {
    let cleaned: String = title
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control())
        .collect();
    let cleaned = cleaned.trim().trim_end_matches(['.', ' ']).trim().to_string();
    let base = stem(&cleaned).trim_end_matches(['.', ' ']).to_string();
    (validate_name(&base).is_ok() && validate_name(&format!("{base}.md")).is_ok()).then_some(base)
}

/// Saves a quick memo (FR-PRS-04). With the preset on it goes to the Inbox as
/// an idea note (`type: idea`, first status, `created`); with it off it is a plain
/// note in the vault root. Named after `title` when usable, else "메모 YYYY-MM-DD HHmm".
pub fn quick_memo_at(v: &Vault, text: &str, title: Option<&str>, now: DateTime<Local>) -> AppResult<String> {
    let config = load_config(v)?;
    let base = title.and_then(memo_name).unwrap_or_else(|| format!("메모 {}", now.format("%Y-%m-%d %H%M")));
    let (dir, content) = if config.preset_enabled {
        let mut fm = String::from("---\ntype: idea\n");
        if !config.first_status().is_empty() {
            fm.push_str(&format!("status: {}\n", yaml_scalar(config.first_status())));
        }
        fm.push_str(&format!("created: {}\n---\n\n", now.format("%Y-%m-%d")));
        (checked_dir(&config.inbox_folder)?, fm + text)
    } else {
        (String::new(), text.to_string())
    };
    let name = v.unique_name(&dir, &base, ".md")?;
    v.create_note(&dir, Some(&name), &content)
}

// ---------- ideas ----------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IdeaItem {
    pub path: String,
    pub title: String,
    /// First `status` value, "" when the note has none.
    pub status: String,
    /// Last modified, ms since epoch.
    pub mtime: i64,
}

/// Notes with `type: idea` (key and value case-insensitive), newest first (FR-PRS-06).
pub fn idea_list(v: &Vault) -> AppResult<Vec<IdeaItem>> {
    let mut st = v.index().conn().prepare(
        "SELECT n.path, n.title, n.mtime,
                COALESCE((SELECT s.value FROM properties s
                          WHERE s.note_id = n.id AND lower(s.key) = 'status'
                          ORDER BY s.rowid LIMIT 1), '')
         FROM notes n
         WHERE EXISTS (SELECT 1 FROM properties p
                       WHERE p.note_id = n.id AND lower(p.key) = 'type' AND lower(trim(p.value)) = 'idea')
         ORDER BY n.mtime DESC, n.title, n.path",
    )?;
    let rows =
        st.query_map([], |r| Ok(IdeaItem { path: r.get(0)?, title: r.get(1)?, mtime: r.get(2)?, status: r.get(3)? }))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

// ---------- commands ----------

#[tauri::command]
pub fn get_config(state: State<AppState>) -> AppResult<VaultConfig> {
    with_vault(&state, load_config)
}

#[tauri::command]
pub fn set_config(state: State<AppState>, config: VaultConfig) -> AppResult<()> {
    with_vault(&state, |v| save_config(v, &config))
}

#[tauri::command]
pub fn apply_preset(state: State<AppState>) -> AppResult<PresetResult> {
    with_vault(&state, apply_preset_to)
}

#[tauri::command]
pub fn list_templates(state: State<AppState>) -> AppResult<Vec<TemplateRef>> {
    with_vault(&state, templates_in)
}

#[tauri::command]
pub fn create_from_template(
    state: State<AppState>,
    dir: String,
    name: Option<String>,
    template: Option<String>,
) -> AppResult<String> {
    with_vault(&state, |v| create_from_template_at(v, &dir, name.as_deref(), template.as_deref(), Local::now()))
}

#[tauri::command]
pub fn render_template_text(state: State<AppState>, template: String, title: String) -> AppResult<String> {
    with_vault(&state, |v| render_template_file(v, &template, &title, Local::now()))
}

#[tauri::command]
pub fn open_today_journal(state: State<AppState>) -> AppResult<String> {
    with_vault(&state, |v| open_journal_at(v, Local::now()))
}

#[tauri::command]
pub fn quick_memo(state: State<AppState>, text: String, title: Option<String>) -> AppResult<String> {
    with_vault(&state, |v| quick_memo_at(v, &text, title.as_deref(), Local::now()))
}

#[tauri::command]
pub fn ideas(state: State<AppState>) -> AppResult<Vec<IdeaItem>> {
    with_vault(&state, idea_list)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use std::time::{Duration, SystemTime};

    fn vault() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        (dir, v)
    }

    /// 2026-10-28 (수) 09:05
    fn now() -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 10, 28, 9, 5, 0).unwrap()
    }

    fn read(dir: &tempfile::TempDir, rel: &str) -> String {
        fs::read_to_string(dir.path().join(rel)).unwrap()
    }

    fn enable_preset(v: &Vault) {
        save_config(v, &VaultConfig { preset_enabled: true, ..VaultConfig::default() }).unwrap();
    }

    #[test]
    fn renders_variables_and_keeps_unknowns() {
        let out = render_template(
            "{{title}}|{{date}}|{{time}}|{{datetime}}|{{YYYY}}/{{MM}}/{{DD}}|{{YYYY-MM-DD}}|{{weekday}}|{{ date }}|{{x}}|{{y",
            "회의록",
            now(),
        );
        assert_eq!(out, "회의록|2026-10-28|09:05|2026-10-28 09:05|2026/10/28|2026-10-28|수|2026-10-28|{{x}}|{{y");
        let sunday = Local.with_ymd_and_hms(2026, 11, 1, 0, 0, 0).unwrap();
        assert_eq!(render_template("{{weekday}}", "", sunday), "일");
    }

    #[test]
    fn config_defaults_partial_and_roundtrip() {
        let (dir, v) = vault();
        assert_eq!(load_config(&v).unwrap(), VaultConfig::default());
        let d = VaultConfig::default();
        assert!(!d.preset_enabled);
        assert_eq!(d.idea_statuses, ["아이디어", "검토", "진행", "완료", "보류"]);
        assert_eq!((d.link_click.as_str(), d.autosave_ms, d.update_links_on_rename), ("ctrl", 1000, true));

        let cfg = dir.path().join(".app/config.json");
        fs::write(&cfg, r#"{"theme":"dark","inbox_folder":"받은 메모","future_key":{"a":1}}"#).unwrap();
        let c = load_config(&v).unwrap();
        assert_eq!(c.theme, "dark");
        assert_eq!(c.inbox_folder, "받은 메모");
        assert_eq!(c.journal_folder, "20.영역/업무일지");

        let changed = VaultConfig {
            autosave_ms: 2500,
            idea_statuses: vec!["새".into()],
            folder_colors: BTreeMap::from([("업무".into(), "#1c7ed6".into())]),
            ..c
        };
        save_config(&v, &changed).unwrap();
        assert_eq!(load_config(&v).unwrap(), changed);
        let text = fs::read_to_string(&cfg).unwrap();
        let raw: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(raw["future_key"]["a"], 1, "unknown keys are kept");
        assert!(text.contains("\n  \""), "pretty JSON");
    }

    #[test]
    fn preset_definition_is_valid() {
        let p = preset().unwrap();
        assert_eq!(p.folders.len(), 10);
        let names: Vec<_> = p.templates.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["업무일지", "회의록", "아이디어", "자료"]);
    }

    #[test]
    fn apply_preset_on_empty_vault() {
        let (dir, v) = vault();
        let r = apply_preset_to(&v).unwrap();
        // PARA's four folders, the app's folders inside them, then the folders outside PARA.
        assert_eq!(
            r.created_folders,
            [
                "00.Inbox",
                "10.프로젝트",
                "20.영역",
                "20.영역/업무일지",
                "30.자료",
                "30.자료/아이디어",
                "30.자료/조사자료",
                "40.보관",
                "90.템플릿",
                "첨부"
            ]
        );
        assert_eq!(
            r.created_templates,
            ["90.템플릿/업무일지.md", "90.템플릿/회의록.md", "90.템플릿/아이디어.md", "90.템플릿/자료.md"]
        );
        assert!(r.skipped.is_empty());
        let c = load_config(&v).unwrap();
        assert!(c.preset_enabled);
        // Top folders get a color; the folders inside take it from them.
        let colored: Vec<_> = c.folder_colors.keys().map(String::as_str).collect();
        assert_eq!(colored, ["00.Inbox", "10.프로젝트", "20.영역", "30.자료", "40.보관", "90.템플릿", "첨부"]);
        assert_eq!(c.folder_colors["10.프로젝트"], "#e03131");

        let idea = read(&dir, "90.템플릿/아이디어.md");
        assert!(
            idea.starts_with(
                "---\ntype: idea\nstatus: 아이디어\ntags: []\ncreated: {{date}}\nfolder: 30.자료/아이디어\n---\n"
            ),
            "{idea}"
        );
        let research = read(&dir, "90.템플릿/자료.md");
        assert!(research.contains("type: research\nsource: \ncreated: {{date}}\n"));
        assert!(research.contains("folder: 30.자료/조사자료\n") && research.contains("## 요약"));
        assert!(read(&dir, "90.템플릿/업무일지.md").contains("type: journal\ndate: {{date}}\n"));
        assert!(read(&dir, "90.템플릿/회의록.md").contains("type: meeting\ndate: {{date}}\nparticipants: []\n"));

        // applying again changes nothing
        let again = apply_preset_to(&v).unwrap();
        assert!(again.created_folders.is_empty() && again.created_templates.is_empty());
        assert_eq!(again.skipped.len(), 14);
    }

    #[test]
    fn apply_preset_leaves_existing_files_untouched() {
        let (dir, v) = vault();
        fs::create_dir_all(dir.path().join("00.Inbox")).unwrap();
        fs::create_dir_all(dir.path().join("90.템플릿")).unwrap();
        let mine = "---\ntype: journal\n---\n내 업무일지 양식\r\n";
        fs::write(dir.path().join("90.템플릿/업무일지.md"), mine).unwrap();
        fs::write(dir.path().join("00.Inbox/메모.md"), "그대로").unwrap();

        let r = apply_preset_to(&v).unwrap();
        assert_eq!(r.skipped, ["00.Inbox", "90.템플릿", "90.템플릿/업무일지.md"]);
        assert_eq!(
            r.created_folders,
            [
                "10.프로젝트",
                "20.영역",
                "20.영역/업무일지",
                "30.자료",
                "30.자료/아이디어",
                "30.자료/조사자료",
                "40.보관",
                "첨부"
            ]
        );
        assert_eq!(r.created_templates.len(), 3);
        assert_eq!(fs::read(dir.path().join("90.템플릿/업무일지.md")).unwrap(), mine.as_bytes());
        assert_eq!(read(&dir, "00.Inbox/메모.md"), "그대로");
    }

    #[test]
    fn apply_preset_keeps_a_folder_color_already_chosen() {
        let (_dir, v) = vault();
        let mine = VaultConfig {
            folder_colors: BTreeMap::from([("10.프로젝트".into(), "#d6336c".into())]),
            ..VaultConfig::default()
        };
        save_config(&v, &mine).unwrap();
        apply_preset_to(&v).unwrap();
        let c = load_config(&v).unwrap();
        assert_eq!(c.folder_colors["10.프로젝트"], "#d6336c");
        assert_eq!(c.folder_colors["20.영역"], "#1c7ed6");
    }

    #[test]
    fn lists_templates_with_preview_and_folder() {
        let (dir, v) = vault();
        apply_preset_to(&v).unwrap();
        fs::create_dir_all(dir.path().join("90.템플릿/내 양식")).unwrap();
        fs::write(dir.path().join("90.템플릿/내 양식/가 주간보고.md"), "\n\n# 주간보고\n\n- 한 일\n- 할 일\n- 이슈\n")
            .unwrap();
        fs::write(dir.path().join("90.템플릿/그림.png"), "x").unwrap();
        let t = templates_in(&v).unwrap();
        let titles: Vec<_> = t.iter().map(|t| t.title.as_str()).collect();
        assert_eq!(titles, ["가 주간보고", "아이디어", "업무일지", "자료", "회의록"]);
        assert_eq!(t[0].path, "90.템플릿/내 양식/가 주간보고.md");
        assert_eq!(t[0].preview, "# 주간보고\n- 한 일\n- 할 일");
        assert_eq!(t[0].folder, None);
        assert_eq!(t[1].folder.as_deref(), Some("30.자료/아이디어"));
        assert_eq!(t[3].folder.as_deref(), Some("30.자료/조사자료"));
        assert!(!t[3].preview.contains("type:"));
    }

    #[test]
    fn create_from_template_renders_and_numbers_untitled() {
        let (dir, v) = vault();
        apply_preset_to(&v).unwrap();
        let p =
            create_from_template_at(&v, "30 조사자료", Some("자동화 도구"), Some("90.템플릿/자료.md"), now()).unwrap();
        assert_eq!(p, "30 조사자료/자동화 도구.md");
        assert_eq!(
            read(&dir, &p),
            "---\ntype: research\nsource: \ncreated: 2026-10-28\ntags: []\n---\n\n# 자동화 도구\n\n## 요약\n\n## 핵심 내용\n\n## 출처 메모\n\n## 관련 노트\n"
        );
        assert!(v.index().notes().unwrap().iter().any(|n| n.path == p));

        let a = create_from_template_at(&v, "", None, Some("90.템플릿/회의록.md"), now()).unwrap();
        let b = create_from_template_at(&v, "", None, None, now()).unwrap();
        assert_eq!((a.as_str(), b.as_str()), ("제목 없음.md", "제목 없음 1.md"));
        assert!(read(&dir, &a).contains("# 제목 없음\n\n- 일시: 2026-10-28 09:05"));
        assert_eq!(read(&dir, &b), "");
        assert!(matches!(create_from_template_at(&v, "", None, Some("없음.md"), now()), Err(AppError::NotFound(_))));
    }

    #[test]
    fn render_template_file_fills_variables_without_creating_a_note() {
        let (_dir, v) = vault();
        apply_preset_to(&v).unwrap();
        let before = v.index().notes().unwrap().len();
        let text = render_template_file(&v, "90.템플릿/자료.md", "기존 노트", now()).unwrap();
        assert!(text.starts_with("---\ntype: research\n"));
        assert!(text.contains("# 기존 노트\n"));
        assert!(!text.contains("folder:"));
        assert_eq!(v.index().notes().unwrap().len(), before);
        assert!(matches!(render_template_file(&v, "없음.md", "x", now()), Err(AppError::NotFound(_))));
    }

    #[test]
    fn strips_only_the_folder_key() {
        let src = "---\ntype: x\nFolder: a\n  - nested\nfolders: keep\n# comment\n---\nfolder: body stays\n";
        assert_eq!(strip_folder_key(src), "---\ntype: x\nfolders: keep\n# comment\n---\nfolder: body stays\n");
        assert_eq!(strip_folder_key("folder: no frontmatter"), "folder: no frontmatter");
        assert_eq!(strip_folder_key("---\r\nfolder: a\r\nb: 1\r\n---\r\n"), "---\r\nb: 1\r\n---\r\n");
    }

    #[test]
    fn today_journal_is_created_once() {
        let (dir, v) = vault();
        let p = open_journal_at(&v, now()).unwrap();
        assert_eq!(p, "20.영역/업무일지/2026/2026-10-28.md");
        assert_eq!(read(&dir, &p), "# 2026-10-28 업무일지\n");
        fs::write(dir.path().join(&p), "적은 내용").unwrap();
        assert_eq!(open_journal_at(&v, now()).unwrap(), p);
        assert_eq!(read(&dir, &p), "적은 내용");
    }

    #[test]
    fn today_journal_uses_template() {
        let (dir, v) = vault();
        apply_preset_to(&v).unwrap();
        let p = open_journal_at(&v, now()).unwrap();
        let text = read(&dir, &p);
        assert!(
            text.starts_with("---\ntype: journal\ndate: 2026-10-28\n---\n\n# 2026-10-28 (수) 업무일지\n"),
            "{text}"
        );
    }

    #[test]
    fn quick_memo_with_preset_goes_to_inbox() {
        let (dir, v) = vault();
        enable_preset(&v);
        let p = quick_memo_at(&v, "회의록 자동 요약\n#자동화", None, now()).unwrap();
        assert_eq!(p, "00.Inbox/메모 2026-10-28 0905.md");
        assert_eq!(
            read(&dir, &p),
            "---\ntype: idea\nstatus: 아이디어\ncreated: 2026-10-28\n---\n\n회의록 자동 요약\n#자동화"
        );
        assert_eq!(quick_memo_at(&v, "둘째", Some("  "), now()).unwrap(), "00.Inbox/메모 2026-10-28 0905 1.md");
        assert_eq!(quick_memo_at(&v, "x", Some("a/b: c?"), now()).unwrap(), "00.Inbox/ab c.md");
        assert_eq!(quick_memo_at(&v, "y", Some("ab c"), now()).unwrap(), "00.Inbox/ab c 1.md");
        assert_eq!(quick_memo_at(&v, "z", Some("??"), now()).unwrap(), "00.Inbox/메모 2026-10-28 0905 2.md");
        assert_eq!(quick_memo_at(&v, "z", Some("CON"), now()).unwrap(), "00.Inbox/메모 2026-10-28 0905 3.md");
        let ideas = idea_list(&v).unwrap();
        assert_eq!(ideas.len(), 6);
        assert!(ideas.iter().all(|i| i.status == "아이디어"));
    }

    #[test]
    fn quick_memo_without_preset_is_plain_note_in_root() {
        let (dir, v) = vault();
        let p = quick_memo_at(&v, "그냥 메모", Some("할 일"), now()).unwrap();
        assert_eq!(p, "할 일.md");
        assert_eq!(read(&dir, &p), "그냥 메모");
        assert!(!dir.path().join("00.Inbox").exists());
    }

    #[test]
    fn ideas_filter_by_type_and_sort_newest_first() {
        let (dir, v) = vault();
        let files = [
            ("a.md", "---\ntype: idea\nstatus: 검토\n---\n"),
            ("b.md", "---\nType: IDEA\n---\n"),
            ("c.md", "---\ntype: research\nstatus: 검토\n---\n"),
            ("d.md", "---\ntype: idea\nstatus: [진행, 완료]\n---\n"),
            ("e.md", "type: idea\n"),
        ];
        let base = SystemTime::now() - Duration::from_secs(1000);
        for (i, (name, content)) in files.iter().enumerate() {
            let p = dir.path().join(name);
            fs::write(&p, content).unwrap();
            let f = fs::File::options().write(true).open(&p).unwrap();
            f.set_modified(base + Duration::from_secs(i as u64 * 10)).unwrap();
        }
        v.index().scan(v.root()).unwrap();
        let got: Vec<_> = idea_list(&v).unwrap().into_iter().map(|i| (i.path, i.status)).collect();
        assert_eq!(
            got,
            [("d.md".to_string(), "진행".to_string()), ("b.md".into(), "".into()), ("a.md".into(), "검토".into())]
        );
        let first = &idea_list(&v).unwrap()[0];
        assert_eq!(first.title, "d");
        assert!(first.mtime > 0);
    }
}
