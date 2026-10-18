//! Backs up the chats of Claude Code, Codex, Cursor, Gemini CLI, OpenCode and Cline into Documents, and restores them again.
//! Two PCs can share the backup folder (for example through Google Drive): a transcript is only ever replaced by a
//! longer copy of itself, by appending the missing lines, so neither PC puts an older chat over a newer one.
//! Restoring never overwrites other files.

use crate::paths::*;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
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
    /// Files taken in from the backup folder (the other PC) before backing up. Only set by `sync_both`.
    pub pulled: usize,
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
    // (live root, backup root, filter: 0 = everything, 1 = Claude transcripts only, 2 = Cursor transcripts only, 3 = Gemini chats, 4 = OpenCode database)
    let mut maps: Vec<(PathBuf, PathBuf, u8)> = Vec::new();
    if let Some(p) = claude_projects() {
        maps.push((p, b.join("claude").join("projects"), 1));
    }
    // The Claude app's own session records are read from the backup, never written into another PC's app.
    if let (Some(p), true) = (claude_meta(), forward) {
        maps.push((p, b.join("claude").join("sessions-meta"), 0));
    }
    if let Some(c) = codex_home() {
        maps.push((c.join("sessions"), b.join("codex").join("sessions"), 0));
        maps.push((c.join("archived_sessions"), b.join("codex").join("archived_sessions"), 0));
    }
    // Cursor: the plain-text agent transcripts and the CLI chat stores. The IDE database itself is not copied while Cursor may be writing to it.
    if let Some(h) = home() {
        maps.push((h.join(".cursor").join("projects"), b.join("cursor").join("projects"), 2));
        maps.push((h.join(".cursor").join("chats"), b.join("cursor").join("chats"), 0));
    }
    // Gemini CLI (chat files per project) and Cline (one folder per task). OpenCode keeps everything in one SQLite file:
    // it is copied into the backup but never written back over the live one.
    if let Some(h) = home() {
        maps.push((h.join(".gemini").join("tmp"), b.join("gemini").join("tmp"), 3));
        maps.push((h.join(".cline").join("data").join("sessions"), b.join("cline").join("sessions"), 0));
        if forward {
            let db = h.join(".local").join("share").join("opencode");
            maps.push((db, b.join("opencode"), 4));
        }
    }
    let gone = deleted();
    let mut out = Vec::new();
    for (live, back, filter) in maps {
        let (from, to) = if forward { (&live, &back) } else { (&back, &live) };
        let mut files = Vec::new();
        walk_all(from, &mut files);
        for f in files {
            let Ok(rel) = f.strip_prefix(from) else { continue };
            if is_deleted(&gone, &f) {
                continue;
            }
            // Claude project folders also hold sub-agent and tool-result files; keep only transcripts.
            let is_jsonl = f.extension().map(|e| e == "jsonl").unwrap_or(false);
            if filter == 1 && !(rel.components().count() == 2 && is_jsonl) {
                continue;
            }
            if filter == 2 && !(is_jsonl && rel.to_string_lossy().contains("agent-transcripts")) {
                continue;
            }
            // Gemini: only the saved chats (tmp/<project>/chats/*.json) and the file naming the project.
            if filter == 3 {
                let s = rel.to_string_lossy();
                let name = f.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                if !((s.contains("chats") && name.ends_with(".json")) || name == ".project_root") {
                    continue;
                }
            }
            // OpenCode: just its database file.
            if filter == 4 && f.file_name().map(|n| n != "opencode.db").unwrap_or(true) {
                continue;
            }
            out.push((f.clone(), to.join(rel)));
        }
    }
    out
}

const DELETED: &str = ".chatvault-deleted.txt";

/// Chats deleted in ChatVault on either PC (file name and size at deletion), kept in the backup folder so sync doesn't
/// bring them back. A chat that grows past that size was picked up again, so it syncs as normal.
// ponytail: if both PCs delete before Drive syncs this file, Drive may keep one version and the other chat returns.
fn deleted() -> HashMap<String, u64> {
    let mut out = HashMap::new();
    let text = backup_root().and_then(|b| fs::read_to_string(b.join(DELETED)).ok()).unwrap_or_default();
    for l in text.lines() {
        if let Some((name, len)) = l.trim().split_once('\t') {
            let len = len.parse().unwrap_or(u64::MAX);
            let e = out.entry(name.to_string()).or_insert(len);
            *e = (*e).max(len);
        }
    }
    out
}

fn is_deleted(gone: &HashMap<String, u64>, f: &Path) -> bool {
    let Some(&len) = f.file_name().and_then(|n| gone.get(n.to_string_lossy().as_ref())) else { return false };
    fs::metadata(f).map(|m| m.len() <= len).unwrap_or(true)
}

/// `len` is the chat's size before it was deleted.
pub fn forget_chat(p: &Path, len: u64) {
    let (Some(b), Some(name)) = (backup_root(), p.file_name()) else { return };
    let _ = fs::create_dir_all(&b);
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(b.join(DELETED)) {
        let _ = writeln!(f, "{}\t{}", name.to_string_lossy(), len);
    }
}

fn is_jsonl(p: &Path) -> bool {
    p.extension().map(|e| e == "jsonl").unwrap_or(false)
}

fn needs_copy(src: &Path, dst: &Path, forward: bool) -> bool {
    let Ok(dm) = fs::metadata(dst) else { return true };
    let Ok(sm) = fs::metadata(src) else { return false };
    // Transcripts only grow, so the copy that starts with the other one is the newer chat. If both PCs added to the
    // same chat the copies differ, and each PC keeps its own.
    // ponytail: a chat continued on both PCs stays split; saving the other side as a conflict copy would keep both.
    if is_jsonl(src) {
        return sm.len() > dm.len() && same_start(src, dst, dm.len());
    }
    // Other files are rewritten whole: backing up keeps the newer one, restoring only fills in missing ones.
    // ponytail: so Gemini and Cline chats continued on the other PC only arrive here when missing locally.
    if !forward {
        return false;
    }
    match (sm.modified(), dm.modified()) {
        (Ok(s), Ok(d)) => s.duration_since(d).map(|x| x.as_secs() > 2).unwrap_or(false),
        _ => false,
    }
}

/// True when the first `n` bytes of both files are the same.
fn same_start(a: &Path, b: &Path, n: u64) -> bool {
    if n == 0 {
        return true;
    }
    let (Ok(mut fa), Ok(mut fb)) = (File::open(a), File::open(b)) else { return false };
    let (mut ba, mut bb) = (vec![0u8; 1 << 16], vec![0u8; 1 << 16]);
    let mut left = n;
    while left > 0 {
        let k = left.min(ba.len() as u64) as usize;
        if fa.read_exact(&mut ba[..k]).is_err() || fb.read_exact(&mut bb[..k]).is_err() || ba[..k] != bb[..k] {
            return false;
        }
        left -= k as u64;
    }
    true
}

/// Where the last complete line of `f` ends, looking no further back than `from`.
fn whole_lines_end(f: &mut File, from: u64, len: u64) -> io::Result<u64> {
    let mut buf = vec![0u8; 1 << 16];
    let mut hi = len;
    while hi > from {
        let lo = hi.saturating_sub(buf.len() as u64).max(from);
        let n = (hi - lo) as usize;
        f.seek(SeekFrom::Start(lo))?;
        f.read_exact(&mut buf[..n])?;
        if let Some(i) = buf[..n].iter().rposition(|&b| b == b'\n') {
            return Ok(lo + i as u64 + 1);
        }
        hi = lo;
    }
    Ok(from)
}

/// Brings a transcript up to date by appending the whole lines it lacks, so a half-written last line never travels
/// to the other PC, and a copy that fails (say, Drive goes offline) or races with the tool writing the file never cuts
/// into what is already there. Returns the bytes added; 0 means there was nothing safe to add.
fn append_lines(src: &Path, dst: &Path) -> io::Result<u64> {
    let have = fs::metadata(dst).map(|m| m.len()).unwrap_or(0);
    let mut f = File::open(src)?;
    let meta = f.metadata()?;
    if meta.len() <= have || !same_start(src, dst, have) {
        return Ok(0);
    }
    let end = whole_lines_end(&mut f, have, meta.len())?;
    if end <= have {
        return Ok(0);
    }
    // Read everything first, so a read that fails (say, Drive goes offline) happens before anything is written.
    let mut tail = vec![0u8; (end - have) as usize];
    f.seek(SeekFrom::Start(have))?;
    f.read_exact(&mut tail)?;
    // Append mode with one write: a line the tool adds at the same moment lands before or after ours, never on top.
    let mut out = fs::OpenOptions::new().create(true).append(true).open(dst)?;
    if out.metadata()?.len() != have {
        return Ok(0); // the tool added to it since it was checked; next sync
    }
    out.write_all(&tail)?;
    // Keep the chat's own last-active time, as a plain copy would.
    if let Ok(m) = meta.modified() {
        let _ = out.set_modified(m);
    }
    Ok(end - have)
}

fn run(app: Option<&AppHandle>, forward: bool) -> Result<SyncStats, String> {
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err("A sync is already running".into());
    }
    let result = (|| {
        // A second ChatVault (say, opened from the Start menu while one runs in the tray) must not sync at the same time.
        use std::os::windows::fs::OpenOptionsExt;
        let lock = data_dir().and_then(|d| fs::create_dir_all(&d).ok().map(|_| d.join("sync.lock")));
        let _lock = lock
            .and_then(|p| fs::OpenOptions::new().create(true).write(true).share_mode(0).open(p).ok())
            .ok_or("A sync is already running")?;
        let root = backup_root().ok_or("No backup folder")?;
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let all = pairs(forward);
        let todo: Vec<&(PathBuf, PathBuf)> = all.iter().filter(|(s, d)| needs_copy(s, d, forward)).collect();
        let mut stats = SyncStats { total: todo.len(), skipped: all.len() - todo.len(), ..Default::default() };
        let phase = if forward { "Backing up" } else { "Restoring" };
        for (i, (src, dst)) in todo.iter().enumerate() {
            if let Some(parent) = dst.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let jsonl = is_jsonl(src);
            match if jsonl { append_lines(src, dst) } else { fs::copy(src, dst) } {
                Ok(0) if jsonl => stats.skipped += 1,
                Ok(n) => {
                    stats.copied += 1;
                    stats.bytes += n;
                }
                Err(_) => stats.failed += 1,
            }
            if i % 10 == 0 {
                let _ = app.map(|a| a.emit(
                    "sync-progress",
                    Progress {
                        phase: phase.into(),
                        done: i + 1,
                        total: todo.len(),
                        current: src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                    },
                ));
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
        let _ = app.map(|a| a.emit(
            "sync-progress",
            Progress { phase: "Done".into(), done: todo.len(), total: todo.len(), current: String::new() },
        ));
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
                .map_while(Result::ok)
                .filter_map(|l| serde_json::from_str::<Value>(&l).ok())
                .filter_map(|v| v.get("id").and_then(|x| x.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let mut add = Vec::new();
    for line in BufReader::new(src).lines().map_while(Result::ok) {
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

pub fn restore(app: &AppHandle) -> Result<SyncStats, String> {
    run(Some(app), false)
}

/// Takes in what the other PC put in the backup folder, then backs this PC up. Automatic sync runs this.
pub fn sync_both(app: Option<&AppHandle>) -> Result<SyncStats, String> {
    let pulled = run(app, false)?.copied;
    let mut stats = run(app, true)?;
    stats.pulled = pulled;
    Ok(stats)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    /// Points every well-known folder at `pc`, as if ChatVault ran on that PC, with `shared` as the backup folder.
    fn as_pc(pc: &Path, shared: &Path) {
        unsafe {
            std::env::set_var("USERPROFILE", pc);
            std::env::set_var("APPDATA", pc.join("Roaming"));
            std::env::set_var("LOCALAPPDATA", pc.join("Local"));
        }
        set_backup_root(shared).unwrap();
    }

    fn chat(pc: &Path) -> PathBuf {
        pc.join(".claude").join("projects").join("C--proj").join("s1.jsonl")
    }

    fn put(p: &Path, s: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, s).unwrap();
    }

    fn read(p: &Path) -> String {
        fs::read_to_string(p).unwrap_or_default()
    }

    /// Two PCs share one backup folder and take turns syncing.
    #[test]
    #[ignore = "changes USERPROFILE for the whole process; run alone with --ignored"]
    fn two_pcs_share_one_backup_folder() {
        let t = std::env::temp_dir().join("chatvault-two-pc-test");
        let _ = fs::remove_dir_all(&t);
        let (a, b, shared) = (t.join("a"), t.join("b"), t.join("drive"));
        let backup = shared.join("ChatVault Backup").join("claude").join("projects").join("C--proj").join("s1.jsonl");

        // A starts a chat; B picks it up.
        put(&chat(&a), "l1\n");
        put(&a.join("Roaming").join("Claude").join("claude-code-sessions").join("m.json"), "{}");
        as_pc(&a, &shared);
        sync_both(None).unwrap();
        as_pc(&b, &shared);
        assert_eq!(sync_both(None).unwrap().pulled, 1);
        assert_eq!(read(&chat(&b)), "l1\n");
        assert!(!b.join("Roaming").join("Claude").join("claude-code-sessions").exists(), "the Claude app's records stay on their PC");

        // B continues the chat. A takes in the longer chat instead of pushing its old one back.
        put(&chat(&b), "l1\nl2\n");
        sync_both(None).unwrap();
        as_pc(&a, &shared);
        sync_both(None).unwrap();
        assert_eq!(read(&chat(&a)), "l1\nl2\n");
        assert_eq!(read(&backup), "l1\nl2\n");

        // Both PCs continue it: neither loses its own version.
        put(&chat(&a), "l1\nl2\na3 longer\n");
        sync_both(None).unwrap();
        as_pc(&b, &shared);
        put(&chat(&b), "l1\nl2\nb3\n");
        sync_both(None).unwrap();
        assert_eq!(read(&chat(&b)), "l1\nl2\nb3\n");
        assert_eq!(read(&backup), "l1\nl2\na3 longer\n");

        // A whole-file chat (Gemini): an older copy on A never replaces B's newer one in the backup.
        let gem = |pc: &Path| pc.join(".gemini").join("tmp").join("p").join("chats").join("c.json");
        put(&gem(&b), "{\"v\":2}");
        sync_both(None).unwrap();
        as_pc(&a, &shared);
        put(&gem(&a), "{\"v\":1, \"old\":true}");
        File::options().write(true).open(gem(&a)).unwrap().set_modified(SystemTime::now() - Duration::from_secs(3600)).unwrap();
        sync_both(None).unwrap();
        assert_eq!(read(&shared.join("ChatVault Backup").join("gemini").join("tmp").join("p").join("chats").join("c.json")), "{\"v\":2}");

        // A half-written last line stays on its PC until it is complete.
        let s2 = |pc: &Path| pc.join(".claude").join("projects").join("C--proj").join("s2.jsonl");
        put(&s2(&a), "x1\nx2-half");
        sync_both(None).unwrap();
        as_pc(&b, &shared);
        sync_both(None).unwrap();
        assert_eq!(read(&s2(&b)), "x1\n");
        as_pc(&a, &shared);
        put(&s2(&a), "x1\nx2-half done\n");
        sync_both(None).unwrap();
        as_pc(&b, &shared);
        sync_both(None).unwrap();
        assert_eq!(read(&s2(&b)), "x1\nx2-half done\n");

        // A chat deleted on B is not brought back, from the backup or from A.
        let len = fs::metadata(s2(&b)).unwrap().len();
        fs::remove_file(s2(&b)).unwrap();
        forget_chat(&s2(&b), len);
        sync_both(None).unwrap();
        assert!(!s2(&b).exists());
        as_pc(&a, &shared);
        sync_both(None).unwrap();
        as_pc(&b, &shared);
        sync_both(None).unwrap();
        assert!(!s2(&b).exists());

        // ...unless someone picks it up again: once it grows past its deleted size it syncs as normal.
        as_pc(&a, &shared);
        put(&s2(&a), "x1\nx2-half done\nx3\n");
        sync_both(None).unwrap();
        as_pc(&b, &shared);
        sync_both(None).unwrap();
        assert_eq!(read(&s2(&b)), "x1\nx2-half done\nx3\n");

        let _ = fs::remove_dir_all(&t);
    }
}
