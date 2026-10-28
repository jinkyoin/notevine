//! Rewrites links when a note, file or folder is renamed or moved (FR-LNK-05).
//! Links are recognized with the same rules as `parse`; only the target part of
//! a changed link is replaced, every other byte of the note stays as it was.
//! Pure and panic-free on any input.

use unicode_normalization::UnicodeNormalization;

use crate::index::link_key;
use crate::paths::{file_name, is_note, name_key, normalize_rel, parent_rel};

/// One rename/move: vault-relative paths with `/` separators, NFC. For a note both end in `.md`;
/// for a folder they are folder paths, and every note under `from/` is considered moved to `to/`.
pub struct Move<'a> {
    pub from: &'a str,
    pub to: &'a str,
}

/// Rewrites links inside `content` (the text of the note at vault path `src`) that point at
/// anything moved by `mv`. `name_unique` = true when the moved note's old file name (without .md)
/// was unique in the vault, so bare `[[name]]` links resolved to it.
/// Returns the new text and how many links were changed. Text outside changed link targets
/// must be byte-for-byte identical (including CRLF, frontmatter, code blocks).
pub fn rewrite_links(content: &str, src: &str, mv: &Move, name_unique: bool) -> (String, usize) {
    let src = normalize_rel(src);
    let dir = parent_rel(&src);
    rewrite(content, &mut |hit| match *hit {
        Hit::Wiki { target } => new_wiki_target(target, mv, name_unique),
        Hit::Markdown { path, angle } => {
            let decoded = percent_decode(path);
            let new_vault = moved(&resolve(dir, &decoded)?, mv)?;
            let new = if path.starts_with('/') {
                format!("/{new_vault}")
            } else {
                relative(dir, &new_vault, &decoded)
            };
            encode_dest(path, &decoded, &new, angle)
        }
    })
}

/// Re-bases relative markdown links in a note that itself moved from `old_src` to `new_src`
/// so they still point at the same files (targets that themselves moved are handled by also
/// passing them through `mv`). Wiki links are untouched (they are vault-relative by name/path).
pub fn rebase_own_links(content: &str, old_src: &str, new_src: &str, mv: &Move) -> (String, usize) {
    let old_src = normalize_rel(old_src);
    let new_src = normalize_rel(new_src);
    let (old_dir, new_dir) = (parent_rel(&old_src), parent_rel(&new_src));
    rewrite(content, &mut |hit| match *hit {
        Hit::Wiki { .. } => None,
        Hit::Markdown { path, angle } => {
            let decoded = percent_decode(path);
            let resolved = resolve(old_dir, &decoded)?;
            let new = if path.starts_with('/') {
                format!("/{}", moved(&resolved, mv)?)
            } else {
                let target = moved(&resolved, mv).unwrap_or(resolved);
                relative(new_dir, &target, &decoded)
            };
            encode_dest(path, &decoded, &new, angle)
        }
    })
}

// ---------- resolution ----------

/// New wiki target text for `target` (trimmed, as written), or `None` if unchanged.
fn new_wiki_target(target: &str, mv: &Move, name_unique: bool) -> Option<String> {
    let t = normalize_rel(target);
    if t.is_empty() {
        return None;
    }
    let new = if t.contains('/') {
        let p = moved(&t, mv)?;
        if target.starts_with('/') { format!("/{p}") } else { p }
    } else {
        let from = normalize_rel(mv.from);
        let to = normalize_rel(mv.to);
        let (old_name, new_name) = (file_name(&from), file_name(&to));
        if !name_unique || !is_note(&from) || old_name == new_name || link_key(&t) != link_key(old_name) {
            return None;
        }
        let stem = strip_md(new_name);
        if is_note(&t) { format!("{stem}{}", &t[t.len() - 3..]) } else { stem.to_string() }
    };
    (new != target).then_some(new)
}

/// Where `path` (normalized vault path) lives after `mv`, or `None` if it did not move.
/// Keeps the `.md`-less style of a note path written without its extension.
fn moved(path: &str, mv: &Move) -> Option<String> {
    let from = normalize_rel(mv.from);
    let to = normalize_rel(mv.to);
    let fs: Vec<&str> = from.split('/').filter(|s| !s.is_empty()).collect();
    let ps: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let n = fs.len();
    if n == 0 || ps.len() < n || !fs[..n - 1].iter().zip(&ps).all(|(a, b)| name_key(a) == name_key(b)) {
        return None;
    }
    let (last_from, last) = (fs[n - 1], ps[n - 1]);
    if ps.len() == n {
        let from_note = is_note(&from);
        let same = if from_note { link_key(last) == link_key(last_from) } else { name_key(last) == name_key(last_from) };
        if !same {
            return None;
        }
        let new = if from_note && !is_note(last) { strip_md(&to).to_string() } else { to };
        return (!new.is_empty()).then_some(new);
    }
    if name_key(last) != name_key(last_from) {
        return None;
    }
    let rest = ps[n..].join("/");
    Some(if to.is_empty() { rest } else { format!("{to}/{rest}") })
}

fn strip_md(name: &str) -> &str {
    if is_note(name) { &name[..name.len() - 3] } else { name }
}

/// Resolves a decoded markdown path against the vault directory `dir`. A leading
/// `/` means the vault root. `None` if `..` climbs out of the vault.
fn resolve(dir: &str, path: &str) -> Option<String> {
    let path = path.replace('\\', "/");
    let mut out: Vec<String> = Vec::new();
    if !path.starts_with('/') {
        out.extend(dir.split('/').filter(|s| !s.is_empty()).map(str::to_string));
    }
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop()?;
            }
            s => out.push(s.nfc().collect()),
        }
    }
    (!out.is_empty()).then(|| out.join("/"))
}

/// `target` (vault path) expressed relative to the vault directory `dir`; keeps a
/// leading `./` if the original link had one.
fn relative(dir: &str, target: &str, original: &str) -> String {
    let d: Vec<&str> = dir.split('/').filter(|s| !s.is_empty()).collect();
    let t: Vec<&str> = target.split('/').filter(|s| !s.is_empty()).collect();
    let common = d.iter().zip(&t).take_while(|(a, b)| name_key(a) == name_key(b)).count();
    let parts: Vec<&str> = std::iter::repeat_n("..", d.len() - common).chain(t[common..].iter().copied()).collect();
    let rel = if parts.is_empty() { ".".to_string() } else { parts.join("/") };
    if original.starts_with("./") && !rel.starts_with("..") && rel != "." { format!("./{rel}") } else { rel }
}

/// Final text for a markdown dest path, following the original's encoding style;
/// `None` if the target did not change.
fn encode_dest(raw: &str, decoded: &str, new: &str, angle: bool) -> Option<String> {
    if new == decoded {
        return None;
    }
    let unbalanced = new.matches('(').count() != new.matches(')').count();
    let encode = has_escape(raw) || (!angle && (new.contains(char::is_whitespace) || unbalanced));
    Some(if encode { percent_encode(new) } else { new.to_string() })
}

/// Encodes only what would break a markdown dest: `%`, whitespace and parentheses.
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '%' => out.push_str("%25"),
            ' ' => out.push_str("%20"),
            '(' => out.push_str("%28"),
            ')' => out.push_str("%29"),
            '\t' => out.push_str("%09"),
            c => out.push(c),
        }
    }
    out
}

fn hex(c: u8) -> Option<u32> {
    (c as char).to_digit(16)
}

fn has_escape(s: &str) -> bool {
    s.as_bytes().windows(3).any(|w| w[0] == b'%' && hex(w[1]).is_some() && hex(w[2]).is_some())
}

/// Decodes `%XX` escapes; invalid escapes stay as written (same as `parse`).
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
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

// ---------- scanning (mirrors `parse`) ----------

/// A link target found in the text. Slices are exactly the bytes that get replaced.
enum Hit<'a> {
    /// Wiki or embed target, trimmed, without `#anchor` / `|alias`.
    Wiki { target: &'a str },
    /// Local markdown dest without `#anchor`, still percent-encoded.
    Markdown { path: &'a str, angle: bool },
}

type Visit<'f> = dyn FnMut(&Hit) -> Option<String> + 'f;

/// Runs `visit` on every link target and splices in the replacements it returns.
fn rewrite(content: &str, visit: &mut Visit<'_>) -> (String, usize) {
    let start = body_start(content);
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    let mut offset = start;
    for raw in content[start..].split('\n') {
        let line_start = offset;
        offset += raw.len() + 1;
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
        let mut ctx = Line { text: line, base: line_start, code: code_spans(line), edits: &mut edits, visit: &mut *visit };
        ctx.scan(0, line.len());
    }
    edits.sort_by_key(|e| e.0);
    let mut out = String::with_capacity(content.len());
    let mut pos = 0;
    let mut count = 0;
    for (s, e, new) in edits {
        if s < pos {
            continue;
        }
        out.push_str(&content[pos..s]);
        out.push_str(&new);
        pos = e;
        count += 1;
    }
    out.push_str(&content[pos..]);
    (out, count)
}

/// Byte offset where the body starts (after a BOM and a frontmatter block).
fn body_start(content: &str) -> usize {
    let bom = if content.starts_with('\u{feff}') { '\u{feff}'.len_utf8() } else { 0 };
    let mut lines = content[bom..].split_inclusive('\n');
    let Some(first) = lines.next() else { return bom };
    if trim_eol(first) != "---" {
        return bom;
    }
    let mut pos = bom + first.len();
    for line in lines {
        pos += line.len();
        let t = trim_eol(line);
        if t == "---" || t == "..." {
            return pos;
        }
    }
    bom
}

fn trim_eol(line: &str) -> &str {
    line.trim_end_matches(['\n', '\r', ' ', '\t'])
}

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

struct Line<'a, 'v> {
    text: &'a str,
    /// Offset of the line in the full content.
    base: usize,
    code: Vec<(usize, usize)>,
    edits: &'a mut Vec<(usize, usize, String)>,
    visit: &'a mut Visit<'v>,
}

impl Line<'_, '_> {
    fn overlaps_code(&self, a: usize, b: usize) -> bool {
        self.code.iter().any(|&(s, e)| s < b && e > a)
    }

    fn hit(&mut self, at: usize, hit: Hit) {
        let len = match hit {
            Hit::Wiki { target } => target.len(),
            Hit::Markdown { path, .. } => path.len(),
        };
        if let Some(new) = (self.visit)(&hit) {
            self.edits.push((self.base + at, self.base + at + len, new));
        }
    }

    fn scan(&mut self, start: usize, end: usize) {
        let mut i = start;
        while i < end {
            if let Some(&(_, e)) = self.code.iter().find(|&&(s, e)| s <= i && i < e) {
                i = e;
                continue;
            }
            let rest = &self.text[i..end];
            let next = if rest.starts_with("![[") || rest.starts_with("[[") {
                self.wiki(i, end)
            } else if rest.starts_with("![") || rest.starts_with('[') {
                self.markdown(i, end)
            } else {
                None
            };
            i = next.unwrap_or_else(|| i + rest.chars().next().map_or(1, char::len_utf8));
        }
    }

    fn wiki(&mut self, i: usize, end: usize) -> Option<usize> {
        let text = self.text;
        let inner_start = i + if text[i..].starts_with('!') { 3 } else { 2 };
        let close = inner_start + text[inner_start..end].find("]]")?;
        let inner = &text[inner_start..close];
        if inner.contains("[[") || self.overlaps_code(i, close + 2) {
            return None;
        }
        let left = inner.split('|').next().unwrap_or("");
        let target = left.split('#').next().unwrap_or("");
        let lead = target.len() - target.trim_start().len();
        let target = target.trim();
        if !target.is_empty() {
            self.hit(inner_start + lead, Hit::Wiki { target });
        }
        Some(close + 2)
    }

    fn markdown(&mut self, i: usize, end: usize) -> Option<usize> {
        let text = self.text;
        let b = text.as_bytes();
        let text_start = i + if b[i] == b'!' { 2 } else { 1 };
        let text_end = matching(b, text_start, end, b'[', b']')?;
        if b.get(text_end + 1) != Some(&b'(') {
            return None;
        }
        let dest_start = text_end + 2;
        let dest_end = matching(b, dest_start, end, b'(', b')')?;
        if self.overlaps_code(i, dest_end + 1) {
            return None;
        }
        let raw = &text[dest_start..dest_end];
        let raw_at = dest_start + (raw.len() - raw.trim_start().len());
        let raw = raw.trim();
        let (dest, at, angle) = match raw.strip_prefix('<') {
            Some(r) => (r.split_once('>').map_or(r, |(d, _)| d), raw_at + 1, true),
            None => (raw.split_whitespace().next().unwrap_or(""), raw_at, false),
        };
        if is_local(dest) {
            let path = dest.split('#').next().unwrap_or("");
            if !path.trim_start_matches('/').is_empty() {
                self.hit(at, Hit::Markdown { path, angle });
            }
        }
        self.scan(text_start, text_end);
        Some(dest_end + 1)
    }
}

/// Closing bracket matching an already-consumed opener, within `b[from..end]`.
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

/// False for empty, same-note anchors, `//host` and `scheme:` destinations.
fn is_local(dest: &str) -> bool {
    if dest.is_empty() || dest.starts_with('#') || dest.starts_with("//") {
        return false;
    }
    let scheme = dest.find(':').is_some_and(|n| {
        n > 0
            && dest[..n].starts_with(|c: char| c.is_ascii_alphabetic())
            && dest[..n].chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    });
    !scheme
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mv<'a>(from: &'a str, to: &'a str) -> Move<'a> {
        Move { from, to }
    }

    #[test]
    fn renames_bare_wiki_links() {
        let src = "[[회의록]], [[회의록|어제]]\n[[회의록#결정]] ![[회의록]] [[회의록.md]] [[다른노트]]\n";
        let m = mv("업무/회의록.md", "업무/회의록 1027.md");
        let (out, n) = rewrite_links(src, "일지/a.md", &m, true);
        assert_eq!(
            out,
            "[[회의록 1027]], [[회의록 1027|어제]]\n[[회의록 1027#결정]] ![[회의록 1027]] [[회의록 1027.md]] [[다른노트]]\n"
        );
        assert_eq!(n, 5);

        let (out, n) = rewrite_links(src, "일지/a.md", &m, false);
        assert_eq!((out.as_str(), n), (src, 0));
    }

    #[test]
    fn four_link_forms_counted() {
        let src = "[[회의록]] [[회의록|어제]] [[회의록#결정]] ![[회의록]]";
        let (out, n) = rewrite_links(src, "a.md", &mv("회의록.md", "회의록 1027.md"), true);
        assert_eq!(out, "[[회의록 1027]] [[회의록 1027|어제]] [[회의록 1027#결정]] ![[회의록 1027]]");
        assert_eq!(n, 4);
    }

    #[test]
    fn matches_ignoring_case_and_normalization() {
        let nfd: String = "[[회의록]] [[ 회의록 |x]]".nfd().collect();
        let (out, n) = rewrite_links(&nfd, "a.md", &mv("회의록.md", "결정.md"), true);
        assert_eq!((out.as_str(), n), ("[[결정]] [[ 결정 |x]]", 2));

        let (out, n) = rewrite_links("[[Note]] [[NOTE.MD]]", "a.md", &mv("dir/note.md", "dir/new.md"), true);
        assert_eq!((out.as_str(), n), ("[[new]] [[new.MD]]", 2));
    }

    #[test]
    fn folder_only_move_keeps_bare_links() {
        let src = "[[자료A]] [[30 조사자료/자료A]]";
        let (out, n) = rewrite_links(src, "a.md", &mv("30 조사자료/자료A.md", "40 보관/자료A.md"), true);
        assert_eq!((out.as_str(), n), ("[[자료A]] [[40 보관/자료A]]", 1));
    }

    #[test]
    fn path_qualified_wiki_links() {
        let src = "[[30 조사자료/자료A]] [[30 조사자료/자료A.md#요약|요]] [[30 조사자료/자료B]]";
        let (out, n) = rewrite_links(src, "a.md", &mv("30 조사자료/자료A.md", "40 보관/자료A.md"), false);
        assert_eq!(out, "[[40 보관/자료A]] [[40 보관/자료A.md#요약|요]] [[30 조사자료/자료B]]");
        assert_eq!(n, 2);
    }

    #[test]
    fn folder_move() {
        let src = "[[30 조사자료/자료A]] ![[30 조사자료/그림.png]] ![[그림.png]]\n\
[a](30%20조사자료/자료A.md) [b](<30 조사자료/하위/자료B.md#x>) [c](30%20조사자료.md)\n\
[[30 조사자료.md]] [[30 조사자료x/y]]";
        let m = mv("30 조사자료", "40 보관/조사");
        let (out, n) = rewrite_links(src, "일지.md", &m, true);
        assert_eq!(
            out,
            "[[40 보관/조사/자료A]] ![[40 보관/조사/그림.png]] ![[그림.png]]\n\
[a](40%20보관/조사/자료A.md) [b](<40 보관/조사/하위/자료B.md#x>) [c](30%20조사자료.md)\n\
[[30 조사자료.md]] [[30 조사자료x/y]]"
        );
        assert_eq!(n, 4);
    }

    #[test]
    fn markdown_relative_links() {
        let src = "[자료](../30%20조사자료/자료A.md#요약 \"제목\") ![a](<../30 조사자료/자료A.md>)\n\
[절대](/30%20조사자료/자료A.md) [같음](./자료A.md) [밖](../../x.md) [외부](https://a.com/자료A.md)";
        let m = mv("30 조사자료/자료A.md", "자료A.md");
        let (out, n) = rewrite_links(src, "일지/a.md", &m, true);
        assert_eq!(
            out,
            "[자료](../자료A.md#요약 \"제목\") ![a](<../자료A.md>)\n\
[절대](/자료A.md) [같음](./자료A.md) [밖](../../x.md) [외부](https://a.com/자료A.md)"
        );
        assert_eq!(n, 3);
    }

    #[test]
    fn markdown_encoding_styles() {
        let m = mv("a.md", "새 폴더/b (1).md");
        let (out, _) = rewrite_links("[x](a.md) [y](<a.md>) [z](a)", "c.md", &m, true);
        assert_eq!(out, "[x](새%20폴더/b%20%281%29.md) [y](<새 폴더/b (1).md>) [z](새%20폴더/b%20%281%29)");

        let (out, _) = rewrite_links("[x](a.md)", "sub/c.md", &mv("sub/a.md", "b.md"), true);
        assert_eq!(out, "[x](../b.md)");
    }

    #[test]
    fn code_is_never_rewritten() {
        let src = "```\n[[회의록]]\n```\n`[[회의록]]` `[x](회의록.md)`\n~~~\n[x](회의록.md)\n~~~\n[[회의록]]";
        let (out, n) = rewrite_links(src, "a.md", &mv("회의록.md", "새.md"), true);
        assert_eq!(out, "```\n[[회의록]]\n```\n`[[회의록]]` `[x](회의록.md)`\n~~~\n[x](회의록.md)\n~~~\n[[새]]");
        assert_eq!(n, 1);
    }

    #[test]
    fn crlf_and_frontmatter_preserved() {
        let src = "\u{feff}---\r\nrel: \"[[회의록]]\"\r\n---\r\n\r\n본문 [[회의록]]\r\n[x](회의록.md)\r\n";
        let (out, n) = rewrite_links(src, "a.md", &mv("회의록.md", "새 이름.md"), true);
        assert_eq!(out, "\u{feff}---\r\nrel: \"[[회의록]]\"\r\n---\r\n\r\n본문 [[새 이름]]\r\n[x](새%20이름.md)\r\n");
        assert_eq!(n, 2);
    }

    #[test]
    fn nested_image_in_link() {
        let src = "[![작은](img/a.png)](img/a.png)";
        let (out, n) = rewrite_links(src, "a.md", &mv("img", "그림"), true);
        assert_eq!((out.as_str(), n), ("[![작은](그림/a.png)](그림/a.png)", 2));
    }

    #[test]
    fn rebase_moved_note() {
        let src = "[y](../b/y.md) [[b/y]] [s](s.md) [abs](/b/y.md) [w](https://x.y/z.md)";
        let m = mv("a/x.md", "a/sub/x.md");
        let (out, n) = rebase_own_links(src, "a/x.md", "a/sub/x.md", &m);
        assert_eq!(out, "[y](../../b/y.md) [[b/y]] [s](../s.md) [abs](/b/y.md) [w](https://x.y/z.md)");
        assert_eq!(n, 2);
    }

    #[test]
    fn rebase_with_folder() {
        let src = "[s](./s.md) [t](s.md) [o](../other.md) [self](x.md) [abs](/a/s.md)";
        let m = mv("a", "c");
        let (out, n) = rebase_own_links(src, "a/x.md", "c/x.md", &m);
        assert_eq!(out, "[s](./s.md) [t](s.md) [o](../other.md) [self](x.md) [abs](/c/s.md)");
        assert_eq!(n, 1);
    }

    #[test]
    fn rebase_keeps_encoding_style() {
        let src = "[y](../b%20c/y.md) [z](<../b c/z.md>)";
        let m = mv("a/x.md", "x.md");
        let (out, n) = rebase_own_links(src, "a/x.md", "x.md", &m);
        assert_eq!((out.as_str(), n), ("[y](b%20c/y.md) [z](<b c/z.md>)", 2));
    }

    #[test]
    fn never_panics() {
        let nasty = [
            "", "---", "---\n", "\u{feff}", "[[", "]]", "[[[[]]]]", "![[", "![](", "[a](<b", "[a](b",
            "[[x|", "`", "```", "~~~~\n~~~", "%", "[a](%)", "[a](%E", "[a](%E2%82)", "[한](글%ZZ)",
            "\r\r\n\n\r", "[[한|]] [[#]] [[|]] ![[ ]] [[/]] [[../]]", "[](#) [x](//h/a) [y](C:/a.md)",
            "[x](../../../..) [y](/) [z](./) [w](<>) [v](< >)", "[[a/b/c/d]] [x](a/b/c/d)", "한글[[a",
        ];
        let moves = [mv("a", "b"), mv("a/b", ""), mv("", "x"), mv("a.md", "b.md"), mv("/", "/"), mv("a/b/c", "a")];
        for s in nasty {
            for m in &moves {
                let _ = rewrite_links(s, "a/b.md", m, true);
                let _ = rewrite_links(s, "", m, false);
                let _ = rebase_own_links(s, "a/b.md", "c.md", m);
                let _ = rebase_own_links(s, "", "", m);
            }
        }
    }
}
