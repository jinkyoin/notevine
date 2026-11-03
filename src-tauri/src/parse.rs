//! Extracts index data from a note's markdown text: frontmatter properties,
//! tags, and wiki/markdown links. Pure and panic-free on any input.

use std::collections::HashSet;

use serde::Serialize;
use unicode_normalization::UnicodeNormalization;
use yaml_rust2::{Yaml, YamlLoader};

use crate::paths::{name_key, normalize_rel};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkKind {
    Wiki,
    Embed,
    Markdown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Link {
    /// NFC, `/` separators. Wiki: the name as written (`폴더/회의록`);
    /// markdown: the percent-decoded relative path (`폴더/회의록.md`).
    pub target: String,
    /// Text after `#` (heading or block), if any.
    pub anchor: Option<String>,
    /// Wiki: text after `|`; markdown: the link text.
    pub alias: Option<String>,
    pub kind: LinkKind,
    /// 1-based line number in the full content.
    pub line: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ValueType {
    Text,
    Number,
    Bool,
    Date,
    Url,
    List,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Property {
    pub key: String,
    /// Scalar as string. Each list item is its own row with type `List`.
    pub value: String,
    pub value_type: ValueType,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Parsed {
    pub properties: Vec<Property>,
    /// Unique (case-insensitive), without `#`, first-seen spelling, NFC.
    pub tags: Vec<String>,
    /// In document order.
    pub links: Vec<Link>,
    /// Content with the frontmatter block removed.
    pub body: String,
    /// Set when a frontmatter block exists but is not valid YAML (or not a map).
    pub frontmatter_error: Option<String>,
}

/// Parses one note. Never panics.
pub fn parse(content: &str) -> Parsed {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut out = Parsed::default();
    let mut tags = TagSet::default();

    let (lines_before_body, body) = match split_frontmatter(content) {
        Some(fm) => {
            read_properties(fm.yaml, &mut out, &mut tags);
            (fm.lines_before_body, fm.body)
        }
        None => (0, content),
    };
    out.body = body.to_string();
    scan_body(body, lines_before_body, &mut out.links, &mut tags);
    out.tags = tags.list;
    out
}

// ---------- frontmatter ----------

struct Frontmatter<'a> {
    yaml: &'a str,
    body: &'a str,
    /// Number of lines up to and including the closing delimiter.
    lines_before_body: usize,
}

fn trim_eol(line: &str) -> &str {
    line.trim_end_matches(['\n', '\r', ' ', '\t'])
}

fn split_frontmatter(content: &str) -> Option<Frontmatter<'_>> {
    let mut lines = content.split_inclusive('\n');
    let first = lines.next()?;
    if trim_eol(first) != "---" {
        return None;
    }
    let yaml_start = first.len();
    let mut pos = yaml_start;
    for (count, line) in (2..).zip(lines) {
        let t = trim_eol(line);
        if t == "---" || t == "..." {
            return Some(Frontmatter {
                yaml: &content[yaml_start..pos],
                body: &content[pos + line.len()..],
                lines_before_body: count,
            });
        }
        pos += line.len();
    }
    None
}

fn read_properties(yaml: &str, out: &mut Parsed, tags: &mut TagSet) {
    let docs = match YamlLoader::load_from_str(yaml) {
        Ok(d) => d,
        Err(e) => {
            out.frontmatter_error = Some(e.to_string());
            return;
        }
    };
    let map = match docs.into_iter().next() {
        None | Some(Yaml::Null) => return,
        Some(Yaml::Hash(h)) => h,
        Some(_) => {
            out.frontmatter_error = Some("frontmatter is not a key: value map".into());
            return;
        }
    };
    for (k, v) in map {
        let Some(key) = scalar(&k).map(|(s, _)| nfc(s.trim())) else {
            continue;
        };
        if key.is_empty() {
            continue;
        }
        let is_tags = matches!(key.to_lowercase().as_str(), "tags" | "tag");
        match &v {
            Yaml::Array(items) => {
                for item in items {
                    let value = match item {
                        Yaml::Array(_) | Yaml::Hash(_) => to_json(item).to_string(),
                        _ => match scalar(item) {
                            Some((s, _)) => s,
                            None => continue,
                        },
                    };
                    if is_tags {
                        tags.add(value.trim().trim_start_matches('#'));
                    }
                    out.properties.push(Property { key: key.clone(), value: nfc(&value), value_type: ValueType::List });
                }
            }
            Yaml::Hash(_) => {
                out.properties.push(Property { key, value: nfc(&to_json(&v).to_string()), value_type: ValueType::Text })
            }
            _ => {
                let Some((value, value_type)) = scalar(&v) else {
                    continue;
                };
                if is_tags {
                    for t in value.split(|c: char| c == ',' || c.is_whitespace()) {
                        tags.add(t.trim_start_matches('#'));
                    }
                }
                out.properties.push(Property { key, value: nfc(&value), value_type });
            }
        }
    }
}

/// A scalar's string form and type; `None` for null, empty, or non-scalars.
fn scalar(y: &Yaml) -> Option<(String, ValueType)> {
    match y {
        Yaml::Boolean(b) => Some((b.to_string(), ValueType::Bool)),
        Yaml::Integer(i) => Some((i.to_string(), ValueType::Number)),
        Yaml::Real(r) => Some((r.clone(), ValueType::Number)),
        Yaml::String(s) if s.trim().is_empty() => None,
        Yaml::String(s) => {
            let ty = if is_date(s) {
                ValueType::Date
            } else if s.starts_with("http://") || s.starts_with("https://") {
                ValueType::Url
            } else {
                ValueType::Text
            };
            Some((s.clone(), ty))
        }
        _ => None,
    }
}

/// `YYYY-MM-DD`, optionally followed by `T` or a space and a time.
fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 10 {
        return false;
    }
    let shape = b[..10].iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() });
    shape
        && match b.get(10) {
            None => true,
            Some(b'T' | b' ') => b.get(11).is_some_and(u8::is_ascii_digit),
            _ => false,
        }
}

fn to_json(y: &Yaml) -> serde_json::Value {
    use serde_json::Value;
    match y {
        Yaml::Hash(h) => Value::Object(
            h.iter()
                .map(|(k, v)| {
                    let key = scalar(k).map(|(s, _)| s).unwrap_or_default();
                    (key, to_json(v))
                })
                .collect(),
        ),
        Yaml::Array(a) => Value::Array(a.iter().map(to_json).collect()),
        Yaml::String(s) => Value::String(s.clone()),
        Yaml::Integer(i) => Value::from(*i),
        Yaml::Real(r) => r
            .parse::<f64>()
            .ok()
            .and_then(serde_json::Number::from_f64)
            .map_or_else(|| Value::String(r.clone()), Value::Number),
        Yaml::Boolean(b) => Value::Bool(*b),
        _ => Value::Null,
    }
}

// ---------- body ----------

#[derive(Default)]
struct TagSet {
    list: Vec<String>,
    seen: HashSet<String>,
}

impl TagSet {
    fn add(&mut self, tag: &str) {
        let tag = nfc(tag.trim());
        if !tag.is_empty() && self.seen.insert(name_key(&tag)) {
            self.list.push(tag);
        }
    }
}

fn nfc(s: &str) -> String {
    s.nfc().collect()
}

fn scan_body(body: &str, lines_before: usize, links: &mut Vec<Link>, tags: &mut TagSet) {
    let mut fence: Option<(char, usize)> = None;
    for (i, raw) in body.split('\n').enumerate() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some((ch, len)) = fence {
            if is_fence_close(line, ch, len) {
                fence = None;
            }
            continue;
        }
        if let Some(f) = fence_open(line) {
            fence = Some(f);
            continue;
        }
        let ctx =
            Line { text: line, code: code_spans(line), no: u32::try_from(lines_before + i + 1).unwrap_or(u32::MAX) };
        ctx.scan(0, line.len(), links, tags);
    }
}

/// Opening code fence: 3+ backticks or tildes (any indentation).
fn fence_open(line: &str) -> Option<(char, usize)> {
    let t = line.trim_start();
    let ch = t.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let len = t.chars().take_while(|c| *c == ch).count();
    if len < 3 || (ch == '`' && t[len..].contains('`')) {
        return None;
    }
    Some((ch, len))
}

fn is_fence_close(line: &str, ch: char, len: usize) -> bool {
    let t = line.trim();
    t.len() >= len && t.chars().all(|c| c == ch)
}

/// Byte ranges of inline code spans (matching backtick runs) in one line.
fn code_spans(line: &str) -> Vec<(usize, usize)> {
    let b = line.as_bytes();
    let run_end = |mut j: usize| {
        while j < b.len() && b[j] == b'`' {
            j += 1;
        }
        j
    };
    let mut spans = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'`' {
            i += 1;
            continue;
        }
        let start = i;
        i = run_end(i);
        let run = i - start;
        let mut j = i;
        while j < b.len() {
            if b[j] == b'`' {
                let s = j;
                j = run_end(j);
                if j - s == run {
                    spans.push((start, j));
                    i = j;
                    break;
                }
            } else {
                j += 1;
            }
        }
    }
    spans
}

struct Line<'a> {
    text: &'a str,
    code: Vec<(usize, usize)>,
    no: u32,
}

impl Line<'_> {
    fn overlaps_code(&self, a: usize, b: usize) -> bool {
        self.code.iter().any(|&(s, e)| s < b && e > a)
    }

    /// Scans `text[start..end]` for links and tags.
    fn scan(&self, start: usize, end: usize, links: &mut Vec<Link>, tags: &mut TagSet) {
        let mut i = start;
        while i < end {
            if let Some(&(_, e)) = self.code.iter().find(|&&(s, e)| s <= i && i < e) {
                i = e;
                continue;
            }
            let rest = &self.text[i..end];
            let next = if let Some(len) = html_tag_len(rest) {
                // `<span style="color: #1c7ed6">`: a color, not a tag.
                Some(i + len)
            } else if rest.starts_with("![[") || rest.starts_with("[[") {
                self.wiki(i, end, links)
            } else if rest.starts_with("![") || rest.starts_with('[') {
                self.markdown(i, end, links, tags)
            } else if rest.starts_with('#') {
                self.tag(i, end, tags)
            } else {
                None
            };
            i = next.unwrap_or_else(|| i + rest.chars().next().map_or(1, char::len_utf8));
        }
    }

    /// `[[target#anchor|alias]]` or `![[...]]`; returns the byte after `]]`.
    fn wiki(&self, i: usize, end: usize, links: &mut Vec<Link>) -> Option<usize> {
        let embed = self.text[i..].starts_with('!');
        let inner_start = i + if embed { 3 } else { 2 };
        let close = inner_start + self.text[inner_start..end].find("]]")?;
        let inner = &self.text[inner_start..close];
        if inner.contains("[[") || self.overlaps_code(i, close + 2) {
            return None;
        }
        let (left, alias) = split_once_opt(inner, '|');
        let (target, anchor) = split_once_opt(left, '#');
        let target = normalize_rel(target.trim());
        if !target.is_empty() {
            links.push(Link {
                target,
                anchor: non_empty(anchor),
                alias: non_empty(alias),
                kind: if embed { LinkKind::Embed } else { LinkKind::Wiki },
                line: self.no,
            });
        }
        Some(close + 2)
    }

    /// `[text](dest)` or `![alt](dest)`; returns the byte after `)`.
    fn markdown(&self, i: usize, end: usize, links: &mut Vec<Link>, tags: &mut TagSet) -> Option<usize> {
        let b = self.text.as_bytes();
        let image = b[i] == b'!';
        let text_start = i + if image { 2 } else { 1 };
        let text_end = matching(b, text_start, end, b'[', b']')?;
        if b.get(text_end + 1) != Some(&b'(') {
            return None;
        }
        let dest_start = text_end + 2;
        let dest_end = matching(b, dest_start, end, b'(', b')')?;
        if self.overlaps_code(i, dest_end + 1) {
            return None;
        }
        let raw = self.text[dest_start..dest_end].trim();
        let dest = match raw.strip_prefix('<') {
            Some(r) => r.split_once('>').map_or(r, |(d, _)| d),
            None => raw.split_whitespace().next().unwrap_or(""),
        };
        if let Some(target) = local_target(dest) {
            let (path, anchor) = split_once_opt(target, '#');
            let path = normalize_rel(&percent_decode(path));
            if !path.is_empty() {
                links.push(Link {
                    target: path,
                    anchor: anchor.map(percent_decode).and_then(|a| non_empty(Some(&a))),
                    alias: non_empty(Some(&self.text[text_start..text_end])),
                    kind: if image { LinkKind::Embed } else { LinkKind::Markdown },
                    line: self.no,
                });
            }
        }
        // Link text may hold tags or a nested image.
        self.scan(text_start, text_end, links, tags);
        Some(dest_end + 1)
    }

    /// `#tag`; returns the byte after the tag.
    fn tag(&self, i: usize, end: usize, tags: &mut TagSet) -> Option<usize> {
        let prev_ok = self.text[..i].chars().next_back().is_none_or(|p| {
            p.is_whitespace() || !(p.is_alphanumeric() || matches!(p, '_' | '#' | '&' | '/' | '-' | '\\' | ':' | '.'))
        });
        if !prev_ok {
            return None;
        }
        let body_start = i + 1;
        let len: usize = self.text[body_start..end]
            .chars()
            .take_while(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '/'))
            .map(char::len_utf8)
            .sum();
        let tag = self.text[body_start..body_start + len].trim_end_matches('/');
        if tag.is_empty() || tag.chars().all(char::is_numeric) {
            return None;
        }
        tags.add(tag);
        Some(body_start + len)
    }
}

/// Length of an HTML tag (`<span ...>`, `</span>`, `<!-- -->`) at the start of
/// `s`, up to its `>` on the same line. A `<` not followed by a tag name (as in
/// "a < b") is not a tag.
fn html_tag_len(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    if b.first() != Some(&b'<') {
        return None;
    }
    let name = match b.get(1) {
        Some(b'/') => 2,
        Some(b'!') => return s.find('>').map(|e| e + 1),
        _ => 1,
    };
    if !b.get(name).is_some_and(u8::is_ascii_alphabetic) {
        return None;
    }
    s.find('>').map(|e| e + 1)
}

/// Index of the closing bracket matching an already-consumed opener, within
/// `b[from..end]`. Brackets are ASCII so the index is a char boundary.
fn matching(b: &[u8], from: usize, end: usize, open: u8, close: u8) -> Option<usize> {
    let mut depth = 0usize;
    let mut escaped = false;
    for (j, &c) in b.get(from..end)?.iter().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }
        if c == b'\\' {
            escaped = true;
            continue;
        }
        if c == open {
            depth += 1;
        } else if c == close {
            if depth == 0 {
                return Some(from + j);
            }
            depth -= 1;
        }
    }
    None
}

fn split_once_opt(s: &str, sep: char) -> (&str, Option<&str>) {
    match s.split_once(sep) {
        Some((a, b)) => (a, Some(b)),
        None => (s, None),
    }
}

fn non_empty(s: Option<&str>) -> Option<String> {
    s.map(str::trim).filter(|s| !s.is_empty()).map(nfc)
}

/// The destination without a leading `/`, or `None` if it is external or a
/// same-note anchor.
fn local_target(dest: &str) -> Option<&str> {
    if dest.is_empty() || dest.starts_with('#') || dest.starts_with("//") {
        return None;
    }
    let scheme_len = dest.find(':').filter(|&n| {
        n > 0
            && dest[..n].starts_with(|c: char| c.is_ascii_alphabetic())
            && dest[..n].chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    });
    if scheme_len.is_some() {
        return None;
    }
    Some(dest.trim_start_matches('/'))
}

/// Decodes `%XX` escapes; invalid escapes stay as written.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| (c as char).to_digit(16);
        if b[i] == b'%'
            && i + 2 < b.len()
            && let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2]))
        {
            out.push((h * 16 + l) as u8);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prop<'a>(p: &'a Parsed, key: &str) -> Vec<(&'a str, &'a ValueType)> {
        p.properties.iter().filter(|x| x.key == key).map(|x| (x.value.as_str(), &x.value_type)).collect()
    }

    fn link(target: &str, anchor: Option<&str>, alias: Option<&str>, kind: LinkKind, line: u32) -> Link {
        Link { target: target.into(), anchor: anchor.map(Into::into), alias: alias.map(Into::into), kind, line }
    }

    #[test]
    fn frontmatter_properties() {
        let src = "---\n\
type: 회의록\n\
status: 진행중\n\
tags:\n  - 업무\n  - '#프로젝트/notevine'\n\
source: https://example.com/a\n\
created: 2026-10-28\n\
updated: 2026-10-28T09:30:00\n\
count: 3\n\
ratio: 0.5\n\
done: false\n\
담당자: 김철수\n\
empty:\n\
meta:\n  a: 1\n  b: [x, y]\n\
---\n\
본문 #업무\n";
        let p = parse(src);
        assert_eq!(p.frontmatter_error, None);
        assert_eq!(prop(&p, "type"), [("회의록", &ValueType::Text)]);
        assert_eq!(prop(&p, "status"), [("진행중", &ValueType::Text)]);
        assert_eq!(prop(&p, "tags"), [("업무", &ValueType::List), ("#프로젝트/notevine", &ValueType::List)]);
        assert_eq!(prop(&p, "source"), [("https://example.com/a", &ValueType::Url)]);
        assert_eq!(prop(&p, "created"), [("2026-10-28", &ValueType::Date)]);
        assert_eq!(prop(&p, "updated"), [("2026-10-28T09:30:00", &ValueType::Date)]);
        assert_eq!(prop(&p, "count"), [("3", &ValueType::Number)]);
        assert_eq!(prop(&p, "ratio"), [("0.5", &ValueType::Number)]);
        assert_eq!(prop(&p, "done"), [("false", &ValueType::Bool)]);
        assert_eq!(prop(&p, "담당자"), [("김철수", &ValueType::Text)]);
        assert!(prop(&p, "empty").is_empty());
        assert_eq!(prop(&p, "meta"), [(r#"{"a":1,"b":["x","y"]}"#, &ValueType::Text)]);
        assert_eq!(p.tags, ["업무", "프로젝트/notevine"]);
        assert_eq!(p.body, "본문 #업무\n");
    }

    #[test]
    fn tags_property_as_string() {
        let p = parse("---\nTag: \"a, #b c\"\n---\n");
        assert_eq!(p.tags, ["a", "b", "c"]);
        assert_eq!(prop(&p, "Tag"), [("a, #b c", &ValueType::Text)]);
    }

    #[test]
    fn broken_yaml_sets_error() {
        let p = parse("---\ntitle: [unclosed\n  - : :\n---\n본문 [[노트]]\n");
        assert!(p.frontmatter_error.is_some());
        assert!(p.properties.is_empty());
        assert_eq!(p.body, "본문 [[노트]]\n");
        assert_eq!(p.links, [link("노트", None, None, LinkKind::Wiki, 5)]);

        let p = parse("---\njust a string\n---\n");
        assert!(p.frontmatter_error.is_some());
    }

    #[test]
    fn no_frontmatter() {
        let src = "# 제목\n---\na: 1\n---\n";
        let p = parse(src);
        assert!(p.properties.is_empty());
        assert_eq!(p.frontmatter_error, None);
        assert_eq!(p.body, src);

        // Unclosed block is not frontmatter.
        let p = parse("---\na: 1\n#태그\n");
        assert!(p.properties.is_empty());
        assert_eq!(p.tags, ["태그"]);
    }

    #[test]
    fn bom_and_closing_dots() {
        let p = parse("\u{feff}--- \r\na: 1\r\n...\r\nx");
        assert_eq!(prop(&p, "a"), [("1", &ValueType::Number)]);
        assert_eq!(p.body, "x");
    }

    #[test]
    fn inline_tags() {
        let src = "# 제목\n\
## 소제목\n\
#업무개선 오늘은 #프로젝트/notevine 진행 (#괄호) #123 #a1 #업무개선\n\
이메일 a#b, 링크 https://a.com/#frag, 엔티티 &#123; \\#escaped\n\
`#코드` 와 ``#이중 `코드` `` 밖 #밖\n\
```js\n#펜스안\n```\n\
~~~\n#틸드안\n~~~\n\
#끝/ #Case #case";
        let p = parse(src);
        assert_eq!(p.tags, ["업무개선", "프로젝트/notevine", "괄호", "a1", "밖", "끝", "Case"]);
    }

    #[test]
    fn unclosed_fence_hides_rest() {
        let p = parse("#before\n```\n#inside\n[[x]]\n");
        assert_eq!(p.tags, ["before"]);
        assert!(p.links.is_empty());
    }

    #[test]
    fn wiki_links() {
        let src = "[[회의록]] [[폴더/회의록|별칭]]\n\
[[회의록#결정 사항]] [[회의록#결정|요약]] ![[첨부/그림.png]]\n\
[[]] [[ | x]] [[a\nb]] `[[코드]]` [[ 공백 ]]";
        let p = parse(src);
        assert_eq!(
            p.links,
            [
                link("회의록", None, None, LinkKind::Wiki, 1),
                link("폴더/회의록", None, Some("별칭"), LinkKind::Wiki, 1),
                link("회의록", Some("결정 사항"), None, LinkKind::Wiki, 2),
                link("회의록", Some("결정"), Some("요약"), LinkKind::Wiki, 2),
                link("첨부/그림.png", None, None, LinkKind::Embed, 2),
                link("공백", None, None, LinkKind::Wiki, 4),
            ]
        );
    }

    #[test]
    fn markdown_links() {
        let src = "[회의 기록](폴더/회의%20기록.md#결정%20사항 \"제목\")\n\
![그림](<첨부/내 그림.png>) [외부](https://a.com/x.md) [메일](mailto:a@b.c)\n\
[앵커](#here) [절대](/루트/노트.md) [빈]() [![작은](img/a.png)](노트.md)\n\
`[코드](x.md)` [괄호](a(1).md)";
        let p = parse(src);
        assert_eq!(
            p.links,
            [
                link("폴더/회의 기록.md", Some("결정 사항"), Some("회의 기록"), LinkKind::Markdown, 1),
                link("첨부/내 그림.png", None, Some("그림"), LinkKind::Embed, 2),
                link("루트/노트.md", None, Some("절대"), LinkKind::Markdown, 3),
                link("노트.md", None, Some("![작은](img/a.png)"), LinkKind::Markdown, 3),
                link("img/a.png", None, Some("작은"), LinkKind::Embed, 3),
                link("a(1).md", None, Some("괄호"), LinkKind::Markdown, 4),
            ]
        );
    }

    #[test]
    fn crlf_and_line_numbers() {
        let src =
            "---\r\ntags: [x]\r\n---\r\n\r\n첫 줄 [[A]]\r\n#태그 [b](b.md)\r\n```\r\n[[숨김]]\r\n```\r\n![[C]]\r\n";
        let p = parse(src);
        assert_eq!(p.tags, ["x", "태그"]);
        assert_eq!(
            p.links,
            [
                link("A", None, None, LinkKind::Wiki, 5),
                link("b.md", None, Some("b"), LinkKind::Markdown, 6),
                link("C", None, None, LinkKind::Embed, 10),
            ]
        );
    }

    #[test]
    fn nfc_normalization() {
        let nfd: String = "[[한글]] #태그".nfd().collect();
        let p = parse(&nfd);
        assert_eq!(p.links[0].target, "한글");
        assert_eq!(p.tags, ["태그"]);
    }

    #[test]
    fn never_panics() {
        let nasty = [
            "",
            "---",
            "---\n",
            "---\r\n---",
            "\u{feff}",
            "[[",
            "]]",
            "[[[[]]]]",
            "![[",
            "![](",
            "[a](<b",
            "[a](b",
            "[[x|",
            "#",
            "##",
            "# ",
            "`",
            "```",
            "``` ```",
            "~~~~\n~~~",
            "%",
            "[a](%)",
            "[a](%E",
            "[a](%E2%82)",
            "[한](글%ZZ)",
            "---\n: : :\n---\n",
            "---\n- a\n- b\n---\n",
            "---\n[a: {b\n---\n",
            "\r\r\n\n\r",
            "#한#글 [[한|]] [[#]] [[|]] ![[ ]]",
            "[](#) [x](//host/a) [y](C:/a.md)",
        ];
        for s in nasty {
            let _ = parse(s);
        }
        assert!(parse("---\n- a\n---\n").frontmatter_error.is_some());
        assert_eq!(parse("[a](%E2%82%AC.md)").links[0].target, "€.md");
    }

    #[test]
    fn colors_in_html_are_not_tags() {
        let p = parse(
            "<span style=\"color: #1c7ed6\">2026. 11. 30</span> #진짜 <mark style='background:#fff3bf'>x</mark> a < #b <!-- #주석 -->",
        );
        assert_eq!(p.tags, ["진짜", "b"]);
    }
}
