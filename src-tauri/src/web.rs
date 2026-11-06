//! Web access the user asked for: fetching a page to clip as a note (FR-ATT-03).
//! Only http(s), with a time and size limit; nothing is fetched on its own.

use std::io::{self, Read};
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::time::Duration;

use serde::Serialize;

use crate::error::{AppError, AppResult};

/// Pages larger than this are cut off (clipping wants the article, not the media).
const MAX_PAGE_BYTES: u64 = 5 * 1024 * 1024;
/// One picture in a clipped page.
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

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
    let label = content_type.and_then(charset_in).or_else(|| {
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

/// The extension of a picture, judged by its content: a server's word for the type is not
/// enough. SVG stays out, since it can carry scripts.
fn image_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("jpg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" && matches!(&bytes[8..12], b"avif" | b"avis") {
        Some("avif")
    } else {
        None
    }
}

/// False for this PC, the local network and other addresses that aren't on the internet.
fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_unspecified()
                || v4.is_documentation()
                || v4.is_multicast()
                || (a == 100 && (64..128).contains(&b))
                || a >= 240)
        }
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => is_public(IpAddr::V4(v4)),
            None => {
                let first = v6.segments()[0];
                !(v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() || first & 0xfe00 == 0xfc00 || first & 0xffc0 == 0xfe80)
            }
        },
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = (bytes[i] == b'%').then(|| bytes.get(i + 1..i + 3)).flatten().and_then(|h| std::str::from_utf8(h).ok());
        match hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
            Some(b) => {
                out.push(b);
                i += 3;
            }
            None => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A file name from the last part of the address, safe for a file and for `![[…]]`.
fn image_name(url: &tauri::Url, ext: &str) -> String {
    let last = url.path_segments().and_then(|mut s| s.next_back()).map(percent_decode).unwrap_or_default();
    let last = last.rsplit(['/', '\\']).next().unwrap_or_default();
    let stem = last.rsplit_once('.').map_or(last, |(stem, _)| stem);
    let clean: String = stem.chars().map(|c| if c.is_control() || r#"\/:*?"<>|#^[]"#.contains(c) { ' ' } else { c }).collect();
    let clean = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    let clean: String = clean.trim_matches(['.', ' ']).chars().take(60).collect();
    format!("{}.{ext}", if clean.trim().is_empty() { "그림" } else { clean.trim() })
}

/// Fetches a picture named by a clipped page, for saving with the note. The page picks
/// the address, so it may only reach the internet or the page's own server, also through
/// redirects: the check is made where the name turns into an address.
pub fn download_image(url: &str, page_url: &str) -> AppResult<(String, Vec<u8>)> {
    check_web_url(url)?;
    let parsed = tauri::Url::parse(url.trim()).map_err(|e| AppError::System(e.to_string()))?;
    let page_host = tauri::Url::parse(page_url).ok().and_then(|u| u.host_str().map(|h| h.trim_matches(['[', ']']).to_string()));
    let resp = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .redirects(5)
        .user_agent(concat!("Notevine/", env!("CARGO_PKG_VERSION")))
        .resolver(move |netloc: &str| {
            let addrs: Vec<SocketAddr> = netloc.to_socket_addrs()?.collect();
            let host = netloc.rsplit_once(':').map_or(netloc, |(h, _)| h).trim_matches(['[', ']']);
            let own_server = page_host.as_deref().is_some_and(|p| p.eq_ignore_ascii_case(host));
            if own_server || addrs.iter().all(|a| is_public(a.ip())) {
                Ok(addrs)
            } else {
                Err(io::Error::new(io::ErrorKind::PermissionDenied, "not an internet address"))
            }
        })
        .build()
        .request_url("GET", &parsed)
        .call()
        .map_err(|e| AppError::System(format!("그림을 가져오지 못했습니다: {e}")))?;
    let mut bytes = Vec::new();
    resp.into_reader().take(MAX_IMAGE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(AppError::System("그림이 너무 큽니다".into()));
    }
    let ext = image_ext(&bytes).ok_or_else(|| AppError::System("그림 파일이 아닙니다".into()))?;
    Ok((image_name(&parsed, ext), bytes))
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

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nrest of the picture";

    /// A one-shot local web server; returns its address.
    fn serve(status: &'static str, headers: String, body: Vec<u8>) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut req = [0u8; 2048];
            let _ = std::io::Read::read(&mut s, &mut req);
            let head = format!("HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            let _ = std::io::Write::write_all(&mut s, head.as_bytes());
            let _ = std::io::Write::write_all(&mut s, &body);
        });
        addr
    }

    #[test]
    fn saves_a_picture_from_the_page_s_own_server() {
        let base = serve("200 OK", String::new(), PNG.to_vec());
        let (name, bytes) = download_image(&format!("{base}/%EC%82%AC%EC%A7%84.jpg?type=w773"), &format!("{base}/post")).unwrap();
        assert_eq!(name, "사진.png", "the extension follows the content");
        assert_eq!(bytes, PNG);
    }

    #[test]
    fn a_page_cannot_send_the_app_to_this_pc_or_the_local_network() {
        let base = serve("200 OK", String::new(), PNG.to_vec());
        assert!(download_image(&format!("{base}/a.png"), "https://blog.example.com/post").is_err());
    }

    #[test]
    fn a_redirect_cannot_reach_a_local_server_either() {
        let inner = serve("200 OK", String::new(), PNG.to_vec());
        let port = inner.rsplit(':').next().unwrap();
        // Allowed first stop, then a different local name for the same PC.
        let outer = serve("302 Found", format!("Location: http://localhost:{port}/a.png\r\n"), Vec::new());
        assert!(download_image(&format!("{outer}/a.png"), &format!("{outer}/post")).is_err());
    }

    #[test]
    fn only_real_pictures_are_kept() {
        for body in [b"<html>not found</html>".to_vec(), b"<svg onload=\"alert(1)\"></svg>".to_vec()] {
            let base = serve("200 OK", "Content-Type: image/png\r\n".into(), body);
            assert!(download_image(&format!("{base}/a.png"), &format!("{base}/post")).is_err());
        }
        assert!(download_image("file:///C:/secret.png", "https://a.com/").is_err());
    }

    #[test]
    fn tells_public_addresses_from_local_ones() {
        for ip in ["8.8.8.8", "125.209.222.141", "2606:4700::1111"] {
            assert!(is_public(ip.parse().unwrap()), "{ip}");
        }
        for ip in [
            "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.0.90", "169.254.169.254", "100.64.0.1", "0.0.0.0",
            "224.0.0.1", "255.255.255.255", "::1", "::", "fc00::1", "fe80::1", "ff02::1", "::ffff:192.168.0.1",
        ] {
            assert!(!is_public(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn recognizes_pictures_by_their_content() {
        assert_eq!(image_ext(PNG), Some("png"));
        assert_eq!(image_ext(b"\xff\xd8\xff\xe0...."), Some("jpg"));
        assert_eq!(image_ext(b"GIF89a...."), Some("gif"));
        assert_eq!(image_ext(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
        assert_eq!(image_ext(b"\0\0\0\x20ftypavif...."), Some("avif"));
        assert_eq!(image_ext(b"<svg></svg>"), None);
        assert_eq!(image_ext(b""), None);
    }

    #[test]
    fn names_a_picture_after_its_address() {
        let name = |u: &str| image_name(&tauri::Url::parse(u).unwrap(), "png");
        assert_eq!(name("https://a.com/x/agatha-official-1.png?type=w773"), "agatha-official-1.png");
        assert_eq!(name("https://a.com/%ED%95%9C%EA%B8%80.jpeg"), "한글.png");
        assert_eq!(name("https://a.com/a%7Cb%5D%23c.png"), "a b c.png");
        assert_eq!(name("https://a.com/"), "그림.png");
        assert_eq!(name("https://a.com/..%2F..%2Fevil.png"), "evil.png");
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
