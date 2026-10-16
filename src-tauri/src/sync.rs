//! Backs up Claude Code and Codex chats into Documents, and restores them again.
//! Restoring never overwrites a file that already exists.

use crate::paths::*;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};

static BUSY: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Default)]
pub struct SyncStats {
    pub copied: usize,
    pub skipped: usize,
    pub failed: usize,
    pub bytes: u64,
    pub total: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStatus {
    pub path: String,
    pub exists: bool,
    pub files: usize,
    pub bytes: u64,
    pub last_sync_ms: Option<i64>,
}

#[derive(Serialize, Clone)]
struct Progress {
    phase: String,
    done: usize,
    total: usize,
    current: String,
}

fn walk_all(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(root) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk_all(&p, out);
        } else {
            out.push(p);
        }
    }
}

/// (source, destination) pairs. `forward` = live -> backup, otherwise backup -> live.
fn pairs(forward: bool) -> Vec<(PathBuf, PathBuf)> {
    let Some(b) = backup_root() else { return Vec::new() };
    let mut maps: Vec<(PathBuf, PathBuf, bool)> = Vec::new(); // (live root, backup root, transcripts only)
    if let Some(p) = claude_projects() {
        maps.push((p, b.join("claude").join("projects"), true));
    }
    if let Some(p) = claude_meta() {
        maps.push((p, b.join("claude").join("sessions-meta"), false));
    }
    if let Some(c) = codex_home() {
        maps.push((c.join("sessions"), b.join("codex").join("sessions"), false));
        maps.push((c.join("archived_sessions"), b.join("codex").join("archived_sessions"), false));
    }
    let mut out = Vec::new();
    for (live, back, transcripts_only) in maps {
        let (from, to) = if forward { (&live, &back) } else { (&back, &live) };
        let mut files = Vec::new();
        walk_all(from, &mut files);
        for f in files {
            let Ok(rel) = f.strip_prefix(from) else { continue };
            // Claude project folders also hold sub-agent and tool-result files; keep only transcripts.
            if transcripts_only
                && !(rel.components().count() == 2 && f.extension().map(|e| e == "jsonl").unwrap_or(false))
            {
                continue;
            }
            out.push((f.clone(), to.join(rel)));
        }
    }
    out
}

fn needs_copy(src: &Path, dst: &Path, overwrite_changed: bool) -> bool {
    let Ok(dm) = fs::metadata(dst) else { return true };
    if !overwrite_changed {
        return false;
    }
    let Ok(sm) = fs::metadata(src) else { return false };
    if sm.len() != dm.len() {
        return true;
    }
    match (sm.modified(), dm.modified()) {
        (Ok(s), Ok(d)) => s.duration_since(d).map(|x| x.as_secs() > 2).unwrap_or(false),
        _ => false,
    }
}

fn run(app: &AppHandle, forward: bool) -> Result<SyncStats, String> {
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err("A sync is already running".into());
    }
    let result = (|| {
        let root = backup_root().ok_or("No Documents folder")?;
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let all = pairs(forward);
        let todo: Vec<&(PathBuf, PathBuf)> = all.iter().filter(|(s, d)| needs_copy(s, d, forward)).collect();
        let mut stats = SyncStats { total: todo.len(), skipped: all.len() - todo.len(), ..Default::default() };
        let phase = if forward { "Backing up" } else { "Restoring" };
        for (i, (src, dst)) in todo.iter().enumerate() {
            if let Some(parent) = dst.parent() {
                let _ = fs::create_dir_all(parent);
            }
            match fs::copy(src, dst) {
                Ok(n) => {
                    stats.copied += 1;
                    stats.bytes += n;
                }
                Err(_) => stats.failed += 1,
            }
            if i % 10 == 0 {
                let _ = app.emit(
                    "sync-progress",
                    Progress {
                        phase: phase.into(),
                        done: i + 1,
                        total: todo.len(),
                        current: src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                    },
                );
            }
        }
        merge_codex_index(forward);
        if forward {
            let ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            let _ = fs::write(root.join(".chatvault-sync.json"), format!("{{\"lastSyncMs\":{}}}", ms));
        }
        let _ = app.emit(
            "sync-progress",
            Progress { phase: "Done".into(), done: todo.len(), total: todo.len(), current: String::new() },
        );
        Ok(stats)
    })();
    BUSY.store(false, Ordering::SeqCst);
    result
}

/// session_index.jsonl holds Codex thread names. Add any thread the destination does not have yet.
fn merge_codex_index(forward: bool) {
    let (Some(c), Some(b)) = (codex_home(), backup_root()) else { return };
    let live = c.join("session_index.jsonl");
    let back = b.join("codex").join("session_index.jsonl");
    let (from, to) = if forward { (live, back) } else { (back, live) };
    let Ok(src) = File::open(&from) else { return };
    let have: HashSet<String> = File::open(&to)
        .map(|f| {
            BufReader::new(f)
                .lines()
                .flatten()
                .filter_map(|l| serde_json::from_str::<Value>(&l).ok())
                .filter_map(|v| v.get("id").and_then(|x| x.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let mut add = Vec::new();
    for line in BufReader::new(src).lines().flatten() {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
            if !have.contains(id) {
                add.push(line);
            }
        }
    }
    if add.is_empty() {
        return;
    }
    if let Some(parent) = to.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&to) {
        for l in add {
            let _ = writeln!(f, "{}", l);
        }
    }
}

pub fn backup(app: &AppHandle) -> Result<SyncStats, String> {
    run(app, true)
}

pub fn restore(app: &AppHandle) -> Result<SyncStats, String> {
    run(app, false)
}

pub fn status() -> BackupStatus {
    let Some(root) = backup_root() else {
        return BackupStatus { path: String::new(), exists: false, files: 0, bytes: 0, last_sync_ms: None };
    };
    let mut files = Vec::new();
    walk_all(&root, &mut files);
    let bytes = files.iter().filter_map(|f| fs::metadata(f).ok()).map(|m| m.len()).sum();
    let last_sync_ms = fs::read_to_string(root.join(".chatvault-sync.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("lastSyncMs").and_then(|x| x.as_i64()));
    BackupStatus {
        path: root.to_string_lossy().to_string(),
        exists: root.exists(),
        files: files.len(),
        bytes,
        last_sync_ms,
    }
}
