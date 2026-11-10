//! FR-AI-03: 노트 폴더 안의 노트가 아닌 파일(텍스트·Office·한글 문서)을 AI에 보낼 글자로 바꾼다.
//! PDF는 화면의 PDF 엔진(pdfjs)이 글자를 뽑으므로 여기서 다루지 않는다.
//! 읽기만 하고 파일은 바꾸지 않는다. 실행하거나 외부로 보내는 일도 없다.

use std::borrow::Cow;
use std::fs;
use std::io::Read;
use std::path::Path;

use quick_xml::Reader;
use quick_xml::events::Event;
use tauri::State;

use crate::commands::{AppState, with_vault};
use crate::error::{AppError, AppResult};
use crate::paths::normalize_rel;

/// Larger files are not read (a 30 MB document is not something to send whole anyway).
const MAX_FILE_BYTES: u64 = 30 * 1024 * 1024;
/// A part inside an Office file larger than this is not unpacked (zip bombs).
const MAX_PART_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Text,
    Docx,
    Xlsx,
    Pptx,
    Hwpx,
}

const TEXT_EXT: &[&str] = &[
    "txt", "text", "csv", "tsv", "json", "jsonl", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "log", "html",
    "htm", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rs", "java", "kt", "c", "h", "cpp", "hpp", "cs", "go",
    "rb", "php", "swift", "sql", "sh", "ps1", "bat", "cmd", "r", "tex", "rst", "org", "srt", "vtt",
];

/// What a file is read as, by its extension. None: not sent (pictures, archives, programs, PDF here).
pub fn kind_of(rel: &str) -> Option<Kind> {
    let ext = Path::new(rel).extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "docx" => Some(Kind::Docx),
        "xlsx" => Some(Kind::Xlsx),
        "pptx" => Some(Kind::Pptx),
        "hwpx" => Some(Kind::Hwpx),
        e if TEXT_EXT.contains(&e) => Some(Kind::Text),
        _ => None,
    }
}

fn err(msg: impl Into<String>) -> AppError {
    AppError::Io(std::io::Error::other(msg.into()))
}

/// The text of a vault file to send to AI.
#[tauri::command]
pub fn ai_file_text(state: State<AppState>, path: String) -> AppResult<String> {
    with_vault(&state, |v| {
        let rel = normalize_rel(&path);
        let kind = kind_of(&rel).ok_or_else(|| err(format!("AI에 보낼 수 없는 파일 형식입니다: {rel}")))?;
        let abs = v.abs(&rel)?;
        if !abs.is_file() {
            return Err(AppError::NotFound(rel));
        }
        if fs::metadata(&abs)?.len() > MAX_FILE_BYTES {
            return Err(err(format!("30MB보다 큰 파일은 AI에 보내지 않습니다: {rel}")));
        }
        read_text(&abs, kind)
    })
}

pub fn read_text(abs: &Path, kind: Kind) -> AppResult<String> {
    let text = match kind {
        Kind::Text => decode(&fs::read(abs)?),
        Kind::Docx => {
            let mut z = open_zip(abs)?;
            xml_text(&part(&mut z, "word/document.xml")?)
        }
        Kind::Pptx => {
            let mut z = open_zip(abs)?;
            let slides = numbered(&z, "ppt/slides/slide", ".xml");
            let mut out = String::new();
            for (i, name) in slides.iter().enumerate() {
                out.push_str(&format!("## 슬라이드 {}\n{}\n\n", i + 1, xml_text(&part(&mut z, name)?).trim()));
            }
            out
        }
        Kind::Hwpx => {
            let mut z = open_zip(abs)?;
            let sections = numbered(&z, "Contents/section", ".xml");
            let mut out = String::new();
            for name in &sections {
                out.push_str(xml_text(&part(&mut z, name)?).trim());
                out.push_str("\n\n");
            }
            out
        }
        Kind::Xlsx => xlsx_text(abs)?,
    };
    Ok(tidy(&text))
}

/// UTF-8 (with or without BOM), UTF-16 with BOM, else the Korean Windows code page (CP949).
fn decode(bytes: &[u8]) -> String {
    if let Some((enc, bom)) = encoding_rs::Encoding::for_bom(bytes) {
        return enc.decode_without_bom_handling(&bytes[bom..]).0.into_owned();
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => encoding_rs::EUC_KR.decode(bytes).0.into_owned(),
    }
}

/// Runs of blank lines become one; trailing spaces go.
fn tidy(s: &str) -> String {
    let mut out = String::new();
    let mut blank = 0;
    for line in s.replace("\r\n", "\n").lines() {
        let line = line.trim_end();
        if line.is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.trim().to_string()
}

type Zip = zip::ZipArchive<fs::File>;

fn open_zip(abs: &Path) -> AppResult<Zip> {
    zip::ZipArchive::new(fs::File::open(abs)?)
        .map_err(|_| err("문서 파일을 열 수 없습니다 (손상됐거나 암호가 걸린 파일)"))
}

fn part(z: &mut Zip, name: &str) -> AppResult<String> {
    let f = z.by_name(name).map_err(|_| err(format!("문서 안에 {name}이(가) 없습니다")))?;
    if f.size() > MAX_PART_BYTES {
        return Err(err("문서 내용이 너무 큽니다"));
    }
    let mut s = String::new();
    f.take(MAX_PART_BYTES).read_to_string(&mut s)?;
    Ok(s)
}

/// Parts named `<prefix><n><suffix>`, by n.
fn numbered(z: &Zip, prefix: &str, suffix: &str) -> Vec<String> {
    let mut found: Vec<(u32, String)> = z
        .file_names()
        .filter_map(|n| {
            let n = n.ok()?;
            let num = n.strip_prefix(prefix)?.strip_suffix(suffix)?.parse().ok()?;
            Some((num, n.to_string()))
        })
        .collect();
    found.sort();
    found.into_iter().map(|(_, n)| n).collect()
}

/// Text of a WordprocessingML / DrawingML / OWPML part: the text runs (`t`), a line per
/// paragraph (`p`), a tab between table cells (`tc`) and for tabs.
fn xml_text(xml: &str) -> String {
    let mut r = Reader::from_str(xml);
    let mut out = String::new();
    let mut in_t = 0usize;
    loop {
        match r.read_event() {
            Ok(Event::Start(e)) if e.local_name().as_ref() == "t" => in_t += 1,
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                "t" => in_t = in_t.saturating_sub(1),
                "p" => out.push('\n'),
                "tc" => out.push('\t'),
                "tr" => out.push('\n'),
                _ => {}
            },
            Ok(Event::Empty(e)) => match e.local_name().as_ref() {
                "tab" => out.push('\t'),
                "br" | "lineBreak" => out.push('\n'),
                _ => {}
            },
            Ok(Event::Text(t)) if in_t > 0 => out.push_str(&t.xml10_content()),
            Ok(Event::GeneralRef(e)) if in_t > 0 => out.push_str(&entity(&e)),
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out
}

fn entity(e: &quick_xml::events::BytesRef) -> Cow<'static, str> {
    if let Ok(Some(c)) = e.resolve_char_ref() {
        return Cow::Owned(c.to_string());
    }
    let name: &str = e;
    Cow::Borrowed(quick_xml::escape::resolve_predefined_entity(name).unwrap_or(""))
}

/// Every sheet as "## 이름" then its rows, cells separated by tabs.
fn xlsx_text(abs: &Path) -> AppResult<String> {
    let mut z = open_zip(abs)?;
    let has_shared = z.index_for_name("xl/sharedStrings.xml").is_some();
    let shared = if has_shared { shared_strings(&part(&mut z, "xl/sharedStrings.xml")?) } else { Vec::new() };
    let names = sheet_names(&part(&mut z, "xl/workbook.xml")?);
    let sheets = numbered(&z, "xl/worksheets/sheet", ".xml");
    let mut out = String::new();
    for (i, name) in sheets.iter().enumerate() {
        let title = names.get(i).cloned().unwrap_or_else(|| format!("시트 {}", i + 1));
        out.push_str(&format!("## {title}\n{}\n\n", sheet_rows(&part(&mut z, name)?, &shared)));
    }
    Ok(out)
}

fn shared_strings(xml: &str) -> Vec<String> {
    let mut r = Reader::from_str(xml);
    let (mut list, mut cur, mut in_t) = (Vec::new(), String::new(), false);
    loop {
        match r.read_event() {
            Ok(Event::Start(e)) if e.local_name().as_ref() == "t" => in_t = true,
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                "t" => in_t = false,
                "si" => list.push(std::mem::take(&mut cur)),
                _ => {}
            },
            Ok(Event::Text(t)) if in_t => cur.push_str(&t.xml10_content()),
            Ok(Event::GeneralRef(e)) if in_t => cur.push_str(&entity(&e)),
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    list
}

fn sheet_names(xml: &str) -> Vec<String> {
    let mut r = Reader::from_str(xml);
    let mut names = Vec::new();
    loop {
        match r.read_event() {
            Ok(Event::Start(e) | Event::Empty(e)) if e.local_name().as_ref() == "sheet" => {
                if let Some(Ok(a)) = e.attributes().find(|a| a.as_ref().is_ok_and(|a| a.key.as_ref() == "name")) {
                    names.push(
                        a.normalized_value(quick_xml::XmlVersion::Implicit1_0)
                            .map(|v| v.into_owned())
                            .unwrap_or_default(),
                    );
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    names
}

/// A sheet's rows: shared strings looked up, inline strings and values as written.
fn sheet_rows(xml: &str, shared: &[String]) -> String {
    let mut r = Reader::from_str(xml);
    let mut out = String::new();
    let mut row: Vec<String> = Vec::new();
    let (mut shared_cell, mut in_value, mut cell) = (false, false, String::new());
    loop {
        match r.read_event() {
            Ok(Event::Start(e)) => match e.local_name().as_ref() {
                "c" => {
                    shared_cell = e.attributes().flatten().any(|a| a.key.as_ref() == "t" && a.value == "s");
                    cell.clear();
                }
                "v" | "t" => in_value = true,
                _ => {}
            },
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                "v" | "t" => in_value = false,
                "c" => {
                    let v = if shared_cell {
                        cell.trim().parse::<usize>().ok().and_then(|i| shared.get(i)).cloned().unwrap_or_default()
                    } else {
                        std::mem::take(&mut cell)
                    };
                    row.push(v.replace(['\t', '\n'], " "));
                }
                "row" => {
                    while row.last().is_some_and(|c| c.is_empty()) {
                        row.pop();
                    }
                    if !row.is_empty() {
                        out.push_str(&row.join("\t"));
                        out.push('\n');
                    }
                    row.clear();
                }
                _ => {}
            },
            Ok(Event::Text(t)) if in_value => cell.push_str(&t.xml10_content()),
            Ok(Event::GeneralRef(e)) if in_value => cell.push_str(&entity(&e)),
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_zip(path: &Path, parts: &[(&str, &str)]) {
        let mut w = zip::ZipWriter::new(fs::File::create(path).unwrap());
        for (name, body) in parts {
            w.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            w.write_all(body.as_bytes()).unwrap();
        }
        w.finish().unwrap();
    }

    #[test]
    fn kinds_by_extension() {
        assert_eq!(kind_of("a/메모.TXT"), Some(Kind::Text));
        assert_eq!(kind_of("표.xlsx"), Some(Kind::Xlsx));
        assert_eq!(kind_of("제안.hwpx"), Some(Kind::Hwpx));
        assert_eq!(kind_of("그림.png"), None);
        assert_eq!(kind_of("문서.pdf"), None);
        assert_eq!(kind_of("이름없음"), None);
    }

    #[test]
    fn text_files_in_utf8_bom_or_cp949() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.txt");
        fs::write(&p, "\u{feff}가나\r\n\r\n\r\n다  \n").unwrap();
        assert_eq!(read_text(&p, Kind::Text).unwrap(), "가나\n\n다");
        let (cp949, _, _) = encoding_rs::EUC_KR.encode("한글 메모");
        fs::write(&p, &cp949).unwrap();
        assert_eq!(read_text(&p, Kind::Text).unwrap(), "한글 메모");
    }

    #[test]
    fn docx_paragraphs_tables_and_entities() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.docx");
        let doc = r#"<w:document xmlns:w="w"><w:body>
            <w:p><w:r><w:t>제안 &amp; 요청</w:t></w:r></w:p>
            <w:tbl><w:tr><w:tc><w:p><w:r><w:t>항목</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>배점</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
            <w:p><w:r><w:t xml:space="preserve">끝</w:t></w:r></w:p></w:body></w:document>"#;
        make_zip(&p, &[("word/document.xml", doc)]);
        let t = read_text(&p, Kind::Docx).unwrap();
        assert!(t.starts_with("제안 & 요청\n"), "{t}");
        assert!(t.contains("항목\n\t배점"), "{t}");
        assert!(t.ends_with("끝"), "{t}");
    }

    #[test]
    fn pptx_slides_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.pptx");
        let s = |t: &str| format!(r#"<p:sld xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>{t}</a:t></a:r></a:p></p:sld>"#);
        make_zip(
            &p,
            &[
                ("ppt/slides/slide10.xml", &s("열")),
                ("ppt/slides/slide2.xml", &s("둘")),
                ("ppt/slides/slide1.xml", &s("하나")),
            ],
        );
        let t = read_text(&p, Kind::Pptx).unwrap();
        assert_eq!(t, "## 슬라이드 1\n하나\n\n## 슬라이드 2\n둘\n\n## 슬라이드 3\n열");
    }

    #[test]
    fn hwpx_sections() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.hwpx");
        let sec = |t: &str| {
            format!(r#"<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p><hp:run><hp:t>{t}</hp:t></hp:run></hp:p></hs:sec>"#)
        };
        make_zip(&p, &[("Contents/section0.xml", &sec("과업 범위")), ("Contents/section1.xml", &sec("제출 서류"))]);
        assert_eq!(read_text(&p, Kind::Hwpx).unwrap(), "과업 범위\n\n제출 서류");
    }

    #[test]
    fn xlsx_sheets_with_shared_and_inline_strings() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.xlsx");
        let wb = r#"<workbook><sheets><sheet name="예산" sheetId="1"/><sheet name="인력 &amp; 일정" sheetId="2"/></sheets></workbook>"#;
        let ss = r#"<sst><si><t>항목</t></si><si><r><t>금</t></r><r><t>액</t></r></si></sst>"#;
        let s1 = r#"<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row><row><c t="inlineStr"><is><t>인건비</t></is></c><c><v>1200</v></c></row></sheetData></worksheet>"#;
        let s2 = r#"<worksheet><sheetData><row><c><v>3</v></c></row></sheetData></worksheet>"#;
        make_zip(
            &p,
            &[
                ("xl/workbook.xml", wb),
                ("xl/sharedStrings.xml", ss),
                ("xl/worksheets/sheet1.xml", s1),
                ("xl/worksheets/sheet2.xml", s2),
            ],
        );
        assert_eq!(read_text(&p, Kind::Xlsx).unwrap(), "## 예산\n항목\t금액\n인건비\t1200\n\n## 인력 & 일정\n3");
    }

    #[test]
    fn broken_office_file_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.docx");
        fs::write(&p, "zip 아님").unwrap();
        assert!(read_text(&p, Kind::Docx).is_err());
    }
}
