//! Canvas boards: `.canvas` files in the JSON Canvas format (cards of text, notes
//! and links placed freely and joined by lines). The app only creates and saves
//! them here; reading goes through `read_note` and the layout lives in the page.

use std::fs;
use std::path::Path;

use serde_json::Value;
use tauri::State;

use crate::commands::{AppState, with_vault};
use crate::error::{AppError, AppResult};
use crate::paths::{file_name, is_hidden, join_rel, normalize_rel, to_rel, validate_name};
use crate::vault::Vault;

const EXT: &str = ".canvas";
const UNTITLED: &str = "제목 없는 캔버스";
const EMPTY: &str = "{\n  \"nodes\": [],\n  \"edges\": []\n}\n";

fn is_canvas(rel: &str) -> bool {
    file_name(rel).to_lowercase().ends_with(EXT)
}

/// Makes an empty board in `dir_rel` ("제목 없는 캔버스", numbered if taken) or with `name`.
pub fn create_in(v: &Vault, dir_rel: &str, name: Option<&str>) -> AppResult<String> {
    let dir_rel = normalize_rel(dir_rel);
    let name = match name.map(str::trim).filter(|n| !n.is_empty()) {
        Some(n) => {
            let n = if is_canvas(n) { n.to_string() } else { format!("{n}{EXT}") };
            validate_name(&n)?;
            if v.abs(&join_rel(&dir_rel, &n))?.exists() {
                return Err(AppError::AlreadyExists(join_rel(&dir_rel, &n)));
            }
            n
        }
        None => v.unique_name(&dir_rel, UNTITLED, EXT)?,
    };
    let rel = join_rel(&dir_rel, &name);
    v.save_text(&rel, EMPTY)?;
    Ok(rel)
}

/// Saves a board. Only `.canvas` files, and only valid JSON, so a bug in the page
/// can never write over a note or leave a board the next open can't read.
pub fn save_in(v: &Vault, rel: &str, content: &str) -> AppResult<()> {
    if !is_canvas(rel) {
        return Err(AppError::InvalidName(rel.to_string()));
    }
    serde_json::from_str::<serde_json::Value>(content)?;
    v.save_text(rel, content)
}

/// Points cards at `to` where they showed `from` (a note, or anything inside a moved
/// folder), in every board of the vault. Returns how many boards changed.
pub fn retarget(v: &Vault, from: &str, to: &str) -> AppResult<usize> {
    let mut boards = Vec::new();
    collect(v.root(), &mut boards);
    let prefix = format!("{from}/");
    let mut changed = 0;
    for abs in boards {
        let Some(rel) = to_rel(v.root(), &abs) else { continue };
        let Ok(text) = fs::read_to_string(&abs) else { continue };
        let Ok(mut doc) = serde_json::from_str::<Value>(&text) else { continue };
        let mut hit = false;
        for node in doc.get_mut("nodes").and_then(Value::as_array_mut).into_iter().flatten() {
            let Some(file) = node.get("file").and_then(Value::as_str) else { continue };
            let file = normalize_rel(file);
            let new = if file == from {
                to.to_string()
            } else if let Some(rest) = file.strip_prefix(&prefix) {
                format!("{to}/{rest}")
            } else {
                continue;
            };
            node["file"] = Value::String(new);
            hit = true;
        }
        if hit {
            v.save_text(&rel, &(serde_json::to_string_pretty(&doc)? + "\n"))?;
            changed += 1;
        }
    }
    Ok(changed)
}

/// Every `.canvas` under `dir`, skipping hidden folders like `.app`.
fn collect(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if is_hidden(&name) {
            continue;
        }
        let p = e.path();
        if p.is_dir() {
            collect(&p, out);
        } else if is_canvas(&name) {
            out.push(p);
        }
    }
}

#[tauri::command]
pub fn create_canvas(state: State<AppState>, dir: String, name: Option<String>) -> AppResult<String> {
    with_vault(&state, |v| create_in(v, &dir, name.as_deref()))
}

#[tauri::command]
pub fn save_canvas(state: State<AppState>, path: String, content: String) -> AppResult<()> {
    with_vault(&state, |v| save_in(v, &path, &content))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_numbered_boards_and_saves_only_canvas_json() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        assert_eq!(create_in(&v, "", None).unwrap(), "제목 없는 캔버스.canvas");
        assert_eq!(create_in(&v, "", None).unwrap(), "제목 없는 캔버스 1.canvas");
        assert_eq!(create_in(&v, "보드", Some("계획")).unwrap(), "보드/계획.canvas");
        assert!(matches!(create_in(&v, "보드", Some("계획.canvas")), Err(AppError::AlreadyExists(_))));
        assert_eq!(v.read_note("보드/계획.canvas").unwrap(), EMPTY);

        save_in(&v, "보드/계획.canvas", r#"{"nodes":[{"id":"a"}],"edges":[]}"#).unwrap();
        assert!(v.read_note("보드/계획.canvas").unwrap().contains("\"a\""));
        assert!(matches!(save_in(&v, "노트.md", "{}"), Err(AppError::InvalidName(_))));
        assert!(matches!(save_in(&v, "보드/계획.canvas", "{깨짐"), Err(AppError::Json(_))));
        assert!(save_in(&v, "../밖.canvas", "{}").is_err());
    }

    #[test]
    fn cards_follow_renamed_notes_and_folders() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        v.create_note("회의", Some("1차"), "x").unwrap();
        v.create_note("", Some("메모"), "y").unwrap();
        let board = r#"{"nodes":[{"id":"a","type":"file","file":"회의/1차.md","x":0,"y":0,"width":100,"height":50},
            {"id":"b","type":"file","file":"메모.md","x":0,"y":0,"width":100,"height":50},
            {"id":"c","type":"text","text":"회의/1차.md","x":0,"y":0,"width":100,"height":50}],"edges":[],"extra":1}"#;
        save_in(&v, "보드.canvas", board).unwrap();
        save_in(&v, "다른.canvas", r#"{"nodes":[],"edges":[]}"#).unwrap();

        assert_eq!(v.rename("메모.md", "아이디어", true).unwrap(), "아이디어.md");
        assert_eq!(v.rename("회의", "회의록", true).unwrap(), "회의록");
        let doc: Value = serde_json::from_str(&v.read_note("보드.canvas").unwrap()).unwrap();
        let files: Vec<_> =
            doc["nodes"].as_array().unwrap().iter().map(|n| n["file"].as_str().unwrap_or("-").to_string()).collect();
        assert_eq!(files, ["회의록/1차.md", "아이디어.md", "-"]);
        assert_eq!(doc["nodes"][2]["text"], "회의/1차.md");
        assert_eq!(doc["extra"], 1);
        // Without link updates the boards stay as they are.
        v.rename("아이디어.md", "생각", false).unwrap();
        assert!(v.read_note("보드.canvas").unwrap().contains("\"아이디어.md\""));
    }
}
