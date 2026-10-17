mod cursor;
mod index;
mod paths;
mod providers;
mod sync;

use index::{ChatSummary, Overview, Page};
use paths::*;
use providers::{clip, is_readable, messages_for, Msg};
use serde::Serialize;
use serde_json::Value;
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::AppHandle;

#[derive(Serialize)]
struct SearchHit {
    id: String,
    snippet: String,
}

#[derive(Serialize)]
struct MsgPage {
    messages: Vec<Msg>,
    total: usize,
    start: usize,
}

fn provider_ok(p: &str) -> Result<(), String> {
    if p == "claude" || p == "codex" || p == "cursor" {
        Ok(())
    } else {
        Err("Unknown provider".into())
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Lines worth parsing. Skipping the rest keeps very large transcripts fast.
fn relevant(provider: &str, line: &str) -> bool {
    if provider == "codex" {
        line.contains("\"response_item\"")
    } else {
        line.contains("\"type\":\"user\"") || line.contains("\"type\":\"assistant\"")
    }
}

fn clip_msg(mut m: Msg, max: usize) -> Msg {
    if m.text.chars().count() > max {
        m.text = clip(&m.text, max);
    }
    m
}

#[tauri::command]
async fn refresh_index(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || index::refresh(Some(&app)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn query_chats(provider: String, account: Option<String>, q: String, offset: i64, limit: i64, sort: Option<String>, scope: Option<String>) -> Result<Page, String> {
    provider_ok(&provider)?;
    tauri::async_runtime::spawn_blocking(move || index::query(&provider, account, &q, offset, limit.clamp(1, 200), sort.as_deref().unwrap_or("recent"), scope.as_deref().unwrap_or("all")))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn provider_overview(provider: String) -> Result<Overview, String> {
    provider_ok(&provider)?;
    tauri::async_runtime::spawn_blocking(move || index::overview(&provider))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn overview_stats(days: i64) -> Result<index::Stats, String> {
    tauri::async_runtime::spawn_blocking(move || index::stats(days.clamp(1, 90)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn chats_by_ids(provider: String, ids: Vec<String>) -> Result<Vec<ChatSummary>, String> {
    provider_ok(&provider)?;
    tauri::async_runtime::spawn_blocking(move || index::by_ids(&provider, &ids[..ids.len().min(300)]))
        .await
        .map_err(|e| e.to_string())?
}

/// A window of messages. `before` is a message index; without it the newest `limit` messages come back.
#[derive(serde::Serialize)]
struct OutlineTick {
    ts: String,
    text: String,
}

/// A light outline of the whole chat for the side timeline: only your messages, each cut short, and at most 240 of them.
/// Only the lines that hold your messages are parsed, and nothing is sent to the page except these few ticks.
#[tauri::command]
async fn chat_outline(provider: String, path: String) -> Result<Vec<OutlineTick>, String> {
    provider_ok(&provider)?;
    tauri::async_runtime::spawn_blocking(move || {
        if provider == "cursor" {
            return Err("not supported".to_string());
        }
        let p = check_transcript(&path)?;
        let lines = open_lines(&p).ok_or("Cannot open that chat")?;
        let mut ticks: Vec<OutlineTick> = Vec::new();
        for line in lines {
            let user_line = if provider == "codex" {
                line.contains("\"response_item\"") && line.contains("\"role\":\"user\"")
            } else {
                line.contains("\"type\":\"user\"")
            };
            if !user_line {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            for m in messages_for(&provider, &v) {
                if m.role == "user" && m.kind == "text" && !m.text.trim().is_empty() {
                    ticks.push(OutlineTick { ts: m.ts.clone(), text: clip(m.text.trim(), 140) });
                }
            }
        }
        if ticks.len() > 240 {
            let n = ticks.len();
            let keep: Vec<usize> = (0..240).map(|k| k * (n - 1) / 239).collect();
            ticks = keep.into_iter().map(|i| OutlineTick { ts: ticks[i].ts.clone(), text: ticks[i].text.clone() }).collect();
        }
        Ok(ticks)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn new_session_id() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut b = [0u8; 16];
    for half in 0..2 {
        let mut h = RandomState::new().build_hasher();
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        h.write_u32(std::process::id());
        b[half * 8..half * 8 + 8].copy_from_slice(&h.finish().to_le_bytes());
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let x: Vec<String> = b.iter().map(|v| format!("{v:02x}")).collect();
    format!("{}-{}-{}-{}-{}", x[0..4].concat(), x[4..6].concat(), x[6..8].concat(), x[8..10].concat(), x[10..16].concat())
}

#[derive(serde::Serialize)]
struct Forked {
    id: String,
    path: String,
}

/// Makes a copy of a chat with its own session id, next to the original, so it shows up as a new chat at once.
/// Nothing is opened and the original file is never touched.
#[tauri::command]
async fn fork_chat(provider: String, path: String) -> Result<Forked, String> {
    provider_ok(&provider)?;
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;
        if provider == "cursor" {
            return Err("Cursor chats cannot be forked. Use Continue in Claude or Codex instead.".to_string());
        }
        let src = check_transcript(&path)?;
        let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let stem = stem.strip_suffix(".jsonl").unwrap_or(&stem).to_string();
        let dir = src.parent().ok_or("Cannot find the chat folder")?.to_path_buf();
        let new_id = new_session_id();
        // Claude names the file by its id; Codex puts the id at the end of "rollout-<time>-<id>".
        let (old_id, new_name) = if provider == "codex" {
            if stem.len() < 36 {
                return Err("Cannot read that Codex chat id".to_string());
            }
            let (head, id) = stem.split_at(stem.len() - 36);
            (id.to_string(), format!("{head}{new_id}.jsonl"))
        } else {
            (stem.clone(), format!("{new_id}.jsonl"))
        };
        let dest = dir.join(&new_name);
        let lines = open_lines(&src).ok_or("Cannot open that chat")?;
        let tmp = dir.join(format!("{new_name}.tmp"));
        {
            let mut w = std::io::BufWriter::new(std::fs::File::create(&tmp).map_err(|e| e.to_string())?);
            for line in lines {
                let out = if line.contains(&old_id) { line.replace(&old_id, &new_id) } else { line };
                w.write_all(out.as_bytes()).map_err(|e| e.to_string())?;
                w.write_all(b"\n").map_err(|e| e.to_string())?;
            }
            w.flush().map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
        Ok(Forked { id: new_id, path: dest.to_string_lossy().to_string() })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// (file count, newest change) across Claude and Codex chats, for spotting new conversations as they start.
#[tauri::command]
fn files_fingerprint() -> (usize, i64) {
    index::files_fingerprint()
}

/// Changes whenever Cursor writes to its chat storage, so the list can follow a Cursor chat as it happens.
#[tauri::command]
fn cursor_fingerprint() -> i64 {
    cursor::fingerprint()
}

struct Started {
    child: std::process::Child,
    err_path: std::path::PathBuf,
}

/// Agents that ChatVault started in the background, by "provider:id", so they can be stopped and their state shown.
static RUNNING: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Started>>> = std::sync::OnceLock::new();
/// What an agent printed to its error stream when it ended badly, kept until the page asks for it.
static LAST_ERR: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, String>>> = std::sync::OnceLock::new();

fn running() -> &'static std::sync::Mutex<std::collections::HashMap<String, Started>> {
    RUNNING.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}
fn last_err() -> &'static std::sync::Mutex<std::collections::HashMap<String, String>> {
    LAST_ERR.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// The newest installed Cursor agent: its own node and script, run directly so the message never passes through a shell.
fn cursor_agent_entry() -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    let root = std::path::PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("cursor-agent").join("versions");
    let mut dirs: Vec<_> = std::fs::read_dir(root).ok()?.flatten().filter(|e| e.path().join("index.js").exists() && e.path().join("node.exe").exists()).collect();
    dirs.sort_by_key(|e| e.file_name());
    let d = dirs.pop()?.path();
    Some((d.join("node.exe"), d.join("index.js")))
}

fn finish(map: &mut std::collections::HashMap<String, Started>, key: &str) {
    if let Some(mut st) = map.remove(key) {
        let ok = st.child.try_wait().ok().flatten().map(|s| s.success()).unwrap_or(true);
        if !ok {
            if let Ok(txt) = std::fs::read_to_string(&st.err_path) {
                let t = txt.trim();
                if !t.is_empty() {
                    if let Ok(mut e) = last_err().lock() {
                        e.insert(key.to_string(), t.lines().last().unwrap_or(t).chars().take(300).collect());
                    }
                }
            }
        }
        let _ = std::fs::remove_file(&st.err_path);
    }
}

/// Sends a message into an existing Claude Code, Codex or Cursor session, with no terminal. The agent runs hidden in the chat's
/// own folder and appends to the same session, so the reply shows up live here and in the other app. It runs with full access.
#[tauri::command]
fn send_message(provider: String, id: String, cwd: Option<String>, message: String) -> Result<(), String> {
    use std::io::Write;
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;
    provider_ok(&provider)?;
    if message.trim().is_empty() {
        return Err("Write a message first.".into());
    }
    let key = format!("{provider}:{id}");
    let mut map = running().lock().map_err(|_| "busy".to_string())?;
    if let Some(st) = map.get_mut(&key) {
        if matches!(st.child.try_wait(), Ok(None)) {
            return Err("The agent is still working on the previous message.".into());
        }
        finish(&mut map, &key);
    }
    if let Ok(mut e) = last_err().lock() {
        e.remove(&key);
    }
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let dir = cwd.filter(|d| Path::new(d).is_dir());
    let (mut cmd, name, via_stdin) = match provider.as_str() {
        "codex" => {
            let mut c = Command::new("codex");
            c.args(["exec", "resume", &id, "--dangerously-bypass-approvals-and-sandbox", "-"]);
            (c, "Codex", true)
        }
        "cursor" => {
            let (node, entry) = cursor_agent_entry().ok_or("Cursor's agent is not installed. Install it from cursor.com/cli.")?;
            let chat_id = id.rsplit(['\\', '/', ':']).next().unwrap_or(&id).to_string();
            let mut c = Command::new(node);
            c.arg(entry).args(["-p", "--resume", &chat_id, "--force", "--trust"]);
            if let Some(d) = &dir {
                c.arg("--workspace").arg(d);
            }
            c.arg(&message);
            c.env("CURSOR_INVOKED_AS", "cursor-agent.cmd");
            (c, "Cursor", false)
        }
        _ => {
            let mut c = Command::new("claude");
            c.args(["-p", "--resume", &id, "--dangerously-skip-permissions"]);
            (c, "Claude Code", true)
        }
    };
    if let Some(d) = &dir {
        cmd.current_dir(d);
    }
    let err_path = std::env::temp_dir().join(format!("chatvault-agent-{}.err", key.replace(':', "_")));
    let err_file = std::fs::File::create(&err_path).map_err(|e| e.to_string())?;
    let mut child = cmd
        .stdin(if via_stdin { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::null())
        .stderr(Stdio::from(err_file))
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Could not start {name}: {e}. Is it installed and on your PATH?"))?;
    if via_stdin {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(message.as_bytes());
        }
    }
    map.insert(key, Started { child, err_path });
    Ok(())
}

/// Starts the tool's own sign-in (it opens your browser), so messages sent from ChatVault are allowed to run.
#[tauri::command]
fn agent_login(provider: String) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;
    provider_ok(&provider)?;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = match provider.as_str() {
        "codex" => {
            let mut c = Command::new("codex");
            c.arg("login");
            c
        }
        "cursor" => {
            let (node, entry) = cursor_agent_entry().ok_or("Cursor's agent is not installed. Install it from cursor.com/cli.")?;
            let mut c = Command::new(node);
            c.arg(entry).arg("login");
            c.env("CURSOR_INVOKED_AS", "cursor-agent.cmd");
            c
        }
        _ => {
            let mut c = Command::new("claude");
            c.args(["auth", "login"]);
            c
        }
    };
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(CREATE_NO_WINDOW).spawn().map_err(|e| format!("Could not start the sign-in: {e}"))?;
    Ok(())
}

/// Whether an agent started from ChatVault is still working on this chat.
#[tauri::command]
fn agent_running(provider: String, id: String) -> bool {
    let key = format!("{provider}:{id}");
    let Ok(mut map) = running().lock() else { return false };
    let alive = map.get_mut(&key).map(|st| matches!(st.child.try_wait(), Ok(None)));
    match alive {
        Some(true) => true,
        Some(false) => {
            finish(&mut map, &key);
            false
        }
        None => false,
    }
}

/// The last error an agent from ChatVault ended with for this chat, once.
#[tauri::command]
fn take_agent_error(provider: String, id: String) -> Option<String> {
    last_err().lock().ok()?.remove(&format!("{provider}:{id}"))
}

/// Stops the agent that ChatVault started for this chat.
#[tauri::command]
fn stop_agent(provider: String, id: String) -> bool {
    let key = format!("{provider}:{id}");
    let Ok(mut map) = running().lock() else { return false };
    if let Some(mut st) = map.remove(&key) {
        let _ = st.child.kill();
        let _ = st.child.wait();
        let _ = std::fs::remove_file(&st.err_path);
        return true;
    }
    false
}

/// When each listed chat file last changed (0 when unknown), so the list can show which chats an agent is writing to.
#[tauri::command]
fn chat_stamps(items: Vec<(String, String)>) -> Vec<u64> {
    items
        .into_iter()
        .map(|(provider, path)| {
            if provider == "cursor" {
                return 0;
            }
            let Ok(p) = check_transcript(&path) else { return 0 };
            std::fs::metadata(&p)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0)
        })
        .collect()
}

/// Size and modified time of a chat file, so the open chat can be checked for new messages without reading it.
#[tauri::command]
fn chat_stamp(provider: String, path: String) -> Result<(u64, u64), String> {
    provider_ok(&provider)?;
    let p = check_transcript(&path)?;
    let md = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    let ms = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
    Ok((md.len(), ms))
}

/// The newest messages of a chat, read from the end of the file, so a chat can show its latest messages at once
/// while the full page (with the total count) is still being worked out.
#[tauri::command]
async fn read_chat_tail(provider: String, path: String, limit: usize) -> Result<Vec<Msg>, String> {
    provider_ok(&provider)?;
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::{Read, Seek, SeekFrom};
        if provider == "cursor" {
            return Err("not supported".to_string());
        }
        let p = check_transcript(&path)?;
        if p.extension().map(|e| e == "zst").unwrap_or(false) {
            return Err("not supported".to_string());
        }
        let limit = limit.clamp(1, 400);
        let mut f = std::fs::File::open(&p).map_err(|e| e.to_string())?;
        let len = f.metadata().map_err(|e| e.to_string())?.len();
        let mut pos = len;
        let mut buf: Vec<u8> = Vec::new();
        let chunk: u64 = 512 * 1024;
        loop {
            let take = chunk.min(pos);
            pos -= take;
            f.seek(SeekFrom::Start(pos)).map_err(|e| e.to_string())?;
            let mut part = vec![0u8; take as usize];
            f.read_exact(&mut part).map_err(|e| e.to_string())?;
            part.extend_from_slice(&buf);
            buf = part;
            let text = String::from_utf8_lossy(&buf);
            // Unless this reaches the start of the file, the first line may be cut in half.
            let from = if pos > 0 { text.find('\n').map(|i| i + 1).unwrap_or(text.len()) } else { 0 };
            let mut out: Vec<Msg> = Vec::new();
            for line in text[from..].lines() {
                if !relevant(&provider, line) {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
                for m in messages_for(&provider, &v) {
                    out.push(clip_msg(m, 30_000));
                }
            }
            if out.len() >= limit || pos == 0 {
                let skip = out.len().saturating_sub(limit);
                return Ok(out.split_off(skip));
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn read_chat_page(provider: String, path: String, before: Option<usize>, limit: usize) -> Result<MsgPage, String> {
    provider_ok(&provider)?;
    tauri::async_runtime::spawn_blocking(move || {
        if provider == "cursor" {
            let all: Vec<Msg> = cursor::read(&path)?.into_iter().map(|m| clip_msg(m, 30_000)).collect();
            let total = all.len();
            let limit = limit.clamp(1, 2000);
            let end = before.map(|b| b.min(total)).unwrap_or(total);
            let start = end.saturating_sub(limit);
            return Ok(MsgPage { messages: all[start..end].to_vec(), total, start });
        }
        let p = check_transcript(&path)?;
        let lines = open_lines(&p).ok_or("Cannot open that chat")?;
        let limit = limit.clamp(1, 2000);
        let mut idx = 0usize;
        let mut ring: VecDeque<Msg> = VecDeque::new();
        let mut picked: Vec<Msg> = Vec::new();
        let lo = before.map(|b| b.saturating_sub(limit)).unwrap_or(0);
        for line in lines {
            if !relevant(&provider, &line) {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            for m in messages_for(&provider, &v) {
                let m = clip_msg(m, 30_000);
                match before {
                    None => {
                        ring.push_back(m);
                        if ring.len() > limit {
                            ring.pop_front();
                        }
                    }
                    Some(b) => {
                        if idx >= lo && idx < b {
                            picked.push(m);
                        }
                    }
                }
                idx += 1;
            }
        }
        Ok(match before {
            None => MsgPage { start: idx - ring.len(), total: idx, messages: ring.into_iter().collect() },
            Some(_) => MsgPage { start: lo, total: idx, messages: picked },
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Every readable message (no tool steps), used for exports and handoff files.
#[tauri::command]
async fn read_chat_all(provider: String, path: String) -> Result<Vec<Msg>, String> {
    provider_ok(&provider)?;
    tauri::async_runtime::spawn_blocking(move || {
        if provider == "cursor" {
            return Ok(cursor::read(&path)?.into_iter().filter(is_readable).map(|m| clip_msg(m, 20_000)).collect());
        }
        let p = check_transcript(&path)?;
        let lines = open_lines(&p).ok_or("Cannot open that chat")?;
        let mut out = Vec::new();
        for line in lines {
            if !relevant(&provider, &line) {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                out.extend(messages_for(&provider, &v).into_iter().filter(is_readable).map(|m| clip_msg(m, 20_000)));
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Searches the text of the most recent chats of one provider.
#[tauri::command]
async fn deep_search(provider: String, query: String) -> Result<Vec<SearchHit>, String> {
    provider_ok(&provider)?;
    tauri::async_runtime::spawn_blocking(move || {
        let q = query.trim().to_lowercase();
        if q.chars().count() < 2 {
            return Ok(Vec::new());
        }
        let mut hits = Vec::new();
        if provider == "cursor" {
            for (id, path) in index::recent_paths(&provider, 3000)? {
                let Ok(msgs) = cursor::read(&path) else { continue };
                if let Some(m) = msgs.iter().filter(|m| is_readable(m)).find(|m| m.text.to_lowercase().contains(&q)) {
                    let low = m.text.to_lowercase();
                    let pos = low.find(&q).unwrap_or(0);
                    let start = m.text[..pos.min(m.text.len())].char_indices().rev().nth(40).map(|(i, _)| i).unwrap_or(0);
                    hits.push(SearchHit { id, snippet: clip(m.text[start..].replace('\n', " ").trim(), 140) });
                }
            }
            return Ok(hits);
        }
        for (id, path) in index::recent_paths(&provider, 3000)? {
            let Some(lines) = open_lines(Path::new(&path)) else { continue };
            'file: for line in lines {
                if !relevant(&provider, &line) || !line.to_lowercase().contains(&q) {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                for m in messages_for(&provider, &v) {
                    if !is_readable(&m) {
                        continue;
                    }
                    let low = m.text.to_lowercase();
                    if let Some(pos) = low.find(&q) {
                        let start = m.text[..pos.min(m.text.len())]
                            .char_indices()
                            .rev()
                            .nth(40)
                            .map(|(i, _)| i)
                            .unwrap_or(0);
                        hits.push(SearchHit { id: id.clone(), snippet: clip(m.text[start..].replace('\n', " ").trim(), 140) });
                        break 'file;
                    }
                }
            }
            if hits.len() >= 300 {
                break;
            }
        }
        Ok(hits)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), String> {
    let p = if path.starts_with("cursor-") { cursor::real_file(&path).ok_or("That Cursor file is not available")? } else { check_transcript(&path)? };
    let p = p.to_string_lossy().trim_start_matches(r"\\?\").to_string();
    Command::new("explorer").arg(format!("/select,{}", p)).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    if !Path::new(&path).is_dir() {
        return Err("That folder no longer exists".into());
    }
    Command::new("explorer").arg(&path).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// Moves a chat transcript to the Recycle Bin, so it can still be restored from there.
#[tauri::command]
async fn delete_chat(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if path.starts_with("cursor-") {
            return Err("Cursor chats live inside Cursor's own database, so they can only be deleted in Cursor".to_string());
        }
        // A file that is already gone (deleted outside ChatVault) only needs to leave the list.
        if !Path::new(&path).exists() {
            index::forget(&path)?;
            return Ok(());
        }
        let p = check_transcript(&path)?;
        let plain = p.to_string_lossy().trim_start_matches(r"\\?\").to_string();
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let status = Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:CHATVAULT_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')",
            ])
            .env("CHATVAULT_PATH", &plain)
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() || Path::new(&plain).exists() {
            return Err("The chat file could not be moved to the Recycle Bin".into());
        }
        index::forget(&path)?;
        index::forget(&plain)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn open_in_cursor(path: String) -> Result<(), String> {
    if !Path::new(&path).is_dir() {
        return Err("That folder no longer exists".into());
    }
    Command::new("cursor").arg(&path).spawn().map_err(|_| "Cursor could not be started. Is it installed?".to_string())?;
    Ok(())
}

#[tauri::command]
fn open_backup_folder() -> Result<(), String> {
    let b = backup_root().ok_or("No Documents folder")?;
    fs::create_dir_all(&b).map_err(|e| e.to_string())?;
    Command::new("explorer").arg(&b).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_in_claude(local_id: String) -> Result<(), String> {
    if !local_id.starts_with("local_") || !local_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err("Invalid session id".into());
    }
    Command::new("cmd")
        .args(["/C", "start", "", &format!("claude://claude.ai/epitaxy/{}", local_id)])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn save_markdown(title: String, markdown: String) -> Result<String, String> {
    let dir = home().ok_or("No user profile")?.join("Desktop").join("Claude Chats");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = title.chars().map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' { c } else { '_' }).collect();
    let file = dir.join(format!("{}.md", clip(safe.trim(), 60).trim_end_matches('…')));
    fs::write(&file, markdown).map_err(|e| e.to_string())?;
    Command::new("explorer").arg(format!("/select,{}", file.to_string_lossy())).spawn().map_err(|e| e.to_string())?;
    Ok(file.to_string_lossy().to_string())
}

#[tauri::command]
fn save_handoff(title: String, content: String) -> Result<String, String> {
    let dir = home().ok_or("No user profile")?.join("Documents").join("ChatVault Handoffs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = title.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let file = dir.join(format!("{}-{}.md", clip(&safe, 40).trim_end_matches('…'), stamp));
    fs::write(&file, content).map_err(|e| e.to_string())?;
    Ok(file.to_string_lossy().to_string())
}

const HANDOFF_PROMPT: &str = "It is the transcript of an earlier AI coding session on this project. Continue the work from exactly where it stopped, and follow the project rules it mentions.";

/// Opens a new PowerShell window in the chat's folder and starts Claude Code or Codex there.
/// agent: claude | claude-fork | claude-handoff | codex-resume | codex-fork | codex-handoff
#[tauri::command]
fn launch_agent(agent: String, id: String, cwd: Option<String>, handoff: Option<String>) -> Result<(), String> {
    let dir = cwd
        .filter(|c| Path::new(c).is_dir())
        .map(PathBuf::from)
        .or_else(home)
        .ok_or("No folder to start in")?;
    let handoff_path = |h: Option<String>| -> Result<String, String> {
        let path = h.ok_or("Missing handoff file")?;
        if path.contains('\'') || !Path::new(&path).is_file() {
            return Err("Invalid handoff file".into());
        }
        Ok(path)
    };
    let script = match agent.as_str() {
        "claude" | "claude-fork" => {
            if !valid_id(&id) {
                return Err("Invalid chat id".into());
            }
            let fork = if agent == "claude-fork" { " --fork-session" } else { "" };
            format!("claude --resume {}{}", id, fork)
        }
        "claude-handoff" => {
            let path = handoff_path(handoff)?;
            let folder = Path::new(&path).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
            format!("claude --add-dir '{}' 'Read the file {} completely. {}'", folder, path, HANDOFF_PROMPT)
        }
        "codex-resume" | "codex-fork" => {
            if !valid_id(&id) {
                return Err("Invalid chat id".into());
            }
            format!("codex {} {}", if agent == "codex-fork" { "fork" } else { "resume" }, id)
        }
        "codex-handoff" => {
            let path = handoff_path(handoff)?;
            format!("codex 'Read the file {} completely. {}'", path, HANDOFF_PROMPT)
        }
        _ => return Err("Unknown agent".into()),
    };
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    Command::new("powershell")
        .args(["-NoLogo", "-NoExit", "-Command", &script])
        .current_dir(dir)
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountInfo {
    id: String,
    orgs: usize,
    desktop_current: bool,
    cli_current: bool,
    email: Option<String>,
    name: Option<String>,
    plan: Option<String>,
}

/// What can be learned locally about each Claude account folder. Only the account the
/// Claude Code CLI is signed in to has an email on disk.
#[tauri::command]
fn account_info() -> Vec<AccountInfo> {
    let desktop_current = env_path("APPDATA")
        .map(|p| p.join("Claude").join("config.json"))
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("lastKnownAccountUuid").and_then(|x| x.as_str()).map(String::from));
    let cli = home()
        .map(|p| p.join(".claude.json"))
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("oauthAccount").cloned());
    let cli_id = cli.as_ref().and_then(|o| o.get("accountUuid")).and_then(|x| x.as_str()).map(String::from);
    let get = |k: &str| cli.as_ref().and_then(|o| o.get(k)).and_then(|x| x.as_str()).map(String::from);
    let Some(root) = claude_meta() else { return Vec::new() };
    subdirs(&root)
        .into_iter()
        .filter_map(|d| {
            let id = d.file_name()?.to_string_lossy().to_string();
            let is_cli = cli_id.as_deref() == Some(id.as_str());
            Some(AccountInfo {
                orgs: subdirs(&d).len(),
                desktop_current: desktop_current.as_deref() == Some(id.as_str()),
                cli_current: is_cli,
                email: if is_cli { get("emailAddress") } else { None },
                name: if is_cli { get("displayName") } else { None },
                plan: if is_cli { get("organizationType") } else { None },
                id,
            })
        })
        .collect()
}

#[tauri::command]
async fn sync_chats(app: AppHandle) -> Result<sync::SyncStats, String> {
    tauri::async_runtime::spawn_blocking(move || sync::backup(&app)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn restore_chats(app: AppHandle) -> Result<sync::SyncStats, String> {
    tauri::async_runtime::spawn_blocking(move || sync::restore(&app)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn backup_status() -> Result<sync::BackupStatus, String> {
    tauri::async_runtime::spawn_blocking(sync::status).await.map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            refresh_index,
            query_chats,
            provider_overview,
            chats_by_ids,
            overview_stats,
            read_chat_page,
            read_chat_tail,
            chat_stamp,
            chat_stamps,
            chat_outline,
            cursor_fingerprint,
            files_fingerprint,
            send_message,
            agent_running,
            take_agent_error,
            agent_login,
            stop_agent,
            fork_chat,
            read_chat_all,
            deep_search,
            reveal_in_folder,
            open_folder,
            open_backup_folder,
            open_in_cursor,
            delete_chat,
            open_in_claude,
            save_markdown,
            save_handoff,
            launch_agent,
            account_info,
            sync_chats,
            restore_chats,
            backup_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn indexes_and_reads_real_chats() {
        let t = Instant::now();
        index::refresh(None).unwrap();
        println!("refresh: {:?}", t.elapsed());
        let t = Instant::now();
        index::refresh(None).unwrap();
        println!("second refresh (no changes): {:?}", t.elapsed());
        for prov in ["claude", "codex", "cursor"] {
            let o = index::overview(prov).unwrap();
            println!("{prov}: {} chats, accounts {:?}", o.total, o.accounts.iter().map(|a| (a.id.chars().take(8).collect::<String>(), a.count)).collect::<Vec<_>>());
            assert!(o.total > 0, "{prov} has chats");
            let t = Instant::now();
            let page = index::query(prov, None, "", 0, 20, "recent", "all").unwrap();
            println!("  page of {} in {:?}, first: {:?}", page.items.len(), t.elapsed(), page.items.first().map(|c| c.title.clone()));
            let page = index::query(prov, None, "fuel", 0, 5, "recent", "all").unwrap();
            println!("  search 'fuel': {} total", page.total);
        }
        // The biggest codex rollout must still page quickly.
        let big = index::query("codex", None, "", 0, 200, "recent", "all").unwrap().items.into_iter().max_by_key(|c| c.size).unwrap();
        println!("biggest codex chat: {} ({} MB)", big.title, big.size / 1_000_000);
        let t = Instant::now();
        let mut n = 0;
        let mut text = 0;
        for line in open_lines(Path::new(&big.path)).unwrap() {
            if !relevant("codex", &line) { continue; }
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                for m in messages_for("codex", &v) { n += 1; if m.kind == "text" { text += 1; } }
            }
        }
        println!("  parsed {} messages ({} text) in {:?}", n, text, t.elapsed());
        assert!(text > 0);
    }
}
