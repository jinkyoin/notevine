//! Vault-relative path rules (개발계획서 4장 규칙 4·5):
//! separators are always `/`, names are NFC-normalized, and comparison of note
//! names ignores case.

use std::path::{Component, Path};

use unicode_normalization::UnicodeNormalization;

use crate::error::{AppError, AppResult};

/// Folder that holds app data inside a vault. Never shown in the file tree.
pub const APP_DIR: &str = ".app";

/// Canonical form of a vault-relative path: `/` separators, NFC, no leading or
/// trailing slash, no empty or `.` segments.
pub fn normalize_rel(s: &str) -> String {
    s.replace('\\', "/")
        .split('/')
        .filter(|seg| !seg.is_empty() && *seg != ".")
        .map(|seg| seg.nfc().collect::<String>())
        .collect::<Vec<_>>()
        .join("/")
}

/// Rejects paths that could escape the vault (NFR-SEC-01).
pub fn check_rel(rel: &str) -> AppResult<()> {
    let p = Path::new(rel);
    for c in p.components() {
        match c {
            Component::Normal(_) => {}
            _ => return Err(AppError::OutsideVault(rel.to_string())),
        }
    }
    Ok(())
}

/// Builds a vault-relative path from an absolute path under `root`.
pub fn to_rel(root: &Path, abs: &Path) -> Option<String> {
    abs.strip_prefix(root)
        .ok()
        .map(|p| normalize_rel(&p.to_string_lossy()))
}

pub fn join_rel(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

pub fn parent_rel(rel: &str) -> &str {
    rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("")
}

pub fn file_name(rel: &str) -> &str {
    rel.rsplit_once('/').map(|(_, n)| n).unwrap_or(rel)
}

/// Resolves a relative link destination against a note's folder: handles `./`,
/// `../` and a leading `/` (vault root). `None` if it climbs above the vault.
pub fn resolve_rel(base_dir: &str, dest: &str) -> Option<String> {
    let dest = dest.replace('\\', "/");
    let mut parts: Vec<String> = if dest.starts_with('/') {
        Vec::new()
    } else {
        base_dir.split('/').filter(|s| !s.is_empty()).map(str::to_string).collect()
    };
    for seg in dest.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s.nfc().collect()),
        }
    }
    Some(parts.join("/"))
}

pub fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

pub fn is_note(name: &str) -> bool {
    name.to_lowercase().ends_with(".md")
}

/// Case-insensitive, NFC-normalized key used to compare names.
pub fn name_key(name: &str) -> String {
    name.nfc().collect::<String>().to_lowercase()
}

const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// A single file or folder name that is valid on Windows (the strictest target).
pub fn validate_name(name: &str) -> AppResult<()> {
    let bad = || Err(AppError::InvalidName(name.to_string()));
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." || trimmed != name {
        return bad();
    }
    if name.ends_with('.') {
        return bad();
    }
    if name
        .chars()
        .any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control())
    {
        return bad();
    }
    let stem = name.split('.').next().unwrap_or("").to_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        return bad();
    }
    if name.eq_ignore_ascii_case(APP_DIR) {
        return bad();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_separators_and_nfc() {
        // "한글" written in NFD (as macOS stores it) becomes NFC.
        let nfd: String = "노트/한글.md".nfd().collect();
        assert_ne!(nfd, "노트/한글.md");
        assert_eq!(normalize_rel(&nfd), "노트/한글.md");
        assert_eq!(normalize_rel("\\a\\\\b/./c/"), "a/b/c");
    }

    #[test]
    fn rejects_escaping_paths() {
        assert!(check_rel("a/b.md").is_ok());
        assert!(check_rel("../x.md").is_err());
        assert!(check_rel("a/../../x").is_err());
    }

    #[test]
    fn validates_names() {
        assert!(validate_name("2026-10-28 업무일지.md").is_ok());
        for bad in ["", " a", "a ", "a/b", "a:b", "CON", "con.md", "x.", ".app", ".."] {
            assert!(validate_name(bad).is_err(), "{bad:?} should be invalid");
        }
    }

    #[test]
    fn name_key_ignores_case_and_normalization() {
        let nfd: String = "회의록 A.md".nfd().collect();
        assert_eq!(name_key(&nfd), name_key("회의록 a.MD"));
    }

    #[test]
    fn resolves_relative_destinations() {
        assert_eq!(resolve_rel("일지", "../30 조사자료/a.md").as_deref(), Some("30 조사자료/a.md"));
        assert_eq!(resolve_rel("a/b", "./c.md").as_deref(), Some("a/b/c.md"));
        assert_eq!(resolve_rel("a/b", "/x/y.md").as_deref(), Some("x/y.md"));
        assert_eq!(resolve_rel("", "../x.md"), None);
    }

    #[test]
    fn rel_helpers() {
        assert_eq!(parent_rel("a/b/c.md"), "a/b");
        assert_eq!(parent_rel("c.md"), "");
        assert_eq!(file_name("a/b/c.md"), "c.md");
        assert_eq!(join_rel("", "x"), "x");
        assert_eq!(join_rel("a", "x"), "a/x");
    }
}
