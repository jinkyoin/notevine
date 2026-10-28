//! Note version history in `.app/history.db` (FR-HIS-01·02, DR-03).
//!
//! Snapshot rules:
//! - identical content to the latest version is never stored again;
//! - app saves of the same note within 5 minutes of a bundle's start update that
//!   bundle instead of adding a row, so 30 minutes of typing leaves ~6 versions;
//! - a pause of a minute or more ends the bundle: coming back to edit later
//!   always keeps what was there before (usability test, 2026-10-28);
//! - a forced save (Ctrl+S, leaving the note, app exit, creating a note) always
//!   lands in a version and closes the bundle, so the next edit starts a new one.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::error::AppResult;

pub const BUNDLE_MS: i64 = 5 * 60 * 1000;
/// Saves further apart than this are separate edits, not one burst of typing.
pub const IDLE_MS: i64 = 60 * 1000;
const ZSTD_LEVEL: i32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    /// Saved from the editor.
    App,
    /// Changed by another program (recorded by the watcher, day 3).
    External,
    /// Written by a restore.
    Restore,
}

impl Origin {
    fn as_str(self) -> &'static str {
        match self {
            Origin::App => "app",
            Origin::External => "external",
            Origin::Restore => "restore",
        }
    }

    fn parse(s: &str) -> Origin {
        match s {
            "external" => Origin::External,
            "restore" => Origin::Restore,
            _ => Origin::App,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Recorded {
    Skipped,
    Created(i64),
    Updated(i64),
}

#[derive(Debug, Clone, Serialize)]
pub struct VersionMeta {
    pub id: i64,
    pub path: String,
    pub started_at: i64,
    pub saved_at: i64,
    pub size: i64,
    pub origin: Origin,
}

pub struct History {
    conn: Connection,
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

impl History {
    pub fn open(file: &Path) -> AppResult<Self> {
        let conn = Connection::open(file)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS versions (
               id           INTEGER PRIMARY KEY,
               path         TEXT    NOT NULL,
               started_at   INTEGER NOT NULL,
               saved_at     INTEGER NOT NULL,
               hash         TEXT    NOT NULL,
               size         INTEGER NOT NULL,
               content_zstd BLOB    NOT NULL,
               origin       TEXT    NOT NULL,
               sealed       INTEGER NOT NULL DEFAULT 0
             );
             CREATE INDEX IF NOT EXISTS versions_path_saved ON versions(path, saved_at);",
        )?;
        Ok(Self { conn })
    }

    pub fn record(&self, path: &str, content: &str, origin: Origin, force: bool) -> AppResult<Recorded> {
        self.record_at(path, content, origin, force, now_ms())
    }

    pub fn record_at(&self, path: &str, content: &str, origin: Origin, force: bool, now: i64) -> AppResult<Recorded> {
        let hash = blake3::hash(content.as_bytes()).to_hex().to_string();
        let last: Option<(i64, i64, String, String, bool, i64)> = self
            .conn
            .query_row(
                "SELECT id, started_at, hash, origin, sealed, saved_at FROM versions
                 WHERE path = ?1 ORDER BY saved_at DESC, id DESC LIMIT 1",
                params![path],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .optional()?;

        if let Some((id, _, last_hash, _, _, _)) = &last
            && *last_hash == hash
        {
            if force {
                self.conn.execute("UPDATE versions SET sealed = 1 WHERE id = ?1", params![id])?;
            }
            return Ok(Recorded::Skipped);
        }

        let blob = zstd::encode_all(content.as_bytes(), ZSTD_LEVEL)?;
        let size = content.len() as i64;

        let open_bundle = last.filter(|(_, started, _, last_origin, sealed, saved)| {
            origin == Origin::App
                && Origin::parse(last_origin) == Origin::App
                && !sealed
                && now.saturating_sub(*started) < BUNDLE_MS
                && now.saturating_sub(*saved) < IDLE_MS
        });

        if let Some((id, ..)) = open_bundle {
            self.conn.execute(
                "UPDATE versions SET saved_at = ?2, hash = ?3, size = ?4, content_zstd = ?5, sealed = ?6
                 WHERE id = ?1",
                params![id, now, hash, size, blob, force],
            )?;
            return Ok(Recorded::Updated(id));
        }

        self.conn.execute(
            "INSERT INTO versions (path, started_at, saved_at, hash, size, content_zstd, origin, sealed)
             VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![path, now, hash, size, blob, origin.as_str(), force],
        )?;
        Ok(Recorded::Created(self.conn.last_insert_rowid()))
    }

    /// Moves history from a note or folder path to its new path (FR-HIS-07).
    pub fn rename_path(&self, from: &str, to: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE versions SET path = ?2 || substr(path, length(?1) + 1)
             WHERE path = ?1 OR substr(path, 1, length(?1) + 1) = ?1 || '/'",
            params![from, to],
        )?;
        Ok(())
    }

    /// True when `path` has at least one version.
    pub fn has_versions(&self, path: &str) -> AppResult<bool> {
        Ok(self.conn.query_row("SELECT EXISTS(SELECT 1 FROM versions WHERE path = ?1)", params![path], |r| r.get(0))?)
    }

    /// Versions of one note, newest first.
    pub fn list(&self, path: &str) -> AppResult<Vec<VersionMeta>> {
        let mut st = self.conn.prepare(
            "SELECT id, path, started_at, saved_at, size, origin FROM versions
             WHERE path = ?1 ORDER BY saved_at DESC, id DESC",
        )?;
        let rows = st.query_map(params![path], |r| {
            Ok(VersionMeta {
                id: r.get(0)?,
                path: r.get(1)?,
                started_at: r.get(2)?,
                saved_at: r.get(3)?,
                size: r.get(4)?,
                origin: Origin::parse(&r.get::<_, String>(5)?),
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Every path that has history: (path, newest saved_at, version count), newest first.
    pub(crate) fn paths(&self) -> AppResult<Vec<(String, i64, u32)>> {
        let mut st = self.conn.prepare(
            "SELECT path, MAX(saved_at) AS last, COUNT(*) FROM versions GROUP BY path ORDER BY last DESC, path",
        )?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn content(&self, id: i64) -> AppResult<String> {
        let blob: Vec<u8> =
            self.conn.query_row("SELECT content_zstd FROM versions WHERE id = ?1", params![id], |r| r.get(0))?;
        let bytes = zstd::decode_all(blob.as_slice())?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60 * 1000;

    fn history() -> (tempfile::TempDir, History) {
        let dir = tempfile::tempdir().unwrap();
        let h = History::open(&dir.path().join("history.db")).unwrap();
        (dir, h)
    }

    #[test]
    fn skips_identical_content() {
        let (_d, h) = history();
        assert!(matches!(h.record_at("a.md", "x", Origin::App, false, 0).unwrap(), Recorded::Created(_)));
        assert_eq!(h.record_at("a.md", "x", Origin::App, false, 10 * MIN).unwrap(), Recorded::Skipped);
        assert_eq!(h.list("a.md").unwrap().len(), 1);
    }

    #[test]
    fn bundles_saves_within_five_minutes() {
        let (_d, h) = history();
        // 30 minutes of edits every 10 seconds
        for i in 0..180i64 {
            h.record_at("a.md", &format!("v{i}"), Origin::App, false, i * 10_000).unwrap();
        }
        let n = h.list("a.md").unwrap().len();
        assert_eq!(n, 6, "expected ~6 bundles, got {n}");
        // newest bundle holds the latest text
        let newest = h.list("a.md").unwrap()[0].id;
        assert_eq!(h.content(newest).unwrap(), "v179");
    }

    #[test]
    fn forced_save_closes_the_bundle() {
        let (_d, h) = history();
        h.record_at("a.md", "1", Origin::App, false, 0).unwrap();
        // saves 10 s apart: one burst of typing, so only forcing splits it
        assert!(matches!(h.record_at("a.md", "2", Origin::App, true, 10_000).unwrap(), Recorded::Updated(_)));
        assert!(matches!(h.record_at("a.md", "3", Origin::App, false, 20_000).unwrap(), Recorded::Created(_)));
        // forcing with unchanged text seals without adding a row
        assert_eq!(h.record_at("a.md", "3", Origin::App, true, 30_000).unwrap(), Recorded::Skipped);
        assert!(matches!(h.record_at("a.md", "4", Origin::App, false, 40_000).unwrap(), Recorded::Created(_)));
        assert_eq!(h.list("a.md").unwrap().len(), 3);
    }

    #[test]
    fn a_pause_starts_a_new_version() {
        let (_d, h) = history();
        h.record_at("a.md", "김, 이, 박", Origin::App, false, 0).unwrap();
        h.record_at("a.md", "김, 이, 박!", Origin::App, false, 30_000).unwrap(); // still typing
        // two minutes later the user comes back and edits
        h.record_at("a.md", "김, 이, 박, 최", Origin::App, false, 150_000).unwrap();
        let v = h.list("a.md").unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(h.content(v[1].id).unwrap(), "김, 이, 박!");
    }

    #[test]
    fn other_origins_never_join_an_app_bundle() {
        let (_d, h) = history();
        h.record_at("a.md", "1", Origin::App, false, 0).unwrap();
        h.record_at("a.md", "2", Origin::External, false, MIN).unwrap();
        h.record_at("a.md", "3", Origin::App, false, 2 * MIN).unwrap();
        let origins: Vec<_> = h.list("a.md").unwrap().iter().map(|v| v.origin).collect();
        assert_eq!(origins, [Origin::App, Origin::External, Origin::App]);
    }

    #[test]
    fn rename_path_moves_notes_and_folder_contents_only() {
        let (_d, h) = history();
        for p in ["f/a.md", "f/sub/b.md", "fx.md", "f.md"] {
            h.record_at(p, p, Origin::App, false, 0).unwrap();
        }
        h.rename_path("f", "g").unwrap();
        assert_eq!(h.list("g/a.md").unwrap().len(), 1);
        assert_eq!(h.list("g/sub/b.md").unwrap().len(), 1);
        assert_eq!(h.list("fx.md").unwrap().len(), 1);
        assert_eq!(h.list("f.md").unwrap().len(), 1);
    }

    #[test]
    fn notes_are_tracked_separately_and_content_roundtrips() {
        let (_d, h) = history();
        let text = "# 한글 제목\n\n본문 ".repeat(200);
        h.record_at("a.md", &text, Origin::App, false, 0).unwrap();
        h.record_at("b.md", "b", Origin::App, false, 0).unwrap();
        let a = h.list("a.md").unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].size, text.len() as i64);
        assert_eq!(h.content(a[0].id).unwrap(), text);
    }
}
