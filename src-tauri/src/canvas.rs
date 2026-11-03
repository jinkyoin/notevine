//! Canvas boards: `.canvas` files in the JSON Canvas format (cards of text, notes
//! and links placed freely and joined by lines). The app only creates and saves
//! them here; reading goes through `read_note` and the layout lives in the page.

use tauri::State;

use crate::commands::{AppState, with_vault};
use crate::error::{AppError, AppResult};
use crate::paths::{file_name, join_rel, normalize_rel, validate_name};
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
}
