//! Web access the user asked for: fetching a page to clip as a note (FR-ATT-03).
//! Only http(s), with a time and size limit; nothing is fetched on its own.

use std::io::Read;
use std::time::Duration;

use serde::Serialize;

use crate::error::{AppError, AppResult};

/// Pages larger than this are cut off (clipping wants the article, not the media).
const MAX_PAGE_BYTES: u64 = 5 * 1024 * 1024;

pub fn agent(timeout: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout(timeout)
        .redirects(5)
        .user_agent(concat!("Notevine/", env!("CARGO_PKG_VERSION")))
        .build()
}

/// "https://…" or "http://…"; anything else (file:, javascript:, a bare word) is refused.
pub fn check_web_url(url: &str) -> AppResult<()> {
    let lower = url.trim().to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") {
        Ok(())
    } else {
        Err(AppError::System("http:// 또는 https://로 시작하는 웹 주소만 가져올 수 있습니다".into()))
    }
}

/// Text of an HTML page in the charset its header or `<meta>` names (EUC-KR pages
/// are common in Korea), UTF-8 otherwise.
pub fn decode_html(bytes: &[u8], content_type: Option<&str>) -> String {
    let label = content_type
        .and_then(charset_in)
        .or_else(|| {
            // <meta charset="euc-kr"> or <meta http-equiv=… content="text/html; charset=euc-kr">
            let head = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).to_ascii_lowercase();
            head.find("charset=").map(|i| {
                head[i + 8..]
                    .trim_start_matches(['"', '\''])
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                    .collect::<String>()
            })
        });
    let enc = label.and_then(|l| encoding_rs::Encoding::for_label(l.as_bytes())).unwrap_or(encoding_rs::UTF_8);
    enc.decode(bytes).0.into_owned()
}

fn charset_in(content_type: &str) -> Option<String> {
    let lower = content_type.to_ascii_lowercase();
    let i = lower.find("charset=")?;
    Some(lower[i + 8..].trim_matches(['"', '\'', ' ', ';']).split(';').next()?.trim().to_string())
}

#[derive(Debug, Serialize)]
pub struct FetchedPage {
    /// Address after redirects: relative links in the page resolve against it.
    pub url: String,
    pub html: String,
}

#[tauri::command]
pub async fn fetch_page(url: String) -> AppResult<FetchedPage> {
    check_web_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        let resp = agent(Duration::from_secs(30))
            .get(url.trim())
            .set("Accept", "text/html,application/xhtml+xml")
            .call()
            .map_err(|e| AppError::System(format!("페이지를 가져오지 못했습니다: {e}")))?;
        let final_url = resp.get_url().to_string();
        let content_type = resp.header("content-type").map(str::to_string);
        if let Some(ct) = &content_type
            && !ct.contains("html")
            && !ct.contains("xml")
            && !ct.starts_with("text/")
        {
            return Err(AppError::System(format!("웹 페이지가 아닙니다 ({ct})")));
        }
        let mut bytes = Vec::new();
        resp.into_reader().take(MAX_PAGE_BYTES).read_to_end(&mut bytes)?;
        Ok(FetchedPage { url: final_url, html: decode_html(&bytes, content_type.as_deref()) })
    })
    .await
    .map_err(|e| AppError::System(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_addresses() {
        assert!(check_web_url("https://example.com/a").is_ok());
        assert!(check_web_url(" HTTP://example.com").is_ok());
        assert!(check_web_url("file:///C:/secret.txt").is_err());
        assert!(check_web_url("javascript:alert(1)").is_err());
        assert!(check_web_url("example.com").is_err());
    }

    #[test]
    fn decodes_by_header_meta_or_utf8() {
        let (euc, _, _) = encoding_rs::EUC_KR.encode("<p>안녕하세요</p>");
        assert_eq!(decode_html(&euc, Some("text/html; charset=EUC-KR")), "<p>안녕하세요</p>");
        let mut with_meta = b"<html><head><meta charset=\"euc-kr\"></head><body>".to_vec();
        with_meta.extend_from_slice(&euc);
        assert!(decode_html(&with_meta, Some("text/html")).contains("안녕하세요"));
        assert_eq!(decode_html("<p>한글</p>".as_bytes(), None), "<p>한글</p>");
    }
}
