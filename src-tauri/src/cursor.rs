//! Cursor chats. The IDE keeps older chats in a SQLite file (`composerData` plus one row per message),
//! and the Cursor CLI keeps each chat in its own `store.db`. Newer IDE agent chats are encrypted by
//! Cursor and cannot be read from outside, so they are not listed.

use crate::paths::*;
use crate::providers::{clip, Msg};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

pub struct CursorChat {
    pub id: String,
    pub title: String,
    pub cwd: Option<String>,
    pub created_ms: Option<i64>,
    pub last_ms: i64,
    pub size: i64,
    pub path: String,
    pub mtime: i64,
}

fn appdata_cursor() -> Option<PathBuf> {
    env_path("APPDATA").map(|p| p.join("Cursor").join("User"))
}

fn global_db() -> Option<PathBuf> {
    appdata_cursor().map(|p| p.join("globalStorage").join("state.vscdb"))
}

fn cli_root() -> Option<PathBuf> {
    home().map(|p| p.join(".cursor").join("chats"))
}

/// Opens a database that Cursor may be using, without taking any lock on it.
fn open_ro(path: &Path) -> Option<Connection> {
    let p = path.to_string_lossy().replace('\\', "/").replace(' ', "%20").replace('#', "%23");
    Connection::open_with_flags(format!("file:{}?mode=ro&immutable=1", p), OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_READ_ONLY).ok()
}

fn mtime_ms(p: &Path) -> i64 {
    fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() + 0 && i + 2 <= b.len() - 1 {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn folder_of(uri: &str) -> String {
    let t = pct_decode(uri.trim_start_matches("file:///"));
    t.replace('/', "\\")
}

fn workspace_folder(id: &str) -> Option<String> {
    let p = appdata_cursor()?.join("workspaceStorage").join(id).join("workspace.json");
    let v: Value = serde_json::from_str(&fs::read_to_string(p).ok()?).ok()?;
    v.get("folder").and_then(|f| f.as_str()).map(folder_of)
}

fn bubble_text(v: &Value) -> String {
    v.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string()
}

fn first_user_bubble(c: &Connection, composer: &str, headers: &[Value]) -> Option<String> {
    for h in headers {
        if h.get("type").and_then(|t| t.as_i64()) != Some(1) {
            continue;
        }
        let bid = h.get("bubbleId").and_then(|b| b.as_str())?;
        let raw: String = c
            .query_row("SELECT value FROM cursorDiskKV WHERE key=?1", [format!("bubbleId:{}:{}", composer, bid)], |r| r.get(0))
            .ok()?;
        let t = bubble_text(&serde_json::from_str::<Value>(&raw).ok()?);
        if !t.trim().is_empty() {
            return Some(clip(t.trim(), 80));
        }
    }
    None
}

fn scan_ide(out: &mut Vec<CursorChat>) {
    let Some(db) = global_db() else { return };
    let Some(c) = open_ro(&db) else { return };
    let mtime = mtime_ms(&db);
    // Workspace and update times live in a separate headers table.
    let mut heads = std::collections::HashMap::<String, (Option<String>, Option<i64>)>::new();
    if let Ok(mut st) = c.prepare("SELECT composerId, workspaceId, lastUpdatedAt FROM composerHeaders") {
        if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<i64>>(2)?))) {
            for (id, ws, up) in rows.flatten() {
                heads.insert(id, (ws, up));
            }
        }
    }
    let Ok(mut st) = c.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'") else { return };
    let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) else { return };
    for (key, raw) in rows.flatten() {
        let Ok(d) = serde_json::from_str::<Value>(&raw) else { continue };
        let headers = d.get("fullConversationHeadersOnly").and_then(|h| h.as_array()).cloned().unwrap_or_default();
        if headers.is_empty() {
            continue;
        }
        let id = key.trim_start_matches("composerData:").to_string();
        let name = d.get("name").and_then(|n| n.as_str()).filter(|n| !n.trim().is_empty()).map(String::from);
        let title = name.or_else(|| first_user_bubble(&c, &id, &headers)).unwrap_or_else(|| "Untitled".into());
        let (ws, updated) = heads.get(&id).cloned().unwrap_or((None, None));
        let created = d.get("createdAt").and_then(|x| x.as_i64());
        let cwd = ws.as_deref().filter(|w| *w != "empty-window").and_then(workspace_folder);
        out.push(CursorChat {
            path: format!("cursor-ide:{}", id),
            id,
            title,
            cwd,
            created_ms: created,
            last_ms: d.get("lastUpdatedAt").and_then(|x| x.as_i64()).or(updated).or(created).unwrap_or(mtime),
            size: raw.len() as i64,
            mtime,
        });
    }
}

fn cli_stores() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(root) = cli_root() {
        for a in subdirs(&root) {
            for b in subdirs(&a) {
                let s = b.join("store.db");
                if s.is_file() {
                    out.push(s);
                }
            }
        }
    }
    out
}

fn content_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter_map(|x| x.get("text").and_then(|t| t.as_str())).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

/// The CLI wraps the real request in <user_query> after a block of environment information.
fn user_query(text: &str) -> String {
    if let (Some(a), Some(b)) = (text.find("<user_query>"), text.find("</user_query>")) {
        if b > a {
            return text[a + 12..b].trim().to_string();
        }
    }
    text.trim().to_string()
}

fn cli_messages(path: &Path) -> Vec<Msg> {
    let mut out = Vec::new();
    let Some(c) = open_ro(path) else { return out };
    let Ok(mut st) = c.prepare("SELECT data FROM blobs ORDER BY rowid") else { return out };
    let Ok(rows) = st.query_map([], |r| r.get::<_, Vec<u8>>(0)) else { return out };
    let ts = mtime_ms(path);
    let iso = chrono_iso(ts);
    for data in rows.flatten() {
        let Ok(v) = serde_json::from_slice::<Value>(&data) else { continue };
        let role = v.get("role").and_then(|r| r.as_str()).unwrap_or("");
        let content = v.get("content").cloned().unwrap_or(Value::Null);
        match role {
            "user" => {
                let t = user_query(&content_text(&content));
                if !t.is_empty() && !t.starts_with("<user_info>") {
                    out.push(Msg::new("user", &iso, t, "text"));
                }
            }
            "assistant" => {
                let t = content_text(&content);
                if !t.trim().is_empty() {
                    out.push(Msg::new("assistant", &iso, t, "text"));
                }
            }
            _ => {}
        }
    }
    out
}

fn chrono_iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).map(|d| d.to_rfc3339()).unwrap_or_default()
}

fn scan_cli(out: &mut Vec<CursorChat>) {
    for store in cli_stores() {
        let msgs = cli_messages(&store);
        let Some(first) = msgs.iter().find(|m| m.role == "user") else { continue };
        let id = store.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let mtime = mtime_ms(&store);
        // The workspace path is written into the first user block.
        let cwd = open_ro(&store)
            .and_then(|c| {
                let mut st = c.prepare("SELECT data FROM blobs ORDER BY rowid LIMIT 4").ok()?;
                let rows = st.query_map([], |r| r.get::<_, Vec<u8>>(0)).ok()?;
                rows.flatten().find_map(|d| {
                    let v = serde_json::from_slice::<Value>(&d).ok()?;
                    let t = content_text(v.get("content")?);
                    let k = t.find("Workspace Path: ")?;
                    Some(t[k + 16..].lines().next()?.trim().to_string())
                })
            });
        out.push(CursorChat {
            path: format!("cursor-cli:{}", store.to_string_lossy()),
            id: format!("cli-{}", id),
            title: clip(first.text.lines().next().unwrap_or("Untitled"), 80),
            cwd,
            created_ms: None,
            last_ms: mtime,
            size: fs::metadata(&store).map(|m| m.len() as i64).unwrap_or(0),
            mtime,
        });
    }
}

pub fn scan() -> Vec<CursorChat> {
    let mut out = Vec::new();
    scan_ide(&mut out);
    scan_cli(&mut out);
    out
}

/// A fingerprint of the Cursor files, so the index can skip a rescan when nothing changed.
pub fn fingerprint() -> i64 {
    let a = global_db().map(|p| mtime_ms(&p)).unwrap_or(0);
    let b = cli_stores().iter().map(|p| mtime_ms(p)).max().unwrap_or(0);
    a.max(b)
}

/// The real file behind a virtual cursor path, for "show file".
pub fn real_file(path: &str) -> Option<PathBuf> {
    if path.starts_with("cursor-ide:") {
        return global_db();
    }
    let p = PathBuf::from(path.strip_prefix("cursor-cli:")?);
    let root = cli_root()?.canonicalize().ok()?;
    let canon = p.canonicalize().ok()?;
    canon.starts_with(root).then_some(canon)
}

pub fn read(path: &str) -> Result<Vec<Msg>, String> {
    if let Some(id) = path.strip_prefix("cursor-ide:") {
        let db = global_db().ok_or("Cursor is not installed")?;
        let c = open_ro(&db).ok_or("Cannot open the Cursor database")?;
        let raw: String = c
            .query_row("SELECT value FROM cursorDiskKV WHERE key=?1", [format!("composerData:{}", id)], |r| r.get(0))
            .map_err(|_| "That Cursor chat no longer exists".to_string())?;
        let d: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for h in d.get("fullConversationHeadersOnly").and_then(|h| h.as_array()).cloned().unwrap_or_default() {
            let Some(bid) = h.get("bubbleId").and_then(|b| b.as_str()) else { continue };
            let Ok(raw): Result<String, _> = c.query_row("SELECT value FROM cursorDiskKV WHERE key=?1", [format!("bubbleId:{}:{}", id, bid)], |r| r.get(0)) else {
                continue;
            };
            let Ok(b) = serde_json::from_str::<Value>(&raw) else { continue };
            let role = if b.get("type").and_then(|t| t.as_i64()) == Some(1) { "user" } else { "assistant" };
            let ts = b.get("createdAt").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let text = bubble_text(&b);
            if !text.trim().is_empty() {
                out.push(Msg::new(role, &ts, text, "text"));
            }
            if let Some(tool) = b.get("toolFormerData").and_then(|t| t.get("name")).and_then(|n| n.as_str()) {
                let mut m = Msg::new("assistant", &ts, format!("{}:", tool), "tool");
                m.name = Some(tool.to_string());
                out.push(m);
            }
        }
        return Ok(out);
    }
    let store = real_file(path).ok_or("That is not a Cursor chat")?;
    Ok(cli_messages(&store))
}
