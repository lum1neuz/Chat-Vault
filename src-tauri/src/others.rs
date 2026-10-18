//! Gemini CLI, OpenCode and Cline chats. Each keeps plain, readable files, so they are read directly:
//! - Gemini CLI: `~/.gemini/tmp/<project>/chats/session-*.json`
//! - OpenCode: the SQLite file `~/.local/share/opencode/opencode.db` (sessions, messages and parts)
//! - Cline: `~/.cline/data/sessions/<id>/<id>.messages.json` with a `<id>.json` summary beside it

use crate::paths::*;
use crate::providers::{clip, Msg};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

pub const TOOLS: [&str; 4] = ["gemini", "opencode", "cline", "claudeai"];

pub struct OtherChat {
    pub provider: &'static str,
    pub id: String,
    pub title: String,
    pub cwd: Option<String>,
    pub created_ms: Option<i64>,
    pub last_ms: i64,
    pub size: i64,
    pub path: String,
    pub model: Option<String>,
}

fn ms_of(iso: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(iso).ok().map(|d| d.timestamp_millis())
}

fn mtime(p: &Path) -> i64 {
    fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn open_ro(path: &Path) -> Option<Connection> {
    let p = path.to_string_lossy().replace('\\', "/").replace(' ', "%20").replace('#', "%23");
    Connection::open_with_flags(format!("file:{}?mode=ro", p), OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_READ_ONLY).ok()
}

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(p).ok()?).ok()
}

// ---------------- Gemini CLI ----------------

fn gemini_files() -> Vec<PathBuf> {
    let Some(tmp) = home().map(|h| h.join(".gemini").join("tmp")) else { return Vec::new() };
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(&tmp) else { return out };
    for proj in rd.flatten() {
        let chats = proj.path().join("chats");
        if let Ok(files) = fs::read_dir(&chats) {
            for f in files.flatten() {
                let p = f.path();
                if p.extension().map(|e| e == "json").unwrap_or(false) {
                    out.push(p);
                }
            }
        }
    }
    out
}

/// The text of a Gemini user turn: the typed text when it is recorded, otherwise the first text part of the content.
fn gemini_user_text(m: &Value) -> String {
    let flat = |v: &Value| -> String {
        match v {
            Value::String(s) => s.clone(),
            Value::Array(a) => a.iter().filter_map(|p| p.get("text").and_then(|t| t.as_str())).collect::<Vec<_>>().join("\n"),
            _ => String::new(),
        }
    };
    let shown = m.get("displayContent").map(flat).unwrap_or_default();
    if !shown.trim().is_empty() {
        return shown;
    }
    m.get("content").map(flat).unwrap_or_default()
}

fn gemini_project(p: &Path) -> Option<String> {
    let root = p.parent()?.parent()?.join(".project_root");
    fs::read_to_string(root).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn gemini_messages(p: &Path) -> Vec<Msg> {
    let Some(j) = read_json(p) else { return Vec::new() };
    let mut out = Vec::new();
    for m in j.get("messages").and_then(|m| m.as_array()).cloned().unwrap_or_default() {
        let ts = m.get("timestamp").and_then(|t| t.as_str()).unwrap_or("").to_string();
        match m.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            "user" => {
                let t = gemini_user_text(&m);
                if !t.trim().is_empty() {
                    out.push(Msg::new("user", &ts, t, "text"));
                }
            }
            "gemini" => {
                if let Some(thoughts) = m.get("thoughts").and_then(|t| t.as_array()) {
                    let text: Vec<String> = thoughts
                        .iter()
                        .map(|t| format!("{}: {}", t.get("subject").and_then(|x| x.as_str()).unwrap_or(""), t.get("description").and_then(|x| x.as_str()).unwrap_or("")))
                        .collect();
                    if !text.is_empty() {
                        out.push(Msg::new("assistant", &ts, clip(&text.join("\n"), 6000), "reasoning"));
                    }
                }
                let t = m.get("content").and_then(|c| c.as_str()).unwrap_or("");
                if !t.trim().is_empty() {
                    out.push(Msg::new("assistant", &ts, t.to_string(), "text"));
                }
                for call in m.get("toolCalls").and_then(|c| c.as_array()).cloned().unwrap_or_default() {
                    let name = call.get("name").and_then(|n| n.as_str()).unwrap_or("tool").to_string();
                    let id = call.get("id").and_then(|n| n.as_str()).map(String::from);
                    let mut tool = Msg::new("assistant", &ts, format!("{}:", name), "tool");
                    tool.name = Some(name);
                    tool.id = id.clone();
                    tool.data = call.get("args").cloned();
                    out.push(tool);
                    let result = call.get("resultDisplay").and_then(|r| r.as_str()).map(String::from).or_else(|| call.get("result").map(|r| clip(&r.to_string(), 4000)));
                    if let Some(r) = result.filter(|r| !r.trim().is_empty()) {
                        let mut res = Msg::new("assistant", &ts, clip(&r, 8000), "result");
                        res.id = id;
                        out.push(res);
                    }
                }
            }
            "error" => {
                let t = m.get("content").and_then(|c| c.as_str()).unwrap_or("");
                if !t.trim().is_empty() {
                    let mut e = Msg::new("assistant", &ts, t.to_string(), "text");
                    e.error = Some(true);
                    out.push(e);
                }
            }
            _ => {}
        }
    }
    out
}

fn scan_gemini(out: &mut Vec<OtherChat>) {
    for p in gemini_files() {
        let Some(j) = read_json(&p) else { continue };
        let msgs = gemini_messages(&p);
        let Some(first) = msgs.iter().find(|m| m.role == "user") else { continue };
        let first_line = first.text.lines().find(|l| !l.trim().is_empty()).unwrap_or("Chat").trim();
        let id = j.get("sessionId").and_then(|s| s.as_str()).map(String::from).unwrap_or_else(|| p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default());
        out.push(OtherChat {
            provider: "gemini",
            id,
            title: clip(first_line, 80),
            cwd: gemini_project(&p),
            created_ms: j.get("startTime").and_then(|s| s.as_str()).and_then(ms_of),
            last_ms: j.get("lastUpdated").and_then(|s| s.as_str()).and_then(ms_of).unwrap_or_else(|| mtime(&p)),
            size: fs::metadata(&p).map(|m| m.len() as i64).unwrap_or(0),
            path: format!("gemini:{}", p.to_string_lossy()),
            model: None,
        });
    }
}

// ---------------- OpenCode ----------------

fn opencode_db() -> Option<PathBuf> {
    let p = home()?.join(".local").join("share").join("opencode").join("opencode.db");
    p.exists().then_some(p)
}

fn scan_opencode(out: &mut Vec<OtherChat>) {
    let Some(db) = opencode_db() else { return };
    let Some(c) = open_ro(&db) else { return };
    let Ok(mut st) = c.prepare("SELECT s.id, s.title, s.directory, s.time_created, s.time_updated, (SELECT COUNT(*) FROM message m WHERE m.session_id=s.id) FROM session s") else { return };
    let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?, r.get::<_, i64>(5)?)));
    let Ok(rows) = rows else { return };
    for (id, title, dir, created, updated, n) in rows.flatten() {
        if n == 0 {
            continue;
        }
        out.push(OtherChat {
            provider: "opencode",
            id: id.clone(),
            title: clip(title.trim(), 80),
            cwd: dir.filter(|d| d != "/" && !d.is_empty()),
            created_ms: Some(created),
            last_ms: updated.max(created),
            size: n * 2000,
            path: format!("opencode:{}", id),
            model: None,
        });
    }
}

fn opencode_messages(id: &str) -> Vec<Msg> {
    let Some(db) = opencode_db() else { return Vec::new() };
    let Some(c) = open_ro(&db) else { return Vec::new() };
    let Ok(mut st) = c.prepare("SELECT m.id, m.time_created, m.data FROM message m WHERE m.session_id=?1 ORDER BY m.time_created") else { return Vec::new() };
    let msgs: Vec<(String, i64, String)> = st.query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map(|r| r.flatten().collect()).unwrap_or_default();
    let mut out = Vec::new();
    for (mid, created, data) in msgs {
        let role = serde_json::from_str::<Value>(&data).ok().and_then(|v| v.get("role").and_then(|r| r.as_str()).map(String::from)).unwrap_or_else(|| "assistant".into());
        let role = if role == "user" { "user" } else { "assistant" };
        let ts = chrono::DateTime::from_timestamp_millis(created).map(|d| d.to_rfc3339()).unwrap_or_default();
        let Ok(mut ps) = c.prepare("SELECT data FROM part WHERE message_id=?1 ORDER BY time_created") else { continue };
        let parts: Vec<String> = ps.query_map([&mid], |r| r.get(0)).map(|r| r.flatten().collect()).unwrap_or_default();
        for pd in parts {
            let Ok(p) = serde_json::from_str::<Value>(&pd) else { continue };
            match p.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                "text" => {
                    if p.get("synthetic").and_then(|s| s.as_bool()) == Some(true) {
                        continue;
                    }
                    let t = p.get("text").and_then(|t| t.as_str()).unwrap_or("");
                    if !t.trim().is_empty() {
                        out.push(Msg::new(role, &ts, t.to_string(), "text"));
                    }
                }
                "reasoning" => {
                    let t = p.get("text").and_then(|t| t.as_str()).unwrap_or("");
                    if !t.trim().is_empty() {
                        out.push(Msg::new("assistant", &ts, clip(t, 6000), "reasoning"));
                    }
                }
                "tool" => {
                    let name = p.get("tool").and_then(|t| t.as_str()).unwrap_or("tool").to_string();
                    let cid = p.get("callID").and_then(|t| t.as_str()).map(String::from);
                    let mut tool = Msg::new("assistant", &ts, format!("{}:", name), "tool");
                    tool.name = Some(name);
                    tool.id = cid.clone();
                    tool.data = p.get("state").and_then(|s| s.get("input")).cloned();
                    out.push(tool);
                    if let Some(o) = p.get("state").and_then(|s| s.get("output")).and_then(|o| o.as_str()).filter(|o| !o.trim().is_empty()) {
                        let mut res = Msg::new("assistant", &ts, clip(o, 8000), "result");
                        res.id = cid;
                        out.push(res);
                    }
                }
                _ => {}
            }
        }
    }
    out
}

// ---------------- Cline ----------------

fn cline_sessions() -> Vec<PathBuf> {
    let Some(root) = home().map(|h| h.join(".cline").join("data").join("sessions")) else { return Vec::new() };
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(&root) else { return out };
    for d in rd.flatten() {
        if let Ok(files) = fs::read_dir(d.path()) {
            for f in files.flatten() {
                let p = f.path();
                if p.file_name().map(|n| n.to_string_lossy().ends_with(".messages.json")).unwrap_or(false) {
                    out.push(p);
                }
            }
        }
    }
    out
}

/// Cline stores each message's content as a list of blocks (text, thinking, tool calls and tool results).
fn blocks(v: &Value) -> Vec<Value> {
    match v {
        Value::Array(a) => a.clone(),
        Value::String(s) => serde_json::from_str::<Value>(s).ok().and_then(|x| x.as_array().cloned()).unwrap_or_else(|| vec![serde_json::json!({"type":"text","text":s})]),
        _ => Vec::new(),
    }
}

fn clean_cline_text(t: &str) -> String {
    let t = t.trim();
    // user turns are wrapped like <user_input mode="act">…</user_input>
    if let Some(a) = t.find("<user_input") {
        if let Some(open_end) = t[a..].find('>') {
            let inner = &t[a + open_end + 1..];
            return inner.split("</user_input>").next().unwrap_or(inner).trim().to_string();
        }
    }
    t.to_string()
}

fn cline_messages(p: &Path) -> Vec<Msg> {
    let Some(j) = read_json(p) else { return Vec::new() };
    let mut out = Vec::new();
    for m in j.get("messages").and_then(|m| m.as_array()).cloned().unwrap_or_default() {
        let role = if m.get("role").and_then(|r| r.as_str()) == Some("user") { "user" } else { "assistant" };
        let ts = m.get("ts").and_then(|t| t.as_str().map(String::from).or_else(|| t.as_i64().map(|n| n.to_string()))).and_then(|s| s.parse::<i64>().ok()).and_then(chrono::DateTime::from_timestamp_millis).map(|d| d.to_rfc3339()).unwrap_or_default();
        for b in blocks(m.get("content").unwrap_or(&Value::Null)) {
            match b.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                "text" => {
                    let t = clean_cline_text(b.get("text").and_then(|t| t.as_str()).unwrap_or(""));
                    if !t.is_empty() {
                        out.push(Msg::new(role, &ts, t, "text"));
                    }
                }
                "thinking" => {
                    let t = b.get("thinking").and_then(|t| t.as_str()).unwrap_or("");
                    if !t.trim().is_empty() {
                        out.push(Msg::new("assistant", &ts, clip(t, 6000), "reasoning"));
                    }
                }
                "tool_use" => {
                    let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("tool").to_string();
                    let mut tool = Msg::new("assistant", &ts, format!("{}:", name), "tool");
                    tool.name = Some(name);
                    tool.id = b.get("id").and_then(|n| n.as_str()).map(String::from);
                    tool.data = b.get("input").cloned();
                    out.push(tool);
                }
                "tool_result" => {
                    let raw = b.get("content").cloned().unwrap_or(Value::Null);
                    let text = match &raw {
                        Value::String(s) => s.clone(),
                        Value::Array(a) => a.iter().filter_map(|x| x.get("text").and_then(|t| t.as_str())).collect::<Vec<_>>().join("\n"),
                        other => other.to_string(),
                    };
                    if !text.trim().is_empty() {
                        let mut res = Msg::new("assistant", &ts, clip(&text, 8000), "result");
                        res.id = b.get("tool_use_id").and_then(|n| n.as_str()).map(String::from);
                        out.push(res);
                    }
                }
                _ => {}
            }
        }
    }
    out
}

fn scan_cline(out: &mut Vec<OtherChat>) {
    for p in cline_sessions() {
        let msgs = cline_messages(&p);
        let Some(first) = msgs.iter().find(|m| m.role == "user") else { continue };
        let meta = p.with_file_name(p.file_name().map(|n| n.to_string_lossy().replace(".messages.json", ".json")).unwrap_or_default());
        let mj = read_json(&meta);
        let started = mj.as_ref().and_then(|m| m.get("started_at")).and_then(|s| s.as_str()).and_then(ms_of);
        let ended = mj.as_ref().and_then(|m| m.get("ended_at")).and_then(|s| s.as_str()).and_then(ms_of);
        let id = p.parent().and_then(|d| d.file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        out.push(OtherChat {
            provider: "cline",
            id,
            title: clip(first.text.lines().find(|l| !l.trim().is_empty()).unwrap_or("Chat").trim(), 80),
            cwd: mj.as_ref().and_then(|m| m.get("cwd")).and_then(|s| s.as_str()).map(String::from),
            created_ms: started,
            last_ms: ended.or(started).unwrap_or_else(|| mtime(&p)),
            size: fs::metadata(&p).map(|m| m.len() as i64).unwrap_or(0),
            path: format!("cline:{}", p.to_string_lossy()),
            model: mj.as_ref().and_then(|m| m.get("model")).and_then(|s| s.as_str()).map(String::from),
        });
    }
}

// ---------------- Claude Chat (claude.ai) ----------------
// These chats are not kept on the PC. They come from the claude.ai data export (Settings > Privacy > Export data),
// split into one file per conversation inside the backup folder, so a shared backup folder brings them to the other PC.

fn claudeai_dir() -> Option<PathBuf> {
    backup_root().map(|b| b.join("claude-chat"))
}

fn claudeai_files() -> Vec<PathBuf> {
    let Some(d) = claudeai_dir() else { return Vec::new() };
    fs::read_dir(d)
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.extension().map(|e| e == "json").unwrap_or(false)).collect())
        .unwrap_or_default()
}

pub fn claudeai_count() -> usize {
    claudeai_files().len()
}

fn claudeai_messages(p: &Path) -> Vec<Msg> {
    read_json(p).map(|j| claudeai_msgs(&j)).unwrap_or_default()
}

fn claudeai_msgs(j: &Value) -> Vec<Msg> {
    let mut out = Vec::new();
    for m in j.get("chat_messages").and_then(|m| m.as_array()).cloned().unwrap_or_default() {
        let role = if m.get("sender").and_then(|s| s.as_str()) == Some("human") { "user" } else { "assistant" };
        let ts = m.get("created_at").and_then(|t| t.as_str()).unwrap_or("").to_string();
        let parts = m.get("content").and_then(|c| c.as_array()).cloned().unwrap_or_default();
        let before = out.len();
        for b in &parts {
            match b.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                "text" => {
                    let t = b.get("text").and_then(|t| t.as_str()).unwrap_or("");
                    if !t.trim().is_empty() {
                        out.push(Msg::new(role, &ts, t.to_string(), "text"));
                    }
                }
                "thinking" => {
                    let t = b.get("thinking").and_then(|t| t.as_str()).unwrap_or("");
                    if !t.trim().is_empty() {
                        out.push(Msg::new("assistant", &ts, clip(t, 6000), "reasoning"));
                    }
                }
                "tool_use" => {
                    let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("tool").to_string();
                    let mut tool = Msg::new("assistant", &ts, format!("{}:", name), "tool");
                    tool.name = Some(name);
                    tool.id = b.get("id").and_then(|n| n.as_str()).map(String::from);
                    tool.data = b.get("input").cloned();
                    out.push(tool);
                }
                "tool_result" => {
                    let text = match b.get("content").cloned().unwrap_or(Value::Null) {
                        Value::String(s) => s,
                        Value::Array(a) => a.iter().filter_map(|x| x.get("text").and_then(|t| t.as_str())).collect::<Vec<_>>().join("\n"),
                        other => other.to_string(),
                    };
                    if !text.trim().is_empty() {
                        let mut res = Msg::new("assistant", &ts, clip(&text, 8000), "result");
                        res.id = b.get("tool_use_id").and_then(|n| n.as_str()).map(String::from);
                        out.push(res);
                    }
                }
                _ => {}
            }
        }
        // Older exports only have the flat text.
        if out.len() == before {
            let t = m.get("text").and_then(|t| t.as_str()).unwrap_or("");
            if !t.trim().is_empty() {
                out.push(Msg::new(role, &ts, t.to_string(), "text"));
            }
        }
        for a in m.get("attachments").and_then(|a| a.as_array()).cloned().unwrap_or_default() {
            let name = a.get("file_name").and_then(|n| n.as_str()).unwrap_or("file");
            let body = a.get("extracted_content").and_then(|c| c.as_str()).unwrap_or("");
            out.push(Msg::new(role, &ts, clip(&format!("Attached {name}\n\n{body}"), 8000), "text"));
        }
    }
    out
}

fn scan_claudeai(out: &mut Vec<OtherChat>) {
    for p in claudeai_files() {
        let Some(j) = read_json(&p) else { continue };
        let msgs = claudeai_msgs(&j);
        let Some(first) = msgs.iter().find(|m| m.role == "user") else { continue };
        let s = |k: &str| j.get(k).and_then(|x| x.as_str()).map(String::from);
        let name = s("name").filter(|n| !n.trim().is_empty());
        let created = s("created_at").as_deref().and_then(ms_of);
        out.push(OtherChat {
            provider: "claudeai",
            id: s("uuid").unwrap_or_else(|| p.file_stem().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()),
            title: clip(name.as_deref().unwrap_or_else(|| first.text.lines().find(|l| !l.trim().is_empty()).unwrap_or("Chat")).trim(), 80),
            cwd: None,
            created_ms: created,
            last_ms: s("updated_at").as_deref().and_then(ms_of).or(created).unwrap_or_else(|| mtime(&p)),
            size: fs::metadata(&p).map(|m| m.len() as i64).unwrap_or(0),
            path: format!("claudeai:{}", p.to_string_lossy()),
            model: None,
        });
    }
}

fn find_file(dir: &Path, name: &str) -> Option<PathBuf> {
    for e in fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.is_dir() {
            if let Some(f) = find_file(&p, name) {
                return Some(f);
            }
        } else if p.file_name().map(|n| n == name).unwrap_or(false) {
            return Some(p);
        }
    }
    None
}

/// Takes in a claude.ai export: the .zip itself or the conversations.json inside it. A conversation already imported
/// is replaced only when the export has a newer version. Returns (new, updated).
pub fn import_claudeai(path: &Path) -> Result<(usize, usize), String> {
    let dir = claudeai_dir().ok_or("No backup folder")?;
    let is_zip = path.extension().map(|e| e.eq_ignore_ascii_case("zip")).unwrap_or(false);
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let tmp = std::env::temp_dir().join(format!("chatvault-import-{}-{stamp}", std::process::id()));
    // ponytail: the whole conversations.json is parsed in memory; a streaming parser would suit multi-GB exports.
    let json = if is_zip {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = fs::remove_dir_all(&tmp);
        let ok = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", "Expand-Archive -LiteralPath $env:CV_ZIP -DestinationPath $env:CV_OUT -Force"])
            .env("CV_ZIP", path)
            .env("CV_OUT", &tmp)
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !ok {
            return Err("The zip could not be opened".into());
        }
        find_file(&tmp, "conversations.json").ok_or("No conversations.json in that zip. Is it a claude.ai export?")?
    } else {
        path.to_path_buf()
    };
    let result = (|| {
        let all: Value = serde_json::from_str(&fs::read_to_string(&json).map_err(|e| e.to_string())?).map_err(|_| "That file is not a claude.ai export".to_string())?;
        let convs = all.as_array().ok_or("That file is not a claude.ai export")?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let (mut added, mut updated) = (0, 0);
        for c in convs {
            let Some(id) = c.get("uuid").and_then(|x| x.as_str()).filter(|i| !i.is_empty() && i.len() <= 64 && i.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-')) else { continue };
            if c.get("chat_messages").and_then(|m| m.as_array()).map(|a| a.is_empty()).unwrap_or(true) {
                continue;
            }
            let target = dir.join(format!("{id}.json"));
            let newer = c.get("updated_at").and_then(|x| x.as_str()).and_then(ms_of);
            let existed = target.exists();
            let had = read_json(&target).and_then(|o| o.get("updated_at").and_then(|x| x.as_str()).and_then(ms_of));
            if existed && !(newer.is_some() && newer > had) {
                continue;
            }
            let part = target.with_extension("json.tmp");
            fs::write(&part, c.to_string()).map_err(|e| e.to_string())?;
            fs::rename(&part, &target).map_err(|e| e.to_string())?;
            if existed { updated += 1 } else { added += 1 }
        }
        Ok((added, updated))
    })();
    if is_zip {
        let _ = fs::remove_dir_all(&tmp);
    }
    result
}

// ---------------- shared ----------------

pub fn scan() -> Vec<OtherChat> {
    let mut out = Vec::new();
    scan_gemini(&mut out);
    scan_opencode(&mut out);
    scan_cline(&mut out);
    scan_claudeai(&mut out);
    out
}

/// Changes whenever any of these tools writes a chat, so the index can skip a rescan when nothing changed.
pub fn fingerprint() -> i64 {
    let mut m = 0;
    for p in gemini_files() {
        m = m.max(mtime(&p));
    }
    for p in cline_sessions().into_iter().chain(claudeai_files()) {
        m = m.max(mtime(&p));
    }
    if let Some(db) = opencode_db() {
        m = m.max(mtime(&db));
        let mut wal = db.into_os_string();
        wal.push("-wal");
        m = m.max(mtime(Path::new(&wal)));
    }
    m
}

pub fn read(path: &str) -> Result<Vec<Msg>, String> {
    if let Some(p) = path.strip_prefix("gemini:") {
        return Ok(gemini_messages(Path::new(p)));
    }
    if let Some(id) = path.strip_prefix("opencode:") {
        return Ok(opencode_messages(id));
    }
    if let Some(p) = path.strip_prefix("cline:") {
        return Ok(cline_messages(Path::new(p)));
    }
    if let Some(p) = path.strip_prefix("claudeai:") {
        return Ok(claudeai_messages(Path::new(p)));
    }
    Err("Unknown chat".into())
}

pub fn is_virtual(path: &str) -> bool {
    TOOLS.iter().any(|t| path.starts_with(&format!("{t}:")))
}

/// The real file behind a virtual path, for "show file".
pub fn real_file(path: &str) -> Option<PathBuf> {
    if let Some(p) = path.strip_prefix("gemini:").or_else(|| path.strip_prefix("cline:")).or_else(|| path.strip_prefix("claudeai:")) {
        let p = PathBuf::from(p);
        return p.exists().then_some(p);
    }
    if path.starts_with("opencode:") {
        return opencode_db();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "changes USERPROFILE for the whole process; run alone with --ignored"]
    fn imports_a_claude_ai_export() {
        let t = std::env::temp_dir().join("chatvault-claudeai-test");
        let _ = fs::remove_dir_all(&t);
        unsafe {
            std::env::set_var("USERPROFILE", &t);
            std::env::set_var("LOCALAPPDATA", t.join("Local"));
        }
        set_backup_root(&t.join("drive")).unwrap();
        let export = |updated: &str| {
            serde_json::json!([
                {"uuid": "aaaa-1", "name": "Trip plan", "created_at": "2026-01-01T10:00:00Z", "updated_at": updated, "chat_messages": [
                    {"sender": "human", "created_at": "2026-01-01T10:00:00Z", "text": "", "content": [{"type": "text", "text": "Plan a trip"}],
                     "attachments": [{"file_name": "notes.txt", "extracted_content": "Ulaanbaatar"}]},
                    {"sender": "assistant", "created_at": "2026-01-01T10:00:05Z", "text": "", "content": [{"type": "thinking", "thinking": "hmm"}, {"type": "text", "text": "Sure."}]}
                ]},
                {"uuid": "bbbb-2", "name": "", "created_at": "2026-01-02T10:00:00Z", "updated_at": "2026-01-02T10:00:00Z", "chat_messages": [
                    {"sender": "human", "created_at": "2026-01-02T10:00:00Z", "text": "Old style text only"}
                ]},
                {"uuid": "cccc-3", "name": "Empty", "created_at": "2026-01-03T10:00:00Z", "updated_at": "2026-01-03T10:00:00Z", "chat_messages": []},
                {"uuid": "../evil", "name": "Bad id", "chat_messages": [{"sender": "human", "text": "x"}]}
            ])
        };
        let file = t.join("conversations.json");
        fs::create_dir_all(&t).unwrap();
        fs::write(&file, export("2026-01-01T11:00:00Z").to_string()).unwrap();
        assert_eq!(import_claudeai(&file).unwrap(), (2, 0));
        assert_eq!(import_claudeai(&file).unwrap(), (0, 0), "an unchanged export adds nothing");
        fs::write(&file, export("2026-01-05T11:00:00Z").to_string()).unwrap();
        assert_eq!(import_claudeai(&file).unwrap(), (0, 1), "a newer version replaces the old one");

        let mut chats = Vec::new();
        scan_claudeai(&mut chats);
        chats.sort_by(|a, b| a.id.cmp(&b.id));
        assert_eq!(chats.iter().map(|c| c.title.as_str()).collect::<Vec<_>>(), ["Trip plan", "Old style text only"]);
        let msgs = read(&chats[0].path).unwrap();
        let kinds: Vec<_> = msgs.iter().map(|m| (m.role.as_str(), m.kind.as_str())).collect();
        assert_eq!(kinds, [("user", "text"), ("user", "text"), ("assistant", "reasoning"), ("assistant", "text")]);
        assert!(msgs[1].text.contains("notes.txt"));
        assert!(!t.join("drive").join("ChatVault Backup").join("claude-chat").join("..").join("evil.json").exists());
        let _ = fs::remove_dir_all(&t);
    }
}
