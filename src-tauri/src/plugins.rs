//! Plugins (FR-EXT-02): folders in `.app/plugins/<id>/` with a `manifest.json` and
//! a `main.js`. This side only finds them and hands their code to the page, which
//! runs each one in a sandboxed frame and checks every call against the
//! permissions the user granted (`plugins` in the vault config).

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::{AppState, with_vault};
use crate::error::{AppError, AppResult};
use crate::paths::APP_DIR;
use crate::vault::Vault;

/// What a plugin may ask for. Anything else in a manifest makes it unusable.
pub const PERMISSIONS: [&str; 3] = ["read", "write", "network"];
const MAX_SOURCE: u64 = 2 * 1024 * 1024;
const SAMPLE_ID: &str = "hello-notevine";

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct Manifest {
    id: String,
    name: String,
    version: String,
    description: String,
    author: String,
    permissions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub permissions: Vec<String>,
    /// Why it can't be used (bad manifest, no main.js...); None when it can.
    pub error: Option<String>,
}

fn plugins_dir(v: &Vault) -> PathBuf {
    v.root().join(APP_DIR).join("plugins")
}

/// Plugin ids are folder names: lowercase letters, digits and dashes.
fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && b[0].is_ascii_alphanumeric()
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn read_plugin(dir: &std::path::Path, folder: &str) -> PluginInfo {
    let mut info = PluginInfo {
        id: folder.to_string(),
        name: folder.to_string(),
        version: String::new(),
        description: String::new(),
        author: String::new(),
        permissions: Vec::new(),
        error: None,
    };
    let manifest = match fs::read_to_string(dir.join("manifest.json")) {
        Ok(t) => t,
        Err(_) => {
            info.error = Some("manifest.json이 없습니다".into());
            return info;
        }
    };
    let m: Manifest = match serde_json::from_str(&manifest) {
        Ok(m) => m,
        Err(e) => {
            info.error = Some(format!("manifest.json을 읽지 못했습니다: {e}"));
            return info;
        }
    };
    if !m.name.trim().is_empty() {
        info.name = m.name.trim().to_string();
    }
    info.version = m.version;
    info.description = m.description;
    info.author = m.author;
    info.permissions = m.permissions.clone();
    info.error = if !valid_id(folder) {
        Some("폴더 이름은 영문 소문자·숫자·-만 쓸 수 있습니다".into())
    } else if m.id != folder {
        Some(format!("manifest의 id(\"{}\")가 폴더 이름과 다릅니다", m.id))
    } else if let Some(p) = m.permissions.iter().find(|p| !PERMISSIONS.contains(&p.as_str())) {
        Some(format!("알 수 없는 권한: {p}"))
    } else if !dir.join("main.js").is_file() {
        Some("main.js가 없습니다".into())
    } else {
        None
    };
    info
}

/// Every folder in `.app/plugins`, sorted by name; broken ones carry `error`.
pub fn list_in(v: &Vault) -> AppResult<Vec<PluginInfo>> {
    let dir = plugins_dir(v);
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut out: Vec<PluginInfo> = entries
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir())
        .map(|e| read_plugin(&e.path(), &e.file_name().to_string_lossy()))
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// The code of a usable plugin.
pub fn source_in(v: &Vault, id: &str) -> AppResult<String> {
    if !valid_id(id) {
        return Err(AppError::InvalidName(id.to_string()));
    }
    let dir = plugins_dir(v).join(id);
    if let Some(e) = read_plugin(&dir, id).error {
        return Err(AppError::System(format!("플러그인 {id}: {e}")));
    }
    let main = dir.join("main.js");
    if fs::metadata(&main)?.len() > MAX_SOURCE {
        return Err(AppError::System(format!("플러그인 {id}: main.js가 2MB보다 큽니다")));
    }
    Ok(fs::read_to_string(main)?)
}

const SAMPLE_MANIFEST: &str = r#"{
  "id": "hello-notevine",
  "name": "예시: 글자 수 세기",
  "version": "1.0.0",
  "description": "열린 노트의 글자 수를 오른쪽 패널에 보여 주고, 명령 팔레트에 '오늘 날짜 넣기'를 더합니다.",
  "author": "Notevine",
  "permissions": ["read", "write"]
}
"#;

const SAMPLE_MAIN: &str = r#"// Notevine 예시 플러그인. 자세한 설명은 사용자 매뉴얼 '플러그인' 장을 보세요.
// notevine.* 함수는 모두 Promise를 돌려줍니다.

async function show(path) {
  if (!path) return notevine.panel.set("<p>열린 노트가 없습니다.</p>");
  const text = await notevine.notes.read(path);
  const chars = text.replace(/\s/g, "").length;
  const lines = text.split("\n").length;
  notevine.panel.set(
    `<p><b>${chars.toLocaleString()}</b>자 (공백 빼고) · ${lines}줄</p>` +
      `<button data-action="refresh">다시 세기</button>`,
  );
}

notevine.panel.show("글자 수");
notevine.panel.onAction(async () => show(await notevine.notes.active()));
notevine.on("note-open", show);
notevine.on("note-save", show);
notevine.notes.active().then(show);

notevine.commands.add({
  id: "insert-date",
  name: "오늘 날짜 넣기",
  run: () => notevine.editor.insert(new Date().toLocaleDateString("ko-KR")),
});
"#;

/// Puts the sample plugin in `.app/plugins/hello-notevine` (kept if it is there).
pub fn create_sample_in(v: &Vault) -> AppResult<String> {
    let dir = plugins_dir(v).join(SAMPLE_ID);
    fs::create_dir_all(&dir)?;
    for (name, text) in [("manifest.json", SAMPLE_MANIFEST), ("main.js", SAMPLE_MAIN)] {
        let f = dir.join(name);
        if !f.exists() {
            fs::write(f, text)?;
        }
    }
    Ok(SAMPLE_ID.to_string())
}

#[tauri::command]
pub fn list_plugins(state: State<AppState>) -> AppResult<Vec<PluginInfo>> {
    with_vault(&state, list_in)
}

#[tauri::command]
pub fn plugin_source(state: State<AppState>, id: String) -> AppResult<String> {
    with_vault(&state, |v| source_in(v, &id))
}

/// `.app/plugins` as an absolute path, made if missing, to open in Explorer.
#[tauri::command]
pub fn plugins_folder(state: State<AppState>) -> AppResult<String> {
    with_vault(&state, |v| {
        let dir = plugins_dir(v);
        fs::create_dir_all(&dir)?;
        Ok(dir.display().to_string())
    })
}

#[tauri::command]
pub fn create_sample_plugin(state: State<AppState>) -> AppResult<String> {
    with_vault(&state, create_sample_in)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(v: &Vault, id: &str, manifest: &str, main: bool) {
        let d = plugins_dir(v).join(id);
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("manifest.json"), manifest).unwrap();
        if main {
            fs::write(d.join("main.js"), "notevine.ui.toast('hi')").unwrap();
        }
    }

    #[test]
    fn lists_plugins_and_explains_broken_ones() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        assert!(list_in(&v).unwrap().is_empty());

        put(&v, "good", r#"{"id":"good","name":"좋음","version":"1.0","permissions":["read"]}"#, true);
        put(&v, "other-id", r#"{"id":"wrong"}"#, true);
        put(&v, "perm", r#"{"id":"perm","permissions":["root"]}"#, true);
        put(&v, "nomain", r#"{"id":"nomain"}"#, false);
        put(&v, "Bad_Name", r#"{"id":"Bad_Name"}"#, true);
        put(&v, "broken", "{", true);

        let list = list_in(&v).unwrap();
        let err = |id: &str| list.iter().find(|p| p.id == id).unwrap().error.clone();
        assert_eq!(list.len(), 6);
        assert_eq!(err("good"), None);
        assert_eq!(list.iter().find(|p| p.id == "good").unwrap().name, "좋음");
        assert!(err("other-id").unwrap().contains("폴더 이름과 다릅니다"));
        assert!(err("perm").unwrap().contains("root"));
        assert!(err("nomain").unwrap().contains("main.js"));
        assert!(err("Bad_Name").unwrap().contains("소문자"));
        assert!(err("broken").unwrap().contains("manifest.json"));

        assert_eq!(source_in(&v, "good").unwrap(), "notevine.ui.toast('hi')");
        assert!(source_in(&v, "nomain").is_err());
        assert!(source_in(&v, "../good").is_err());
    }

    #[test]
    fn sample_plugin_is_valid_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        assert_eq!(create_sample_in(&v).unwrap(), SAMPLE_ID);
        let main = plugins_dir(&v).join(SAMPLE_ID).join("main.js");
        fs::write(&main, "// 내가 고침").unwrap();
        create_sample_in(&v).unwrap();
        assert_eq!(fs::read_to_string(&main).unwrap(), "// 내가 고침");
        let list = list_in(&v).unwrap();
        assert_eq!(list[0].error, None);
        assert_eq!(list[0].permissions, ["read", "write"]);
    }
}
