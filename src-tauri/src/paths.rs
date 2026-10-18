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

const BACKUP_NAME: &str = "ChatVault Backup";

/// The folder picked in Sync & backup (for example inside Google Drive, so two PCs share it), otherwise Documents.
pub fn backup_root() -> Option<PathBuf> {
    let picked = data_dir()
        .and_then(|d| fs::read_to_string(d.join("backup-folder.txt")).ok())
        .map(|s| PathBuf::from(s.trim()))
        .filter(|p| p.is_absolute());
    picked.or_else(|| home().map(|p| p.join("Documents").join(BACKUP_NAME)))
}

/// Remembers the picked folder. Backups always go into a "ChatVault Backup" folder inside it, never loose into it.
pub fn set_backup_root(parent: &Path) -> Result<PathBuf, String> {
    if !parent.is_absolute() {
        return Err("Pick a full folder path".into());
    }
    let root = if parent.file_name().map(|n| n == BACKUP_NAME).unwrap_or(false) { parent.to_path_buf() } else { parent.join(BACKUP_NAME) };
    // A backup inside a chat folder would copy itself into itself.
    let live = [claude_projects(), claude_meta(), codex_home(), home().map(|h| h.join(".cursor")), home().map(|h| h.join(".gemini")), home().map(|h| h.join(".cline")), home().map(|h| h.join(".local").join("share").join("opencode"))];
    if live.into_iter().flatten().any(|l| root.starts_with(&l)) {
        return Err("The backup folder can't be inside a chat folder".into());
    }
    let d = data_dir().ok_or("No app data folder")?;
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    fs::write(d.join("backup-folder.txt"), root.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
    Ok(root)
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
