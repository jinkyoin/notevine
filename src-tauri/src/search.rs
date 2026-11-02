//! Full-text search with tag/property/date filters (FR-SRC-02..05, NFR-PRF-02).
//!
//! Terms of 3+ characters go through the FTS5 trigram index (`notes_fts`); the
//! trigram tokenizer cannot match shorter strings, so 1–2 character terms
//! ("무개") fall back to `LIKE '%term%'` on title and body. Tags and the
//! modified date are filtered in SQL; property filters and the created date are
//! applied in Rust so keys/values compare case-insensitively beyond ASCII.

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use rusqlite::types::Value;
use rusqlite::{Connection, params, params_from_iter};
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

use crate::error::AppResult;
use crate::index::{Index, like_prefix};
use crate::paths::name_key;

const DEFAULT_LIMIT: u32 = 100;
/// Characters of context on each side of the first match in a snippet.
const CONTEXT: usize = 30;
/// Maximum length of the first-line preview when there are no text terms.
const PREVIEW: usize = 80;
const MAX_VALUES: usize = 50;
const ELLIPSIS: &str = "…";

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(default)]
pub struct SearchQuery {
    /// AND between terms; a phrase is one element.
    pub text: Vec<String>,
    /// Without '#'; AND; a tag also matches tags nested under it.
    pub tags: Vec<String>,
    /// AND.
    pub props: Vec<PropFilter>,
    pub date: Option<DateFilter>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PropFilter {
    pub key: String,
    pub op: PropOp,
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PropOp {
    Eq,
    Ne,
    Contains,
    Empty,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DateFilter {
    pub field: DateField,
    #[serde(default)]
    pub from: Option<i64>,
    #[serde(default)]
    pub to: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DateField {
    Created,
    Modified,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    /// All matches, ignoring `limit`.
    pub total: u32,
    pub took_ms: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    pub mtime: i64,
    pub parts: Vec<SnippetPart>,
    /// 1-based line in the full file of the first text match in the body.
    pub line: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SnippetPart {
    pub text: String,
    pub hit: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TagCount {
    pub tag: String,
    pub count: u32,
}

struct Candidate {
    id: i64,
    path: String,
    title: String,
    mtime: i64,
    ctime: i64,
    fm_lines: i64,
}

fn nfc(s: &str) -> String {
    s.nfc().collect()
}

/// `"term"` for an FTS5 phrase, quotes doubled.
fn fts_phrase(term: &str) -> String {
    format!("\"{}\"", term.replace('"', "\"\""))
}

/// `%term%` for `LIKE ... ESCAPE '\'`.
fn like_contains(term: &str) -> String {
    let mut s = String::from("%");
    for c in term.chars() {
        if matches!(c, '%' | '_' | '\\') {
            s.push('\\');
        }
        s.push(c);
    }
    s.push('%');
    s
}

/// Runs a search. Never panics; bad SQL input is impossible since every user
/// string is bound as a parameter (FTS terms as quoted phrases).
pub fn search(ix: &Index, q: &SearchQuery) -> AppResult<SearchResult> {
    let started = Instant::now();
    let conn = ix.conn();

    let terms: Vec<String> = q.text.iter().map(|t| nfc(t.trim())).filter(|t| !t.is_empty()).collect();
    let (long, short): (Vec<&String>, Vec<&String>) = terms.iter().partition(|t| t.chars().count() >= 3);

    let mut sql = String::from("SELECT n.id, n.path, n.title, n.mtime, n.ctime, n.fm_lines FROM notes n");
    let mut wh: Vec<&str> = Vec::new();
    let mut args: Vec<Value> = Vec::new();
    if !terms.is_empty() {
        sql.push_str(" JOIN notes_fts ON notes_fts.rowid = n.id");
    }
    if !long.is_empty() {
        wh.push("notes_fts MATCH ?");
        let expr = long.iter().map(|t| fts_phrase(t)).collect::<Vec<_>>().join(" AND ");
        args.push(Value::Text(expr));
    }
    for t in &short {
        wh.push("(n.title LIKE ? ESCAPE '\\' OR notes_fts.body LIKE ? ESCAPE '\\')");
        let pat = like_contains(t);
        args.push(Value::Text(pat.clone()));
        args.push(Value::Text(pat));
    }
    for tag in &q.tags {
        let key = name_key(tag.trim().trim_start_matches('#').trim_end_matches('/'));
        if key.is_empty() {
            continue;
        }
        wh.push(
            "EXISTS (SELECT 1 FROM tags t WHERE t.note_id = n.id AND (t.tag_key = ? OR t.tag_key LIKE ? ESCAPE '\\'))",
        );
        args.push(Value::Text(like_prefix(&key)));
        args.insert(args.len() - 1, Value::Text(key));
    }
    if let Some(d) = q.date.as_ref().filter(|d| d.field == DateField::Modified) {
        if let Some(from) = d.from {
            wh.push("n.mtime >= ?");
            args.push(Value::Integer(from));
        }
        if let Some(to) = d.to {
            wh.push("n.mtime <= ?");
            args.push(Value::Integer(to));
        }
    }
    if !wh.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&wh.join(" AND "));
    }
    sql.push_str(if long.is_empty() {
        " ORDER BY n.mtime DESC, n.title, n.path"
    } else {
        " ORDER BY bm25(notes_fts), n.title, n.path"
    });

    let mut cands: Vec<Candidate> = {
        let mut st = conn.prepare(&sql)?;
        let rows = st.query_map(params_from_iter(args), |r| {
            Ok(Candidate {
                id: r.get(0)?,
                path: r.get(1)?,
                title: r.get(2)?,
                mtime: r.get(3)?,
                ctime: r.get(4)?,
                fm_lines: r.get(5)?,
            })
        })?;
        rows.collect::<Result<_, _>>()?
    };

    for f in &q.props {
        apply_prop_filter(conn, f, &mut cands)?;
    }
    if let Some(d) = q.date.as_ref().filter(|d| d.field == DateField::Created) {
        let created = created_dates(conn)?;
        cands.retain(|c| {
            let t = created.get(&c.id).copied().unwrap_or(c.ctime);
            d.from.is_none_or(|f| t >= f) && d.to.is_none_or(|e| t <= e)
        });
    }

    let total = u32::try_from(cands.len()).unwrap_or(u32::MAX);
    cands.truncate(q.limit.unwrap_or(DEFAULT_LIMIT) as usize);

    let folded: Vec<Vec<char>> = terms.iter().map(|t| t.chars().map(fold).collect()).collect();
    let mut body_st = conn.prepare_cached("SELECT body FROM notes_fts WHERE rowid = ?1")?;
    let mut hits = Vec::with_capacity(cands.len());
    for c in cands {
        let body: String = body_st.query_row(params![c.id], |r| r.get(0)).unwrap_or_default();
        let (parts, line) = snippet(&body, &folded, c.fm_lines);
        hits.push(SearchHit { path: c.path, title: c.title, mtime: c.mtime, parts, line });
    }
    let took_ms = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
    Ok(SearchResult { hits, total, took_ms })
}

/// Stored property keys equal to `key` ignoring case and normalization.
fn matching_keys(conn: &Connection, key: &str) -> AppResult<Vec<String>> {
    let want = name_key(key.trim());
    let mut st = conn.prepare_cached("SELECT DISTINCT key FROM properties")?;
    let keys = st.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
    Ok(keys.into_iter().filter(|k| name_key(k) == want).collect())
}

/// `(note_id, value)` rows for a key compared case-insensitively.
fn prop_rows(conn: &Connection, key: &str) -> AppResult<Vec<(i64, String)>> {
    let mut out = Vec::new();
    let mut st = conn.prepare_cached("SELECT note_id, value FROM properties WHERE key = ?1")?;
    for k in matching_keys(conn, key)? {
        let rows = st.query_map(params![k], |r| Ok((r.get(0)?, r.get(1)?)))?;
        for row in rows {
            out.push(row?);
        }
    }
    Ok(out)
}

fn apply_prop_filter(conn: &Connection, f: &PropFilter, cands: &mut Vec<Candidate>) -> AppResult<()> {
    let rows = prop_rows(conn, &f.key)?;
    let want = name_key(f.value.as_deref().unwrap_or(""));
    let ids = |pred: &dyn Fn(&str) -> bool| -> HashSet<i64> {
        rows.iter().filter(|(_, v)| pred(v)).map(|(id, _)| *id).collect()
    };
    match f.op {
        PropOp::Eq => {
            let keep = ids(&|v| name_key(v) == want);
            cands.retain(|c| keep.contains(&c.id));
        }
        PropOp::Ne => {
            let drop = ids(&|v| name_key(v) == want);
            cands.retain(|c| !drop.contains(&c.id));
        }
        PropOp::Contains => {
            let keep = ids(&|v| name_key(v).contains(&want));
            cands.retain(|c| keep.contains(&c.id));
        }
        PropOp::Empty => {
            let drop = ids(&|v| !v.trim().is_empty());
            cands.retain(|c| !drop.contains(&c.id));
        }
    }
    Ok(())
}

/// note id → epoch ms of its `created` property, for notes where it is a date.
fn created_dates(conn: &Connection) -> AppResult<HashMap<i64, i64>> {
    let mut out = HashMap::new();
    for (id, v) in prop_rows(conn, "created")? {
        if let Some(ms) = date_ms(&v) {
            out.entry(id).or_insert(ms);
        }
    }
    Ok(out)
}

/// `YYYY-MM-DD` (optionally followed by `T`/space and a time) → UTC midnight in ms.
fn date_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    let b = s.as_bytes();
    if b.len() < 10 || !matches!(b.get(10), None | Some(b'T' | b' ')) {
        return None;
    }
    let shape = b[..10].iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() });
    if !shape {
        return None;
    }
    let y: i64 = s[..4].parse().ok()?;
    let m: i64 = s[5..7].parse().ok()?;
    let d: i64 = s[8..10].parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(days_from_civil(y, m, d) * 86_400_000)
}

/// Days since 1970-01-01 (proleptic Gregorian).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// One-to-one case fold so folded positions line up with the original chars.
fn fold(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

fn find(hay: &[char], needle: &[char], from: usize) -> Option<usize> {
    if needle.is_empty() || from > hay.len() || hay.len() - from < needle.len() {
        return None;
    }
    hay[from..].windows(needle.len()).position(|w| w == needle).map(|p| p + from)
}

fn push_part(parts: &mut Vec<SnippetPart>, text: &str, hit: bool) {
    if text.is_empty() {
        return;
    }
    match parts.last_mut() {
        Some(last) if last.hit == hit => last.text.push_str(text),
        _ => parts.push(SnippetPart { text: text.to_string(), hit }),
    }
}

/// A line as chars with tabs and other control characters turned into spaces.
fn line_chars(raw: &str) -> Vec<char> {
    raw.trim_end_matches('\r').chars().map(|c| if c.is_control() { ' ' } else { c }).collect()
}

/// First non-empty body line, at most [`PREVIEW`] chars (ending in "…" when cut).
fn first_line(body: &str) -> Vec<SnippetPart> {
    let Some(line) = body.split('\n').map(|l| l.trim()).find(|l| !l.is_empty()) else {
        return Vec::new();
    };
    let chars = line_chars(line);
    let text: String = if chars.len() > PREVIEW {
        chars[..PREVIEW - 1].iter().collect::<String>() + ELLIPSIS
    } else {
        chars.iter().collect()
    };
    vec![SnippetPart { text, hit: false }]
}

/// Context around the first match of any `terms` (already folded) in `body`,
/// and the 1-based file line of that match. Falls back to the first body line.
fn snippet(body: &str, terms: &[Vec<char>], fm_lines: i64) -> (Vec<SnippetPart>, Option<u32>) {
    if terms.is_empty() {
        return (first_line(body), None);
    }
    for (i, raw) in body.split('\n').enumerate() {
        let chars = line_chars(raw);
        let folded: Vec<char> = chars.iter().copied().map(fold).collect();
        let Some((s, e)) =
            terms.iter().filter_map(|t| find(&folded, t, 0).map(|p| (p, p + t.len()))).min_by_key(|&(p, _)| p)
        else {
            continue;
        };
        let lead = chars.iter().take_while(|c| c.is_whitespace()).count().min(s);
        let tail = chars.len() - chars.iter().rev().take_while(|c| c.is_whitespace()).count();
        let tail = tail.max(e);
        let ws = s.saturating_sub(CONTEXT).max(lead);
        let we = (e + CONTEXT).min(tail);

        let mut hit = vec![false; we - ws];
        for t in terms {
            let mut from = 0;
            while let Some(p) = find(&folded, t, from) {
                let (a, b) = (p.max(ws), (p + t.len()).min(we));
                for h in hit.iter_mut().take(b.saturating_sub(ws)).skip(a.saturating_sub(ws)) {
                    *h = true;
                }
                from = p + 1;
            }
        }

        let mut parts = Vec::new();
        if ws > lead {
            push_part(&mut parts, ELLIPSIS, false);
        }
        let mut j = ws;
        while j < we {
            let flag = hit[j - ws];
            let mut k = j;
            while k < we && hit[k - ws] == flag {
                k += 1;
            }
            push_part(&mut parts, &chars[j..k].iter().collect::<String>(), flag);
            j = k;
        }
        if we < tail {
            push_part(&mut parts, ELLIPSIS, false);
        }
        let line = u32::try_from(i as i64 + 1 + fm_lines).ok();
        return (parts, line);
    }
    (first_line(body), None)
}

/// Distinct property keys, sorted case-insensitively, spelled as stored.
pub fn property_keys(ix: &Index) -> AppResult<Vec<String>> {
    let mut st = ix.conn().prepare("SELECT DISTINCT key FROM properties ORDER BY lower(key), key")?;
    let rows = st.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Distinct values of a property (key compared case-insensitively), most
/// frequent first, then by value; at most [`MAX_VALUES`].
pub fn property_values(ix: &Index, key: &str) -> AppResult<Vec<String>> {
    let mut counts: HashMap<String, u32> = HashMap::new();
    for (_, v) in prop_rows(ix.conn(), key)? {
        if !v.trim().is_empty() {
            *counts.entry(v).or_default() += 1;
        }
    }
    let mut values: Vec<(String, u32)> = counts.into_iter().collect();
    values.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    Ok(values.into_iter().take(MAX_VALUES).map(|(v, _)| v).collect())
}

/// Every tag with the number of notes carrying it, most frequent first, then by name.
pub fn all_tags(ix: &Index) -> AppResult<Vec<TagCount>> {
    let mut st = ix
        .conn()
        .prepare("SELECT min(tag), count(DISTINCT note_id) AS c FROM tags GROUP BY tag_key ORDER BY c DESC, tag_key")?;
    let rows = st.query_map([], |r| Ok(TagCount { tag: r.get(0)?, count: r.get(1)? }))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// One note of a folder table (FR-PRP-05).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TableRow {
    pub path: String,
    pub title: String,
    /// Last modified, ms since epoch.
    pub mtime: i64,
    /// Property → value; a list's items (several rows of one key) are joined with ", ".
    pub props: HashMap<String, String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct FolderTable {
    /// Property keys, the most used first (then by name).
    pub columns: Vec<String>,
    /// Notes in the folder and its subfolders, by path.
    pub rows: Vec<TableRow>,
}

/// The notes under `folder` ("" = the whole vault) with their properties, for a
/// table with one column per property (FR-PRP-05).
pub fn folder_table(ix: &Index, folder: &str) -> AppResult<FolderTable> {
    let folder = folder.trim_matches('/');
    let (filter, arg) =
        if folder.is_empty() { ("1", String::new()) } else { ("n.path LIKE ?1 ESCAPE '\\'", like_prefix(folder)) };
    let mut st = ix.conn().prepare(&format!(
        "SELECT n.path, n.title, n.mtime, p.key, p.value FROM notes n
         LEFT JOIN properties p ON p.note_id = n.id
         WHERE {filter} ORDER BY n.path, p.rowid"
    ))?;
    let args: Vec<Value> = if folder.is_empty() { vec![] } else { vec![Value::Text(arg)] };
    let mut rows: Vec<TableRow> = Vec::new();
    let mut uses: HashMap<String, usize> = HashMap::new();
    let mut q = st.query(params_from_iter(args))?;
    while let Some(r) = q.next()? {
        let path: String = r.get(0)?;
        if rows.last().is_none_or(|row| row.path != path) {
            rows.push(TableRow { path, title: r.get(1)?, mtime: r.get(2)?, props: HashMap::new() });
        }
        let (Some(key), Some(value)) = (r.get::<_, Option<String>>(3)?, r.get::<_, Option<String>>(4)?) else {
            continue;
        };
        let row = rows.last_mut().expect("pushed above");
        match row.props.get_mut(&key) {
            Some(v) => {
                v.push_str(", ");
                v.push_str(&value);
            }
            None => {
                *uses.entry(key.clone()).or_default() += 1;
                row.props.insert(key, value);
            }
        }
    }
    let mut columns: Vec<String> = uses.keys().cloned().collect();
    columns.sort_by(|a, b| uses[b].cmp(&uses[a]).then_with(|| name_key(a).cmp(&name_key(b))).then_with(|| a.cmp(b)));
    Ok(FolderTable { columns, rows })
}

/// A note in the link graph (FR-UI-05).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GraphNode {
    pub path: String,
    pub title: String,
}

/// Notes under a folder and the links between them; edges are index pairs into
/// `nodes`, one per linked pair whichever way it points.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct LinkGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<(usize, usize)>,
}

/// The link graph of the notes under `folder` ("" = the whole vault). Links are
/// resolved like a click would (FR-LNK-06); links to notes outside the folder,
/// to missing notes and to attachments are left out.
pub fn link_graph(ix: &Index, folder: &str) -> AppResult<LinkGraph> {
    let folder = folder.trim_matches('/');
    let conn = ix.conn();
    // Every note, for resolving names: the shallowest, then shortest path wins.
    let mut by_name: HashMap<String, (usize, usize, String)> = HashMap::new();
    let mut by_path: HashMap<String, String> = HashMap::new();
    let mut nodes = Vec::new();
    let mut ids: HashMap<i64, usize> = HashMap::new();
    let mut pos: HashMap<String, usize> = HashMap::new();
    let mut st = conn.prepare("SELECT id, path, title, name_key, path_key FROM notes ORDER BY path")?;
    let mut q = st.query([])?;
    while let Some(r) = q.next()? {
        let (id, path, title, name, key): (i64, String, String, String, String) =
            (r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?);
        let rank = (path.matches('/').count(), path.len(), path.clone());
        if by_name.get(&name).is_none_or(|old| rank < *old) {
            by_name.insert(name, rank);
        }
        by_path.insert(key, path.clone());
        if folder.is_empty() || path.starts_with(&format!("{folder}/")) {
            ids.insert(id, nodes.len());
            pos.insert(path.clone(), nodes.len());
            nodes.push(GraphNode { path, title });
        }
    }
    let mut st = conn.prepare("SELECT src_id, target_key, kind FROM links")?;
    let mut q = st.query([])?;
    let mut edges = HashSet::new();
    while let Some(r) = q.next()? {
        let (src, key, kind): (i64, String, String) = (r.get(0)?, r.get(1)?, r.get(2)?);
        let Some(&a) = ids.get(&src) else { continue };
        let target = if kind == "markdown" || key.contains('/') {
            by_path.get(&key).cloned()
        } else {
            by_name.get(&key).map(|(_, _, p)| p.clone())
        };
        if let Some(&b) = target.and_then(|t| pos.get(&t)) {
            if a != b {
                edges.insert((a.min(b), a.max(b)));
            }
        }
    }
    let mut edges: Vec<_> = edges.into_iter().collect();
    edges.sort();
    Ok(LinkGraph { nodes, edges })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::APP_DIR;
    use std::fs;

    fn setup() -> (tempfile::TempDir, Index) {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(APP_DIR)).unwrap();
        let ix = Index::open(&dir.path().join(APP_DIR).join("index.db")).unwrap();
        (dir, ix)
    }

    fn text(terms: &[&str]) -> SearchQuery {
        SearchQuery { text: terms.iter().map(|s| s.to_string()).collect(), ..Default::default() }
    }

    fn paths(ix: &Index, q: &SearchQuery) -> Vec<String> {
        search(ix, q).unwrap().hits.into_iter().map(|h| h.path).collect()
    }

    fn sorted(mut v: Vec<String>) -> Vec<String> {
        v.sort();
        v
    }

    fn prop(key: &str, op: PropOp, value: Option<&str>) -> SearchQuery {
        SearchQuery {
            props: vec![PropFilter { key: key.into(), op, value: value.map(str::to_string) }],
            ..Default::default()
        }
    }

    #[test]
    fn korean_partial_match_short_and_long_terms() {
        let (_d, ix) = setup();
        ix.upsert("a.md", "오늘은 업무개선 회의를 했다", 0, 1, 0).unwrap();
        ix.upsert("b.md", "점심 메뉴", 0, 2, 0).unwrap();
        assert_eq!(paths(&ix, &text(&["무개"])), ["a.md"]);
        assert_eq!(paths(&ix, &text(&["업무개선"])), ["a.md"]);
        assert_eq!(paths(&ix, &text(&["무개선 회"])), ["a.md"]);
        assert_eq!(paths(&ix, &text(&["개"])), ["a.md"]);
        assert!(paths(&ix, &text(&["개선안"])).is_empty());
    }

    #[test]
    fn case_insensitive_for_both_paths() {
        let (_d, ix) = setup();
        ix.upsert("a.md", "Rust and Tauri", 0, 0, 0).unwrap();
        assert_eq!(paths(&ix, &text(&["TAURI"])), ["a.md"]);
        assert_eq!(paths(&ix, &text(&["rU"])), ["a.md"]);
    }

    #[test]
    fn terms_are_anded() {
        let (_d, ix) = setup();
        ix.upsert("a.md", "업무개선 회의록", 0, 1, 0).unwrap();
        ix.upsert("b.md", "업무개선 보고서", 0, 2, 0).unwrap();
        ix.upsert("c.md", "회의 일정", 0, 3, 0).unwrap();
        assert_eq!(paths(&ix, &text(&["업무개선", "회의"])), ["a.md"]);
        assert_eq!(sorted(paths(&ix, &text(&["회의"]))), ["a.md", "c.md"]);
        assert_eq!(paths(&ix, &text(&["보고서", "개선"])), ["b.md"]);
    }

    #[test]
    fn phrase_matches_exact_sequence_only() {
        let (_d, ix) = setup();
        ix.upsert("a.md", "이것은 정확한 구 입니다", 0, 1, 0).unwrap();
        ix.upsert("b.md", "구는 정확한 것", 0, 2, 0).unwrap();
        assert_eq!(paths(&ix, &text(&["정확한 구"])), ["a.md"]);
        assert_eq!(sorted(paths(&ix, &text(&["정확한", "구"]))), ["a.md", "b.md"]);
    }

    #[test]
    fn title_only_match_has_no_line() {
        let (_d, ix) = setup();
        ix.upsert("폴더/프로젝트 계획.md", "첫 줄\n둘째 줄", 0, 0, 0).unwrap();
        for term in ["프로젝트", "계획"] {
            let r = search(&ix, &text(&[term])).unwrap();
            assert_eq!(r.total, 1, "{term}");
            assert_eq!(r.hits[0].title, "프로젝트 계획");
            assert_eq!(r.hits[0].line, None);
            assert_eq!(r.hits[0].parts, [SnippetPart { text: "첫 줄".into(), hit: false }]);
        }
    }

    #[test]
    fn tag_filter_includes_nested_tags() {
        let (_d, ix) = setup();
        ix.upsert("a.md", "#프로젝트/notevine 작업", 0, 1, 0).unwrap();
        ix.upsert("b.md", "---\ntags: [프로젝트, 회의]\n---\n본문", 0, 2, 0).unwrap();
        ix.upsert("c.md", "#프로젝트팀 은 다른 태그", 0, 3, 0).unwrap();
        ix.upsert("d.md", "#회의", 0, 4, 0).unwrap();
        let q =
            |tags: &[&str]| SearchQuery { tags: tags.iter().map(|s| s.to_string()).collect(), ..Default::default() };
        assert_eq!(sorted(paths(&ix, &q(&["프로젝트"]))), ["a.md", "b.md"]);
        assert_eq!(paths(&ix, &q(&["#프로젝트/NoteVine"])), ["a.md"]);
        assert_eq!(paths(&ix, &q(&["프로젝트", "회의"])), ["b.md"]);
        let tags = all_tags(&ix).unwrap();
        assert_eq!(tags[0], TagCount { tag: "회의".into(), count: 2 });
        assert_eq!(tags.len(), 4);
    }

    #[test]
    fn property_filters() {
        let (_d, ix) = setup();
        ix.upsert("a.md", "---\nStatus: 검토\ntype: Idea\nalias: [Foo, 바]\n---\n", 0, 1, 0).unwrap();
        ix.upsert("b.md", "---\nstatus: 완료\ntype: task\n---\n", 0, 2, 0).unwrap();
        ix.upsert("c.md", "---\nstatus: \"\"\n---\n", 0, 3, 0).unwrap();
        ix.upsert("d.md", "no frontmatter", 0, 4, 0).unwrap();

        assert_eq!(paths(&ix, &prop("status", PropOp::Eq, Some("검토"))), ["a.md"]);
        assert_eq!(paths(&ix, &prop("STATUS", PropOp::Eq, Some("완료"))), ["b.md"]);
        assert_eq!(paths(&ix, &prop("type", PropOp::Eq, Some("IDEA"))), ["a.md"]);
        // list property: any item
        assert_eq!(paths(&ix, &prop("alias", PropOp::Eq, Some("foo"))), ["a.md"]);
        assert_eq!(paths(&ix, &prop("Alias", PropOp::Eq, Some("바"))), ["a.md"]);
        // ne: notes without the key pass too
        assert_eq!(sorted(paths(&ix, &prop("status", PropOp::Ne, Some("검토")))), ["b.md", "c.md", "d.md"]);
        assert_eq!(paths(&ix, &prop("type", PropOp::Contains, Some("as"))), ["b.md"]);
        assert_eq!(paths(&ix, &prop("alias", PropOp::Contains, Some("O"))), ["a.md"]);
        assert_eq!(sorted(paths(&ix, &prop("status", PropOp::Empty, None))), ["c.md", "d.md"]);
        assert_eq!(paths(&ix, &prop("없는키", PropOp::Eq, Some("x"))), Vec::<String>::new());

        assert_eq!(property_keys(&ix).unwrap(), ["alias", "Status", "status", "type"]);
        assert_eq!(property_values(&ix, "STATUS").unwrap(), ["검토", "완료"]);
        assert_eq!(property_values(&ix, "alias").unwrap(), ["Foo", "바"]);
    }

    #[test]
    fn date_filter_modified_and_created() {
        let (_d, ix) = setup();
        let day = 86_400_000;
        let d2026 = days_from_civil(2026, 10, 28) * day;
        ix.upsert("prop.md", "---\ncreated: 2026-10-28\n---\n", 5, 100, 0).unwrap();
        ix.upsert("time.md", "---\ncreated: 2026-10-01T09:30\n---\n", 5, 200, 0).unwrap();
        ix.upsert("ctime.md", "---\ncreated: 어제\n---\n", d2026 + 1000, 300, 0).unwrap();
        ix.upsert("none.md", "", 7, 400, 0).unwrap();

        let q = |field, from, to| SearchQuery { date: Some(DateFilter { field, from, to }), ..Default::default() };
        assert_eq!(paths(&ix, &q(DateField::Modified, Some(200), Some(300))), ["ctime.md", "time.md"]);
        assert_eq!(paths(&ix, &q(DateField::Modified, None, Some(100))), ["prop.md"]);
        // property date and ctime fallback
        assert_eq!(
            sorted(paths(&ix, &q(DateField::Created, Some(d2026), Some(d2026 + day - 1)))),
            ["ctime.md", "prop.md"]
        );
        assert_eq!(paths(&ix, &q(DateField::Created, Some(d2026 - 30 * day), Some(d2026 - 1))), ["time.md"]);
        assert_eq!(paths(&ix, &q(DateField::Created, None, Some(10))), ["none.md"]);
        assert_eq!(date_ms("1970-01-02"), Some(day));
        assert_eq!(date_ms("2026-13-01"), None);
        assert_eq!(date_ms("2026-10-0x"), None);
    }

    #[test]
    fn limit_does_not_change_total() {
        let (_d, ix) = setup();
        for i in 0..7 {
            ix.upsert(&format!("n{i}.md"), "공통 단어", 0, i, 0).unwrap();
        }
        let r = search(&ix, &SearchQuery { limit: Some(3), ..text(&["공통"]) }).unwrap();
        assert_eq!((r.hits.len(), r.total), (3, 7));
        let r = search(&ix, &SearchQuery { limit: Some(0), ..Default::default() }).unwrap();
        assert_eq!((r.hits.len(), r.total), (0, 7));
    }

    #[test]
    fn snippet_marks_hits_and_cuts_with_ellipsis() {
        let (_d, ix) = setup();
        let long = format!("{}업무개선{}개선 끝", "가".repeat(40), "나".repeat(10));
        ix.upsert("a.md", &format!("첫 줄\n\n{long}\n다음 줄"), 0, 0, 0).unwrap();
        let r = search(&ix, &text(&["업무개선", "개선"])).unwrap();
        let h = &r.hits[0];
        assert_eq!(h.line, Some(3));
        let expect = [
            SnippetPart { text: format!("…{}", "가".repeat(30)), hit: false },
            SnippetPart { text: "업무개선".into(), hit: true },
            SnippetPart { text: "나".repeat(10), hit: false },
            SnippetPart { text: "개선".into(), hit: true },
            SnippetPart { text: " 끝".into(), hit: false },
        ];
        assert_eq!(h.parts, expect);

        let tail = format!("업무개선{}", "다".repeat(50));
        ix.upsert("b.md", &format!("  - {tail}"), 0, 0, 0).unwrap();
        let r = search(&ix, &SearchQuery { text: vec!["무개".into()], ..Default::default() }).unwrap();
        let b = r.hits.iter().find(|h| h.path == "b.md").unwrap();
        assert_eq!(b.parts.first().unwrap().text, "- 업");
        assert_eq!(b.parts[1], SnippetPart { text: "무개".into(), hit: true });
        assert!(b.parts.last().unwrap().text.ends_with('…'));
        assert_eq!(b.line, Some(1));
    }

    #[test]
    fn line_number_counts_frontmatter() {
        let (_d, ix) = setup();
        ix.upsert("a.md", "\u{feff}---\r\ntitle: x\r\ntags: [a]\r\n---\r\n\r\n본문\r\n찾을 단어\r\n", 0, 0, 0).unwrap();
        let h = &search(&ix, &text(&["단어"])).unwrap().hits[0];
        assert_eq!(h.line, Some(7));
        assert_eq!(
            h.parts,
            [SnippetPart { text: "찾을 ".into(), hit: false }, SnippetPart { text: "단어".into(), hit: true }]
        );
        // frontmatter values are not searchable body text
        assert!(search(&ix, &text(&["title"])).unwrap().hits.is_empty());
    }

    #[test]
    fn no_terms_orders_by_mtime_and_previews_first_line() {
        let (_d, ix) = setup();
        ix.upsert("old.md", "\n\n  첫 내용  \n둘째", 0, 10, 0).unwrap();
        ix.upsert("new.md", &"긴".repeat(100), 0, 30, 0).unwrap();
        ix.upsert("mid.md", "", 0, 20, 0).unwrap();
        let r = search(&ix, &SearchQuery::default()).unwrap();
        assert_eq!(r.hits.iter().map(|h| h.path.as_str()).collect::<Vec<_>>(), ["new.md", "mid.md", "old.md"]);
        assert_eq!(r.total, 3);
        assert_eq!(r.hits[0].parts[0].text.chars().count(), 80);
        assert!(r.hits[0].parts[0].text.ends_with('…'));
        assert!(r.hits[1].parts.is_empty());
        assert_eq!(r.hits[2].parts, [SnippetPart { text: "첫 내용".into(), hit: false }]);
        assert!(r.hits.iter().all(|h| h.line.is_none()));
        // short terms also order by mtime
        ix.upsert("x.md", "내용 x", 0, 5, 0).unwrap();
        assert_eq!(paths(&ix, &text(&["내용"])), ["old.md", "x.md"]);
    }

    #[test]
    fn long_terms_order_by_rank() {
        let (_d, ix) = setup();
        ix.upsert("weak.md", &format!("업무개선 {}", "기타 ".repeat(200)), 0, 99, 0).unwrap();
        ix.upsert("strong.md", "업무개선 업무개선 업무개선", 0, 1, 0).unwrap();
        assert_eq!(paths(&ix, &text(&["업무개선"])), ["strong.md", "weak.md"]);
    }

    #[test]
    fn nasty_inputs_do_not_panic() {
        let (_d, ix) = setup();
        ix.upsert("a.md", "100% 완료_됨 \"인용\" 🎉🎉 a\\b", 0, 0, 0).unwrap();
        let nasty = [
            "",
            " ",
            "\"",
            "\"\"\"",
            "%",
            "_",
            "\\",
            "'",
            "*",
            "NEAR(",
            "a OR b",
            "AND",
            "-",
            "^",
            "🎉",
            "🎉🎉🎉",
            "\u{0}",
            "\"인용\"",
            "100%",
            "완료_",
            "a\\b",
            "(\"))",
            "col:x",
            "\u{301}",
            "İ",
        ];
        for t in nasty {
            let r = search(&ix, &text(&[t])).unwrap();
            assert!(r.total <= 1, "{t:?}");
        }
        assert_eq!(paths(&ix, &text(&["100%"])), ["a.md"]);
        assert_eq!(paths(&ix, &text(&["%"])), ["a.md"]);
        assert!(paths(&ix, &text(&["0_"])).is_empty(), "_ is literal");
        assert_eq!(paths(&ix, &text(&["\"인용\""])), ["a.md"]);
        assert_eq!(paths(&ix, &text(&["🎉"])), ["a.md"]);
        assert_eq!(paths(&ix, &text(&["a\\b"])), ["a.md"]);
        let q = SearchQuery {
            text: vec!["\"".into(), "%%".into()],
            tags: vec!["".into(), "#".into(), "%".into(), "a/".into()],
            props: vec![
                PropFilter { key: "".into(), op: PropOp::Eq, value: None },
                PropFilter { key: "%".into(), op: PropOp::Contains, value: Some("\"".into()) },
            ],
            date: Some(DateFilter { field: DateField::Created, from: Some(i64::MAX), to: Some(i64::MIN) }),
            limit: Some(u32::MAX),
        };
        assert_eq!(search(&ix, &q).unwrap().total, 0);
        let _ = property_values(&ix, "");
        assert_eq!(snippet("", &[vec!['x']], i64::MAX), (Vec::new(), None));
    }

    #[test]
    fn json_contract() {
        let q: SearchQuery = serde_json::from_str("{}").unwrap();
        assert!(q.text.is_empty() && q.date.is_none() && q.limit.is_none());
        let q: SearchQuery = serde_json::from_str(
            r#"{"text":["무개","정확한 구"],"tags":["프로젝트"],
                "props":[{"key":"status","op":"eq","value":"검토"},{"key":"x","op":"empty"}],
                "date":{"field":"created","from":0},"limit":5}"#,
        )
        .unwrap();
        assert_eq!(q.props[1].op, PropOp::Empty);
        assert_eq!(q.date.unwrap().field, DateField::Created);
        let r = SearchResult {
            hits: vec![SearchHit {
                path: "a.md".into(),
                title: "a".into(),
                mtime: 1,
                parts: vec![SnippetPart { text: "x".into(), hit: true }],
                line: None,
            }],
            total: 1,
            took_ms: 0,
        };
        assert_eq!(
            serde_json::to_string(&r).unwrap(),
            r#"{"hits":[{"path":"a.md","title":"a","mtime":1,"parts":[{"text":"x","hit":true}],"line":null}],"total":1,"took_ms":0}"#
        );
    }

    /// `cargo test --release -- --ignored --nocapture perf`
    #[test]
    #[ignore]
    fn perf_10k_notes() {
        let (_d, ix) = setup();
        let words = [
            "업무개선",
            "회의록",
            "프로젝트",
            "일정",
            "검토",
            "보고서",
            "자동화",
            "노트",
            "정리",
            "아이디어",
            "고객",
            "요구사항",
        ];
        let mut seed: u64 = 42;
        let mut next = || {
            seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            (seed >> 33) as usize
        };
        for i in 0..10_000 {
            let mut body = String::from("---\ntags: [업무]\nstatus: 진행\n---\n");
            let target = 1000 + next() % 2000;
            while body.len() < target {
                body.push_str(words[next() % words.len()]);
                body.push(if next() % 8 == 0 { '\n' } else { ' ' });
            }
            ix.upsert(&format!("폴더{}/노트{i}.md", i % 50), &body, 0, i, body.len() as i64).unwrap();
        }
        for term in ["무개", "업무개선", "개선 회의"] {
            let t = Instant::now();
            let r = search(&ix, &text(&[term])).unwrap();
            let ms = t.elapsed().as_millis();
            println!("search {term:?}: {ms} ms, total {}, took_ms {}", r.total, r.took_ms);
            assert!(ms < 200, "{term}: {ms} ms");
        }
    }

    #[test]
    fn folder_table_lists_notes_with_their_properties() {
        let (_dir, ix) = setup();
        ix.upsert("p/a.md", "---\nstatus: 진행\ndeadline: 2026-11-30\ntags: [웹, 개편]\n---\n# A\n", 0, 5, 0).unwrap();
        ix.upsert("p/sub/b.md", "---\nstatus: 완료\n---\n", 0, 6, 0).unwrap();
        ix.upsert("p/c.md", "속성 없음", 0, 7, 0).unwrap();
        ix.upsert("p%x/d.md", "---\nstatus: 밖\n---\n", 0, 8, 0).unwrap();
        ix.upsert("q.md", "---\nowner: 나\n---\n", 0, 9, 0).unwrap();

        let t = folder_table(&ix, "p").unwrap();
        let paths: Vec<_> = t.rows.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(paths, ["p/a.md", "p/c.md", "p/sub/b.md"]);
        assert_eq!(t.columns, ["status", "deadline", "tags"]);
        assert_eq!(t.rows[0].props["status"], "진행");
        assert_eq!(t.rows[0].props["tags"], "웹, 개편");
        assert!(t.rows[1].props.is_empty());
        assert_eq!((t.rows[2].mtime, t.rows[2].title.as_str()), (6, "b"));

        let all = folder_table(&ix, "").unwrap();
        assert_eq!(all.rows.len(), 5);
        assert_eq!(all.columns[0], "status");
    }
    #[test]
    fn link_graph_resolves_links_inside_the_folder() {
        let (_dir, ix) = setup();
        ix.upsert("p/a.md", "[[b]] [[c]] [[b]] [[없음]] [[밖]] ![[그림.png]]", 0, 1, 0).unwrap();
        ix.upsert("p/sub/b.md", "[[a]] [링크](../c.md)", 0, 1, 0).unwrap();
        ix.upsert("p/c.md", "[[p/a]]", 0, 1, 0).unwrap();
        ix.upsert("밖.md", "[[a]]", 0, 1, 0).unwrap();

        let g = link_graph(&ix, "p").unwrap();
        let names: Vec<_> = g.nodes.iter().map(|n| n.path.as_str()).collect();
        assert_eq!(names, ["p/a.md", "p/c.md", "p/sub/b.md"]);
        assert_eq!(g.edges, [(0, 1), (0, 2), (1, 2)]);

        let all = link_graph(&ix, "").unwrap();
        assert_eq!(all.nodes.len(), 4);
        assert_eq!(all.edges.len(), 4);
    }
}
