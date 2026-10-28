//! Search/link index in `.app/index.db` (DR-02). It is a cache: deleting it or
//! finding it corrupt just means it is rebuilt from the .md files (NFR-REL-03).

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::{Duration, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;

use crate::error::AppResult;
use crate::parse::{self, LinkKind, ValueType};
use crate::paths::{is_hidden, is_note, name_key, parent_rel, resolve_rel, to_rel, APP_DIR};

/// Bump when the schema or what `parse` extracts changes: an index built by an
/// older version is thrown away and rebuilt from the files.
const SCHEMA_VERSION: i64 = 4;

const SCHEMA: &str = "
CREATE TABLE notes (
  id       INTEGER PRIMARY KEY,
  path     TEXT NOT NULL UNIQUE,
  name_key TEXT NOT NULL,           -- lowercase NFC file name without .md, for link resolution
  path_key TEXT NOT NULL,           -- lowercase NFC vault path without .md
  title    TEXT NOT NULL,
  ctime    INTEGER NOT NULL,
  mtime    INTEGER NOT NULL,
  size     INTEGER NOT NULL,
  fm_error TEXT,
  fm_lines INTEGER NOT NULL DEFAULT 0  -- lines before the body (frontmatter incl. delimiters)
);
CREATE INDEX notes_name_key ON notes(name_key);
CREATE INDEX notes_path_key ON notes(path_key);
CREATE TABLE links (
  src_id     INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  target     TEXT NOT NULL,
  target_key TEXT NOT NULL,         -- lowercase NFC target without .md; markdown links resolved to a vault path
  anchor     TEXT,
  alias      TEXT,
  kind       TEXT NOT NULL,
  line       INTEGER NOT NULL
);
CREATE INDEX links_src ON links(src_id);
CREATE INDEX links_target_key ON links(target_key);
CREATE TABLE tags (
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  tag_key TEXT NOT NULL
);
CREATE INDEX tags_key ON tags(tag_key);
CREATE INDEX tags_note ON tags(note_id);
CREATE TABLE properties (
  note_id    INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  value_type TEXT NOT NULL
);
CREATE INDEX properties_kv ON properties(key, value);
CREATE INDEX properties_note ON properties(note_id);
CREATE VIRTUAL TABLE notes_fts USING fts5(title, body, tokenize = 'trigram');
";

pub struct Index {
    conn: Connection,
}

#[derive(Debug, Clone, Serialize)]
pub struct NoteRef {
    pub path: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LinkRef {
    /// The note containing the link.
    pub path: String,
    pub title: String,
    pub line: u32,
}

/// Key a link is stored under. Wiki/embed targets keep their own form (a name, or
/// a vault path when they contain `/`); markdown destinations are resolved
/// against the source note's folder to a vault path.
fn stored_target_key(src: &str, target: &str, kind: &LinkKind) -> String {
    match kind {
        LinkKind::Markdown => resolve_rel(parent_rel(src), target).map(|p| link_key(&p)).unwrap_or_default(),
        _ => link_key(target),
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ScanStats {
    pub indexed: usize,
    pub unchanged: usize,
    pub removed: usize,
}

/// Lowercase NFC link key: "폴더/회의록.md" → "폴더/회의록".
pub fn link_key(target: &str) -> String {
    let k = name_key(target.trim());
    k.strip_suffix(".md").map(str::to_string).unwrap_or(k)
}

fn title_of(rel: &str) -> String {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    if is_note(name) { name[..name.len() - 3].to_string() } else { name.to_string() }
}

fn kind_str(k: &LinkKind) -> &'static str {
    match k {
        LinkKind::Wiki => "wiki",
        LinkKind::Embed => "embed",
        LinkKind::Markdown => "markdown",
    }
}

fn value_type_str(v: &ValueType) -> &'static str {
    match v {
        ValueType::Text => "text",
        ValueType::Number => "number",
        ValueType::Bool => "bool",
        ValueType::Date => "date",
        ValueType::Url => "url",
        ValueType::List => "list",
    }
}

fn ms(t: std::io::Result<std::time::SystemTime>) -> i64 {
    t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Escapes `%`, `_` and `\` for `LIKE ... ESCAPE '\'`.
pub(crate) fn like_prefix(dir: &str) -> String {
    let mut s = String::new();
    for c in dir.chars() {
        if matches!(c, '%' | '_' | '\\') {
            s.push('\\');
        }
        s.push(c);
    }
    s.push_str("/%");
    s
}

impl Index {
    /// Opens the index, rebuilding the file from scratch when it is missing,
    /// from an older schema, or unreadable.
    pub fn open(file: &Path) -> AppResult<Self> {
        match Self::try_open(file) {
            Ok(ix) => Ok(ix),
            Err(_) => {
                for suffix in ["", "-wal", "-shm"] {
                    let _ = fs::remove_file(format!("{}{suffix}", file.display()));
                }
                Self::try_open(file)
            }
        }
    }

    fn try_open(file: &Path) -> AppResult<Self> {
        let conn = Connection::open(file)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;")?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version != SCHEMA_VERSION {
            let tables: i64 = conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get(0))?;
            if tables > 0 {
                return Err(rusqlite::Error::InvalidQuery.into()); // stale schema → caller rebuilds
            }
            conn.execute_batch(&format!("BEGIN; {SCHEMA} PRAGMA user_version = {SCHEMA_VERSION}; COMMIT;"))?;
        }
        // Touch every table so a damaged file fails here instead of later.
        conn.query_row("SELECT (SELECT count(*) FROM notes) + (SELECT count(*) FROM notes_fts)", [], |r| {
            r.get::<_, i64>(0)
        })?;
        Ok(Self { conn })
    }

    /// Indexes one note from its text.
    pub fn upsert(&self, rel: &str, content: &str, ctime: i64, mtime: i64, size: i64) -> AppResult<()> {
        let parsed = parse::parse(content);
        let fm_lines = fm_lines(content, &parsed.body);
        let tx = self.conn.unchecked_transaction()?;
        delete_note(&tx, rel)?;
        tx.execute(
            "INSERT INTO notes (path, name_key, path_key, title, ctime, mtime, size, fm_error, fm_lines)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                rel,
                link_key(&title_of(rel)),
                link_key(rel),
                title_of(rel),
                ctime,
                mtime,
                size,
                parsed.frontmatter_error,
                fm_lines
            ],
        )?;
        let id = tx.last_insert_rowid();
        {
            let mut st = tx.prepare_cached(
                "INSERT INTO links (src_id, target, target_key, anchor, alias, kind, line) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for l in &parsed.links {
                let key = stored_target_key(rel, &l.target, &l.kind);
                st.execute(params![id, l.target, key, l.anchor, l.alias, kind_str(&l.kind), l.line])?;
            }
            let mut st = tx.prepare_cached("INSERT INTO tags (note_id, tag, tag_key) VALUES (?1, ?2, ?3)")?;
            for t in &parsed.tags {
                st.execute(params![id, t, name_key(t)])?;
            }
            let mut st =
                tx.prepare_cached("INSERT INTO properties (note_id, key, value, value_type) VALUES (?1, ?2, ?3, ?4)")?;
            for p in &parsed.properties {
                st.execute(params![id, p.key, p.value, value_type_str(&p.value_type)])?;
            }
        }
        tx.execute("INSERT INTO notes_fts (rowid, title, body) VALUES (?1, ?2, ?3)", params![id, title_of(rel), parsed.body])?;
        tx.commit()?;
        Ok(())
    }

    /// Indexes a note file from disk.
    pub fn upsert_file(&self, root: &Path, rel: &str) -> AppResult<()> {
        let abs = root.join(rel);
        let meta = fs::metadata(&abs)?;
        let content = fs::read_to_string(&abs)?;
        self.upsert(rel, &content, ms(meta.created()), ms(meta.modified()), meta.len() as i64)
    }

    /// Removes a note, or every note under a folder.
    pub fn remove(&self, rel: &str) -> AppResult<()> {
        let tx = self.conn.unchecked_transaction()?;
        delete_note(&tx, rel)?;
        let ids: Vec<i64> = {
            let mut st = tx.prepare("SELECT id FROM notes WHERE path LIKE ?1 ESCAPE '\\'")?;
            st.query_map(params![like_prefix(rel)], |r| r.get(0))?.collect::<Result<_, _>>()?
        };
        for id in ids {
            tx.execute("DELETE FROM notes_fts WHERE rowid = ?1", params![id])?;
            tx.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Re-keys a renamed/moved note or folder without re-reading files.
    pub fn rename(&self, from: &str, to: &str) -> AppResult<()> {
        let tx = self.conn.unchecked_transaction()?;
        let rows: Vec<(i64, String)> = {
            let mut st = tx.prepare("SELECT id, path FROM notes WHERE path = ?1 OR path LIKE ?2 ESCAPE '\\'")?;
            st.query_map(params![from, like_prefix(from)], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<_, _>>()?
        };
        for (id, path) in rows {
            let new_path = format!("{to}{}", &path[from.len()..]);
            let title = title_of(&new_path);
            if !is_note(&new_path) {
                // renamed away from .md: no longer a note
                tx.execute("DELETE FROM notes_fts WHERE rowid = ?1", params![id])?;
                tx.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
                continue;
            }
            delete_note(&tx, &new_path)?; // a stale row could hold the target path
            tx.execute(
                "UPDATE notes SET path = ?2, name_key = ?3, path_key = ?4, title = ?5 WHERE id = ?1",
                params![id, new_path, link_key(&title), link_key(&new_path), title],
            )?;
            tx.execute("UPDATE notes_fts SET title = ?2 WHERE rowid = ?1", params![id, title])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Brings the index in line with the .md files on disk, re-reading only files
    /// whose mtime or size changed since they were indexed.
    pub fn scan(&self, root: &Path) -> AppResult<ScanStats> {
        let mut known: HashMap<String, (i64, i64)> = {
            let mut st = self.conn.prepare("SELECT path, mtime, size FROM notes")?;
            st.query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))?.collect::<Result<_, _>>()?
        };
        let mut stats = ScanStats::default();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if is_hidden(&name) || name == APP_DIR {
                    continue;
                }
                let path = entry.path();
                let Ok(meta) = entry.metadata() else { continue };
                if meta.is_dir() {
                    stack.push(path);
                    continue;
                }
                if !is_note(&name) {
                    continue;
                }
                let Some(rel) = to_rel(root, &path) else { continue };
                let stamp = (ms(meta.modified()), meta.len() as i64);
                if known.remove(&rel) == Some(stamp) {
                    stats.unchanged += 1;
                    continue;
                }
                // Unreadable files (locked, not UTF-8) are skipped, not fatal.
                if let Ok(content) = fs::read_to_string(&path) {
                    self.upsert(&rel, &content, ms(meta.created()), stamp.0, stamp.1)?;
                    stats.indexed += 1;
                }
            }
        }
        for gone in known.keys() {
            self.remove(gone)?;
            stats.removed += 1;
        }
        Ok(stats)
    }

    #[cfg(test)]
    pub fn note_count(&self) -> AppResult<i64> {
        Ok(self.conn.query_row("SELECT count(*) FROM notes", [], |r| r.get(0))?)
    }

    /// Drops every row so the next scan re-reads all notes (settings → 인덱스 다시 만들기).
    pub fn clear(&self) -> AppResult<()> {
        self.conn.execute_batch("BEGIN; DELETE FROM notes_fts; DELETE FROM notes; COMMIT;")?;
        Ok(())
    }

    /// Every note, for quick open and `[[` completion.
    pub fn notes(&self) -> AppResult<Vec<NoteRef>> {
        let mut st = self.conn.prepare("SELECT path, title FROM notes ORDER BY title, path")?;
        let rows = st.query_map([], |r| Ok(NoteRef { path: r.get(0)?, title: r.get(1)? }))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Note a wiki target points at (FR-LNK-06): a vault path when it contains `/`,
    /// otherwise the note with that file name, shallowest folder first, then shortest path.
    pub fn resolve(&self, target: &str) -> AppResult<Option<String>> {
        let key = link_key(target);
        let sql = if key.contains('/') {
            "SELECT path FROM notes WHERE path_key = ?1 LIMIT 1"
        } else {
            "SELECT path FROM notes WHERE name_key = ?1
             ORDER BY length(path) - length(replace(path, '/', '')), length(path), path LIMIT 1"
        };
        Ok(self.conn.query_row(sql, params![key], |r| r.get(0)).optional()?)
    }

    /// Number of notes whose file name (without .md) is `name`.
    pub fn name_count(&self, name: &str) -> AppResult<i64> {
        Ok(self.conn.query_row("SELECT count(*) FROM notes WHERE name_key = ?1", params![link_key(name)], |r| r.get(0))?)
    }

    /// Links in other notes that point at `rel` (FR-LNK-03·04).
    pub fn backlinks(&self, rel: &str) -> AppResult<Vec<LinkRef>> {
        let name = link_key(&title_of(rel));
        // A bare [[name]] means this note only if it wins name resolution.
        let by_name = self.resolve(&name)?.as_deref() == Some(rel);
        let mut st = self.conn.prepare(
            "SELECT n.path, n.title, l.line FROM links l JOIN notes n ON n.id = l.src_id
             WHERE n.path != ?1
               AND (l.target_key = ?2 OR (?3 AND l.kind != 'markdown' AND l.target_key = ?4))
             ORDER BY n.title, n.path, l.line",
        )?;
        let rows = st.query_map(params![rel, link_key(rel), by_name, name], |r| {
            Ok(LinkRef { path: r.get(0)?, title: r.get(1)?, line: r.get(2)? })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Notes that may hold links to `rel` or to anything under it (a folder):
    /// the candidates to rewrite on rename/move.
    pub fn referrers(&self, rel: &str) -> AppResult<Vec<String>> {
        let key = link_key(rel);
        let name = link_key(&title_of(rel));
        let mut st = self.conn.prepare(
            "SELECT DISTINCT n.path FROM links l JOIN notes n ON n.id = l.src_id
             WHERE l.target_key = ?1 OR l.target_key LIKE ?2 ESCAPE '\\'
                OR (?3 AND l.kind != 'markdown' AND l.target_key = ?4)
             ORDER BY n.path",
        )?;
        let rows = st.query_map(params![key, like_prefix(&key), is_note(rel), name], |r| r.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Notes at `rel` or under it.
    pub fn notes_under(&self, rel: &str) -> AppResult<Vec<String>> {
        let mut st = self.conn.prepare("SELECT path FROM notes WHERE path = ?1 OR path LIKE ?2 ESCAPE '\\' ORDER BY path")?;
        let rows = st.query_map(params![rel, like_prefix(rel)], |r| r.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    #[cfg(test)]
    pub fn has(&self, rel: &str) -> AppResult<bool> {
        Ok(self.conn.query_row("SELECT 1 FROM notes WHERE path = ?1", params![rel], |_| Ok(())).optional()?.is_some())
    }

    /// The underlying connection, for read queries in other modules (search).
    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }
}

/// Number of lines before the body (frontmatter incl. delimiters): the count of
/// '\n' in the part of `content` (BOM stripped as `parse` does) that precedes `body`.
fn fm_lines(content: &str, body: &str) -> i64 {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    if !content.ends_with(body) {
        return 0;
    }
    content[..content.len() - body.len()].bytes().filter(|&b| b == b'\n').count() as i64
}

fn delete_note(tx: &Transaction, rel: &str) -> rusqlite::Result<()> {
    if let Some(id) =
        tx.query_row("SELECT id FROM notes WHERE path = ?1", params![rel], |r| r.get::<_, i64>(0)).optional()?
    {
        tx.execute("DELETE FROM notes_fts WHERE rowid = ?1", params![id])?;
        tx.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, Index) {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(APP_DIR)).unwrap();
        let ix = Index::open(&dir.path().join(APP_DIR).join("index.db")).unwrap();
        (dir, ix)
    }

    fn count(ix: &Index, sql: &str) -> i64 {
        ix.conn().query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn fts_trigram_finds_korean_substrings() {
        let (_d, ix) = setup();
        ix.upsert("a.md", "오늘은 업무개선 회의를 했다", 0, 0, 0).unwrap();
        let hits = count(&ix, "SELECT count(*) FROM notes_fts WHERE notes_fts MATCH '\"업무개\"'");
        assert_eq!(hits, 1);
    }

    #[test]
    fn stores_parsed_properties_tags_and_links() {
        let (_d, ix) = setup();
        let note = "---\ntype: idea\nstatus: 검토\ntags: [업무개선]\n---\n본문 #자동화 [[회의록|어제 회의]] [자료](폴더/자료%20A.md)\n";
        ix.upsert("a.md", note, 0, 0, 0).unwrap();
        let props: Vec<(String, String)> = {
            let mut st = ix.conn().prepare("SELECT key, value FROM properties ORDER BY key").unwrap();
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(Result::unwrap).collect()
        };
        assert!(props.contains(&("status".into(), "검토".into())));
        assert!(props.contains(&("type".into(), "idea".into())));
        let tags: Vec<String> = {
            let mut st = ix.conn().prepare("SELECT tag FROM tags ORDER BY tag").unwrap();
            st.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
        };
        assert_eq!(tags, ["업무개선", "자동화"]);
        let links: Vec<(String, String)> = {
            let mut st = ix.conn().prepare("SELECT target_key, kind FROM links ORDER BY line, kind").unwrap();
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(Result::unwrap).collect()
        };
        assert_eq!(links, [("폴더/자료 a".into(), "markdown".into()), ("회의록".into(), "wiki".into())]);
        // frontmatter is not part of the searchable body
        assert_eq!(count(&ix, "SELECT count(*) FROM notes_fts WHERE notes_fts MATCH '\"status\"'"), 0);
    }

    #[test]
    fn upsert_replaces_previous_rows() {
        let (_d, ix) = setup();
        ix.upsert("a.md", "one", 0, 0, 0).unwrap();
        ix.upsert("a.md", "two", 0, 1, 3).unwrap();
        assert_eq!(ix.note_count().unwrap(), 1);
        assert_eq!(count(&ix, "SELECT count(*) FROM notes_fts"), 1);
    }

    #[test]
    fn rename_and_remove_folder_prefix_only() {
        let (_d, ix) = setup();
        for p in ["f/a.md", "f/sub/b.md", "f_x/c.md", "fx.md"] {
            ix.upsert(p, "x", 0, 0, 0).unwrap();
        }
        ix.rename("f", "g").unwrap();
        assert!(ix.has("g/a.md").unwrap() && ix.has("g/sub/b.md").unwrap());
        assert!(ix.has("f_x/c.md").unwrap(), "LIKE wildcard must not match f_x");
        ix.remove("g").unwrap();
        assert_eq!(ix.note_count().unwrap(), 2);
        let title: String = ix.conn().query_row("SELECT title FROM notes WHERE path='fx.md'", [], |r| r.get(0)).unwrap();
        assert_eq!(title, "fx");
    }

    #[test]
    fn scan_is_incremental_and_skips_hidden() {
        let (dir, ix) = setup();
        let root = dir.path();
        fs::create_dir(root.join("일지")).unwrap();
        fs::create_dir(root.join(".git")).unwrap();
        fs::write(root.join("일지/a.md"), "a").unwrap();
        fs::write(root.join("b.md"), "b").unwrap();
        fs::write(root.join("c.png"), "").unwrap();
        fs::write(root.join(".git/x.md"), "").unwrap();
        assert_eq!(ix.scan(root).unwrap(), ScanStats { indexed: 2, unchanged: 0, removed: 0 });
        assert_eq!(ix.scan(root).unwrap(), ScanStats { indexed: 0, unchanged: 2, removed: 0 });
        fs::remove_file(root.join("b.md")).unwrap();
        fs::write(root.join("일지/a.md"), "changed").unwrap();
        assert_eq!(ix.scan(root).unwrap(), ScanStats { indexed: 1, unchanged: 0, removed: 1 });
    }

    #[test]
    fn rebuilds_a_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("index.db");
        fs::write(&file, "this is not a sqlite database at all, just garbage bytes").unwrap();
        let ix = Index::open(&file).unwrap();
        ix.upsert("a.md", "x", 0, 0, 0).unwrap();
        assert_eq!(ix.note_count().unwrap(), 1);
    }

    #[test]
    fn rebuilds_an_index_from_an_older_version() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("index.db");
        {
            let ix = Index::open(&file).unwrap();
            ix.upsert("a.md", "x", 0, 0, 0).unwrap();
            ix.conn().execute_batch("PRAGMA user_version = 1").unwrap();
        }
        let ix = Index::open(&file).unwrap();
        assert_eq!(ix.note_count().unwrap(), 0, "stale rows must be gone");
    }

    #[test]
    fn resolves_names_and_finds_backlinks() {
        let (_d, ix) = setup();
        ix.upsert("30 조사자료/회의록.md", "", 0, 0, 0).unwrap();
        ix.upsert("보관/old/회의록.md", "", 0, 0, 0).unwrap();
        ix.upsert("일지/a.md", "[[회의록]] 그리고 [자료](../30%20조사자료/회의록.md)", 0, 0, 0).unwrap();
        ix.upsert("b.md", "[[보관/old/회의록|옛 회의록]]", 0, 0, 0).unwrap();
        // shortest path wins for a bare name
        assert_eq!(ix.resolve("회의록").unwrap().as_deref(), Some("30 조사자료/회의록.md"));
        assert_eq!(ix.resolve("보관/OLD/회의록").unwrap().as_deref(), Some("보관/old/회의록.md"));
        assert_eq!(ix.resolve("없는 노트").unwrap(), None);
        let main: Vec<_> = ix.backlinks("30 조사자료/회의록.md").unwrap().into_iter().map(|b| b.path).collect();
        assert_eq!(main, ["일지/a.md", "일지/a.md"]);
        let old: Vec<_> = ix.backlinks("보관/old/회의록.md").unwrap().into_iter().map(|b| b.path).collect();
        assert_eq!(old, ["b.md"]);
        assert_eq!(ix.name_count("회의록").unwrap(), 2);
        assert_eq!(ix.referrers("보관").unwrap(), ["b.md"]);
        assert_eq!(ix.notes_under("보관").unwrap(), ["보관/old/회의록.md"]);
    }

    #[test]
    fn stores_frontmatter_line_count() {
        let (_d, ix) = setup();
        ix.upsert("a.md", "\u{feff}---\r\na: 1\r\n---\r\nbody\n", 0, 0, 0).unwrap();
        ix.upsert("b.md", "no frontmatter\n---\nx\n", 0, 0, 0).unwrap();
        let n = |p: &str| -> i64 {
            ix.conn().query_row("SELECT fm_lines FROM notes WHERE path = ?1", params![p], |r| r.get(0)).unwrap()
        };
        assert_eq!(n("a.md"), 3);
        assert_eq!(n("b.md"), 0);
    }

    #[test]
    fn link_keys_ignore_case_and_extension() {
        assert_eq!(link_key("폴더/회의록.MD"), "폴더/회의록");
        assert_eq!(link_key(" Note "), "note");
    }
}
