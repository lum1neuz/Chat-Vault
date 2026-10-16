//! Well-known folders on this PC.

use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

pub fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from)
}

pub fn home() -> Option<PathBuf> {
    env_path("USERPROFILE")
}

pub fn claude_projects() -> Option<PathBuf> {
    home().map(|p| p.join(".claude").join("projects"))
}

pub fn claude_meta() -> Option<PathBuf> {
    env_path("APPDATA").map(|p| p.join("Claude").join("claude-code-sessions"))
}

pub fn codex_home() -> Option<PathBuf> {
    home().map(|p| p.join(".codex"))
}

pub fn backup_root() -> Option<PathBuf> {
    home().map(|p| p.join("Documents").join("ChatVault Backup"))
}

pub fn data_dir() -> Option<PathBuf> {
    env_path("LOCALAPPDATA").map(|p| p.join("ChatVault"))
}

pub fn subdirs(p: &Path) -> Vec<PathBuf> {
    fs::read_dir(p)
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
        .unwrap_or_default()
}

/// Every `.jsonl` (and optionally `.json`) file below `root`, to any depth.
pub fn walk_files(root: &Path, exts: &[&str], out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(root) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk_files(&p, exts, out);
        } else if p.extension().map(|x| exts.iter().any(|e| x == *e)).unwrap_or(false) {
            out.push(p);
        }
    }
}

/// A transcript path may only point inside the folders ChatVault reads.
pub fn check_transcript(path: &str) -> Result<PathBuf, String> {
    let canon = PathBuf::from(path).canonicalize().map_err(|e| e.to_string())?;
    if canon.extension().map(|e| e != "jsonl" && e != "zst").unwrap_or(true) {
        return Err("That file is not a chat transcript".into());
    }
    let roots = [
        claude_projects(),
        codex_home().map(|c| c.join("sessions")),
        codex_home().map(|c| c.join("archived_sessions")),
        backup_root(),
    ];
    for r in roots.into_iter().flatten() {
        if let Ok(r) = r.canonicalize() {
            if canon.starts_with(&r) {
                return Ok(canon);
            }
        }
    }
    Err("That file is not inside a chat folder".into())
}

/// Lines of a transcript. Codex archives older chats as zstd-compressed `.jsonl.zst`.
pub fn open_lines(path: &Path) -> Option<Box<dyn Iterator<Item = String>>> {
    let f = File::open(path).ok()?;
    if path.extension().map(|e| e == "zst").unwrap_or(false) {
        let d = zstd::stream::read::Decoder::new(f).ok()?;
        Some(Box::new(BufReader::new(d).lines().map_while(Result::ok)))
    } else {
        Some(Box::new(BufReader::new(f).lines().map_while(Result::ok)))
    }
}
