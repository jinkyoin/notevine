//! AI through an API key or a model on this PC (FR-AI-07), next to the CLIs in
//! `ai.rs`: Anthropic (Claude) and OpenAI with the user's own API key, and Ollama.
//!
//! Privacy rules this module keeps:
//! - API keys live in the Windows Credential Manager, never in a file and never
//!   sent to the page: the page only learns whether a key is set.
//! - Nothing is sent unless `ai_run` is called, which the frontend does only after
//!   the user confirmed the notes to send (same as the CLIs).
//! - Ollama runs on this PC; its address is checked to be local.

use std::io::{BufRead, BufReader};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{Value, json};
use tauri::State;

use crate::ai::{AiEvent, AiProvider};
use crate::commands::AppState;
use crate::error::{AppError, AppResult};
use crate::web::agent;

// A development build keeps its keys apart from the installed app's.
const KEY_SERVICE: &str = if crate::DEV_BUILD { "Notevine AI (dev)" } else { "Notevine AI" };
const RUN_TIMEOUT: Duration = Duration::from_secs(300);
const ANTHROPIC_VERSION: &str = "2026-10-21";
/// Used when the user picked no model.
const ANTHROPIC_DEFAULT_MODEL: &str = "claude-opus-5-5";
/// Room for long answers; streaming, so no HTTP timeout concern.
const MAX_TOKENS: u32 = 64_000;
// 127.0.0.1, not localhost: Ollama listens on IPv4 only, and Windows takes about two
// seconds to give up on "localhost" as ::1 first.
pub const OLLAMA_DEFAULT_URL: &str = "http://127.0.0.1:11434";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Api {
    Anthropic,
    OpenAi,
    Ollama,
}

impl Api {
    pub fn parse(id: &str) -> Option<Self> {
        match id {
            "anthropic" => Some(Api::Anthropic),
            "openai" => Some(Api::OpenAi),
            "ollama" => Some(Api::Ollama),
            _ => None,
        }
    }

    fn id(self) -> &'static str {
        match self {
            Api::Anthropic => "anthropic",
            Api::OpenAi => "openai",
            Api::Ollama => "ollama",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Api::Anthropic => "Claude API (API 키)",
            Api::OpenAi => "OpenAI API (API 키)",
            Api::Ollama => "Ollama (내 PC)",
        }
    }
}

fn sys(msg: impl Into<String>) -> AppError {
    AppError::System(msg.into())
}

// ---------- keys ----------

fn entry(api: Api) -> AppResult<keyring::Entry> {
    keyring::Entry::new(KEY_SERVICE, api.id()).map_err(|e| sys(format!("자격 증명 저장소를 열지 못했습니다: {e}")))
}

fn key(api: Api) -> Option<String> {
    entry(api).ok()?.get_password().ok().filter(|k| !k.trim().is_empty())
}

// ---------- providers ----------

/// The API providers for the AI settings and panel: usable when a key is set, or
/// for Ollama when it answers at its address.
pub fn providers(ollama_url: &str) -> Vec<AiProvider> {
    let keyed = |api: Api| {
        let has = key(api).is_some();
        AiProvider {
            id: api.id().into(),
            name: api.name().into(),
            available: has,
            version: None,
            logged_in: Some(has),
            detail: (!has).then(|| "API 키를 넣으면 쓸 수 있습니다".into()),
        }
    };
    let url = ollama_base(ollama_url);
    let up = agent(Duration::from_secs(3)).get(&format!("{url}/api/tags")).call().is_ok();
    vec![
        keyed(Api::Anthropic),
        keyed(Api::OpenAi),
        AiProvider {
            id: "ollama".into(),
            name: Api::Ollama.name().into(),
            available: up,
            version: None,
            logged_in: up.then_some(true),
            detail: (!up).then(|| format!("Ollama가 실행 중이 아닙니다 ({url})")),
        },
    ]
}

/// The Ollama address, only on this PC.
pub fn ollama_base(url: &str) -> String {
    let u = url.trim().trim_end_matches('/');
    let u = if u.is_empty() { OLLAMA_DEFAULT_URL } else { u };
    let host = u.split("://").nth(1).unwrap_or("").split(['/', ':']).next().unwrap_or("");
    match host {
        "localhost" => u.replacen("localhost", "127.0.0.1", 1),
        "127.0.0.1" | "[::1]" => u.to_string(),
        _ => OLLAMA_DEFAULT_URL.to_string(),
    }
}

// ---------- requests ----------

/// Message of a failed HTTP call, from the service's JSON error when it sent one.
fn http_error(api: Api, e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, resp) => {
            let body = resp.into_string().unwrap_or_default();
            let detail = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| {
                    v.pointer("/error/message").or_else(|| v.get("error")).and_then(Value::as_str).map(str::to_string)
                })
                .unwrap_or_else(|| body.chars().take(300).collect());
            match code {
                401 | 403 => format!("{}: API 키가 맞지 않거나 권한이 없습니다 ({detail})", api.name()),
                429 => format!("{}: 요청이 너무 많거나 사용 한도를 넘었습니다 ({detail})", api.name()),
                _ => format!("{} 오류 {code}: {detail}", api.name()),
            }
        }
        ureq::Error::Transport(t) => format!("{}에 연결하지 못했습니다: {t}", api.name()),
    }
}

/// Models the service offers, newest-looking first.
pub fn models(api: Api, ollama_url: &str) -> AppResult<Vec<String>> {
    let a = agent(Duration::from_secs(15));
    let need_key = || key(api).ok_or_else(|| sys("API 키가 없습니다"));
    let v: Value = match api {
        Api::Anthropic => a
            .get("https://api.anthropic.com/v1/models?limit=100")
            .set("x-api-key", &need_key()?)
            .set("anthropic-version", ANTHROPIC_VERSION)
            .call(),
        Api::OpenAi => {
            a.get("https://api.openai.com/v1/models").set("Authorization", &format!("Bearer {}", need_key()?)).call()
        }
        Api::Ollama => a.get(&format!("{}/api/tags", ollama_base(ollama_url))).call(),
    }
    .map_err(|e| sys(http_error(api, e)))?
    .into_json()?;
    Ok(model_ids(api, &v))
}

fn model_ids(api: Api, v: &Value) -> Vec<String> {
    let list = match api {
        Api::Ollama => v.get("models"),
        _ => v.get("data"),
    };
    let mut items: Vec<(String, i64)> = list
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let id = m.get(if api == Api::Ollama { "name" } else { "id" })?.as_str()?.to_string();
            let created = m.get("created").and_then(Value::as_i64).unwrap_or(0);
            Some((id, created))
        })
        // OpenAI lists embedding, audio and image models too; keep the chat ones.
        .filter(|(id, _)| {
            api != Api::OpenAi || (id.starts_with("gpt-") || id.starts_with("o") || id.starts_with("chatgpt"))
        })
        .filter(|(id, _)| {
            api != Api::OpenAi
                || !["audio", "realtime", "tts", "transcribe", "image", "embedding", "search"]
                    .iter()
                    .any(|w| id.contains(w))
        })
        .collect();
    if api == Api::OpenAi {
        items.sort_by_key(|a| std::cmp::Reverse(a.1));
    }
    items.into_iter().map(|(id, _)| id).collect()
}

/// Server-side fallback (on a refusal another model answers) for the current
/// models that take it on the Claude API.
fn takes_fallbacks(model: &str) -> bool {
    matches!(model, "claude-opus-5-5" | "claude-opus-5" | "claude-fable-5-1" | "claude-sonnet-5-5")
}

/// What one streamed line says.
#[derive(Debug, PartialEq)]
enum Piece {
    Model(String),
    Text(String),
    Refused,
    Error(String),
    End,
}

/// Reads one line of the Anthropic or OpenAI SSE stream, or of Ollama's NDJSON.
fn parse_line(api: Api, line: &str) -> Vec<Piece> {
    let line = line.trim();
    let data = match api {
        Api::Ollama => line,
        _ => match line.strip_prefix("data:") {
            Some(d) => d.trim(),
            None => return vec![],
        },
    };
    if data == "[DONE]" {
        return vec![Piece::End];
    }
    let Ok(v) = serde_json::from_str::<Value>(data) else { return vec![] };
    let s = |p: &str| v.pointer(p).and_then(Value::as_str).map(str::to_string);
    match api {
        Api::Anthropic => match s("/type").as_deref() {
            Some("message_start") => s("/message/model").map(Piece::Model).into_iter().collect(),
            Some("content_block_delta") if s("/delta/type").as_deref() == Some("text_delta") => {
                s("/delta/text").map(Piece::Text).into_iter().collect()
            }
            Some("message_delta") if s("/delta/stop_reason").as_deref() == Some("refusal") => vec![Piece::Refused],
            Some("message_stop") => vec![Piece::End],
            Some("error") => vec![Piece::Error(s("/error/message").unwrap_or_else(|| data.to_string()))],
            _ => vec![],
        },
        Api::OpenAi => {
            if let Some(e) = s("/error/message") {
                return vec![Piece::Error(e)];
            }
            let mut out = Vec::new();
            if let Some(m) = s("/model") {
                out.push(Piece::Model(m));
            }
            if let Some(t) = s("/choices/0/delta/content").filter(|t| !t.is_empty()) {
                out.push(Piece::Text(t));
            }
            out
        }
        Api::Ollama => {
            if let Some(e) = s("/error") {
                return vec![Piece::Error(e)];
            }
            let mut out = Vec::new();
            if let Some(t) = s("/message/content").filter(|t| !t.is_empty()) {
                out.push(Piece::Text(t));
            }
            if v.get("done").and_then(Value::as_bool) == Some(true) {
                out.push(Piece::End);
            }
            out
        }
    }
}

/// Runs one question; events go to `sink`, ending with one `done` or `error`.
pub fn run(
    api: Api,
    system: &str,
    input: &str,
    model: Option<&str>,
    ollama_url: &str,
    cancel: &Arc<AtomicBool>,
    sink: &dyn Fn(AiEvent),
) {
    let result = (|| -> Result<String, String> {
        let a = agent(RUN_TIMEOUT);
        let model = match model {
            Some(m) => m.to_string(),
            None => match api {
                Api::Anthropic => ANTHROPIC_DEFAULT_MODEL.into(),
                _ => models(api, ollama_url)
                    .map_err(|e| e.to_string())?
                    .into_iter()
                    .next()
                    .ok_or("쓸 수 있는 모델이 없습니다. 설정 → AI에서 모델을 고르세요")?,
            },
        };
        let resp = match api {
            Api::Anthropic => {
                let k = key(api).ok_or("Claude API 키가 없습니다. 설정 → AI에서 넣으세요")?;
                let mut body = json!({
                    "model": model,
                    "max_tokens": MAX_TOKENS,
                    "system": system,
                    "messages": [{ "role": "user", "content": input }],
                    "stream": true,
                });
                let mut req = a
                    .post("https://api.anthropic.com/v1/messages")
                    .set("x-api-key", &k)
                    .set("anthropic-version", ANTHROPIC_VERSION)
                    .set("content-type", "application/json");
                if takes_fallbacks(&model) {
                    body["fallbacks"] = json!("default");
                    req = req.set("anthropic-beta", "server-side-fallback-2026-07-01");
                }
                req.send_json(body)
            }
            Api::OpenAi => {
                let k = key(api).ok_or("OpenAI API 키가 없습니다. 설정 → AI에서 넣으세요")?;
                a.post("https://api.openai.com/v1/chat/completions")
                    .set("Authorization", &format!("Bearer {k}"))
                    .send_json(json!({
                        "model": model,
                        "stream": true,
                        "messages": [{ "role": "system", "content": system }, { "role": "user", "content": input }],
                    }))
            }
            Api::Ollama => a.post(&format!("{}/api/chat", ollama_base(ollama_url))).send_json(json!({
                "model": model,
                "stream": true,
                "messages": [{ "role": "system", "content": system }, { "role": "user", "content": input }],
            })),
        }
        .map_err(|e| http_error(api, e))?;

        sink(AiEvent::Started { model: Some(model.clone()) });
        let mut text = String::new();
        let mut refused = false;
        for line in BufReader::new(resp.into_reader()).lines() {
            if cancel.load(Ordering::SeqCst) {
                return Err("요청을 취소했습니다".into());
            }
            let line = line.map_err(|e| format!("{} 응답을 읽다가 끊겼습니다: {e}", api.name()))?;
            for piece in parse_line(api, &line) {
                match piece {
                    Piece::Text(t) => {
                        text.push_str(&t);
                        sink(AiEvent::Delta { text: t });
                    }
                    Piece::Refused => refused = true,
                    Piece::Error(e) => return Err(format!("{}: {e}", api.name())),
                    Piece::Model(_) | Piece::End => {}
                }
            }
        }
        if refused && text.trim().is_empty() {
            return Err("AI가 이 요청에는 답하지 않았습니다".into());
        }
        Ok(text)
    })();
    sink(match result {
        Ok(text) => AiEvent::Done { text, cost_usd: None },
        Err(message) => AiEvent::Error { message },
    });
}

// ---------- commands ----------

/// Saves (or with an empty `key`, removes) an API key in the Windows Credential Manager.
#[tauri::command]
pub fn ai_set_key(provider: String, key: String) -> AppResult<()> {
    let api = Api::parse(&provider).filter(|a| *a != Api::Ollama).ok_or_else(|| sys("API 키를 쓰지 않는 AI입니다"))?;
    let e = entry(api)?;
    let key = key.trim();
    let r = if key.is_empty() {
        match e.delete_credential() {
            Err(keyring::Error::NoEntry) => Ok(()),
            r => r,
        }
    } else {
        e.set_password(key)
    };
    crate::ai::clear_provider_cache();
    r.map_err(|e| sys(format!("API 키를 저장하지 못했습니다: {e}")))
}

#[tauri::command]
pub async fn ai_models(state: State<'_, AppState>, provider: String) -> AppResult<Vec<String>> {
    let api = Api::parse(&provider).ok_or_else(|| sys(format!("알 수 없는 AI입니다: {provider}")))?;
    let url = state.settings.load().ollama_url;
    tauri::async_runtime::spawn_blocking(move || models(api, &url)).await.map_err(|e| sys(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_anthropic_stream() {
        let lines = [
            "event: message_start",
            r#"data: {"type":"message_start","message":{"model":"claude-opus-5-5"}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":""}}"#,
            r#"data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"안녕"}}"#,
            r#"data: {"type":"message_delta","delta":{"stop_reason":"refusal"}}"#,
            r#"data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
            r#"data: {"type":"message_stop"}"#,
        ];
        let got: Vec<Piece> = lines.iter().flat_map(|l| parse_line(Api::Anthropic, l)).collect();
        assert_eq!(
            got,
            [
                Piece::Model("claude-opus-5-5".into()),
                Piece::Text("안녕".into()),
                Piece::Refused,
                Piece::Error("Overloaded".into()),
                Piece::End
            ]
        );
    }

    #[test]
    fn reads_openai_and_ollama_streams() {
        let o: Vec<Piece> = [
            r#"data: {"model":"gpt-x","choices":[{"delta":{"content":"하나"}}]}"#,
            r#"data: {"model":"gpt-x","choices":[{"delta":{}}]}"#,
            "data: [DONE]",
        ]
        .iter()
        .flat_map(|l| parse_line(Api::OpenAi, l))
        .collect();
        assert_eq!(
            o,
            [Piece::Model("gpt-x".into()), Piece::Text("하나".into()), Piece::Model("gpt-x".into()), Piece::End]
        );
        let l: Vec<Piece> = [
            r#"{"message":{"content":"둘"},"done":false}"#,
            r#"{"message":{"content":""},"done":true}"#,
            r#"{"error":"model not found"}"#,
        ]
        .iter()
        .flat_map(|l| parse_line(Api::Ollama, l))
        .collect();
        assert_eq!(l, [Piece::Text("둘".into()), Piece::End, Piece::Error("model not found".into())]);
    }

    #[test]
    fn lists_models() {
        let openai = json!({"data": [
            {"id": "gpt-old", "created": 1}, {"id": "text-embedding-3", "created": 9}, {"id": "gpt-new", "created": 5},
            {"id": "gpt-new-audio", "created": 6}, {"id": "dall-e-3", "created": 7}
        ]});
        assert_eq!(model_ids(Api::OpenAi, &openai), ["gpt-new", "gpt-old"]);
        let anthropic = json!({"data": [{"id": "claude-opus-5-5"}, {"id": "claude-haiku-5-5"}]});
        assert_eq!(model_ids(Api::Anthropic, &anthropic), ["claude-opus-5-5", "claude-haiku-5-5"]);
        assert_eq!(model_ids(Api::Ollama, &json!({"models": [{"name": "llama3:8b"}]})), ["llama3:8b"]);
    }

    #[test]
    fn ollama_only_on_this_pc() {
        assert_eq!(ollama_base(""), OLLAMA_DEFAULT_URL);
        assert_eq!(ollama_base("http://127.0.0.1:11500/"), "http://127.0.0.1:11500");
        assert_eq!(ollama_base("http://evil.example.com:11434"), OLLAMA_DEFAULT_URL);
        assert_eq!(ollama_base("http://localhost.evil.com"), OLLAMA_DEFAULT_URL);
        assert_eq!(ollama_base("http://localhost:11434"), "http://127.0.0.1:11434");
    }
}
