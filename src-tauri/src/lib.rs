use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChatSummary {
    id: String,
    local_id: Option<String>,
    title: String,
    account: String,
    project: String,
    cwd: Option<String>,
    created_ms: Option<i64>,
    last_ms: i64,
    archived: bool,
    size: u64,
    path: String,
    model: Option<String>,
    has_metadata: bool,
}

#[derive(Serialize)]
struct Msg {
    role: String,
    ts: String,
    text: String,
    kind: String,
}

#[derive(Serialize)]
struct SearchHit {
    id: String,
    snippet: String,
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from)
}

fn projects_dir() -> Option<PathBuf> {
    env_path("USERPROFILE").map(|p| p.join(".claude").join("projects"))
}

fn sessions_dir() -> Option<PathBuf> {
    env_path("APPDATA").map(|p| p.join("Claude").join("claude-code-sessions"))
}

fn subdirs(p: &Path) -> Vec<PathBuf> {
    fs::read_dir(p)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect()
        })
        .unwrap_or_default()
}

struct Meta {
    local_id: Option<String>,
    title: Option<String>,
    account: String,
    cwd: Option<String>,
    created: Option<i64>,
    last: Option<i64>,
    archived: bool,
    model: Option<String>,
}

fn load_metadata() -> HashMap<String, Meta> {
    let mut out = HashMap::new();
    let Some(root) = sessions_dir() else { return out };
    for acct in subdirs(&root) {
        let acct_name = acct
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        for org in subdirs(&acct) {
            let Ok(rd) = fs::read_dir(&org) else { continue };
            for f in rd.flatten() {
                let p = f.path();
                let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                if !(name.starts_with("local_") && name.ends_with(".json")) {
                    continue;
                }
                let Ok(txt) = fs::read_to_string(&p) else { continue };
                let Ok(v) = serde_json::from_str::<Value>(&txt) else { continue };
                let Some(cli) = v.get("cliSessionId").and_then(|x| x.as_str()) else { continue };
                let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(String::from);
                out.insert(
                    cli.to_string(),
                    Meta {
                        local_id: s("sessionId"),
                        title: s("title"),
                        account: acct_name.clone(),
                        cwd: s("cwd"),
                        created: v.get("createdAt").and_then(|x| x.as_i64()),
                        last: v.get("lastActivityAt").and_then(|x| x.as_i64()),
                        archived: v.get("isArchived").and_then(|x| x.as_bool()).unwrap_or(false),
                        model: s("model"),
                    },
                );
            }
        }
    }
    out
}

fn is_noise(t: &str) -> bool {
    let t = t.trim_start();
    t.starts_with("<system-reminder>")
        || t.starts_with("<local-command")
        || t.starts_with("<command-name>")
        || t.starts_with("<command-message>")
        || t.starts_with("<ide_")
        || t.starts_with("[Request interrupted")
}

fn clip(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(n).collect();
        out.push('…');
        out
    }
}

/// Extracts displayable messages from one transcript line.
fn line_messages(v: &Value) -> Vec<Msg> {
    let mut out = Vec::new();
    let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
    if ty != "user" && ty != "assistant" {
        return out;
    }
    if v.get("isMeta").and_then(|x| x.as_bool()).unwrap_or(false) {
        return out;
    }
    let ts = v.get("timestamp").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let role = ty.to_string();
    let Some(content) = v.get("message").and_then(|m| m.get("content")) else { return out };
    let push_text = |out: &mut Vec<Msg>, t: &str| {
        if t.trim().is_empty() || (role == "user" && is_noise(t)) {
            return;
        }
        let kind = if role == "user" && t.starts_with("This session is being continued") {
            "summary"
        } else {
            "text"
        };
        out.push(Msg { role: role.clone(), ts: ts.clone(), text: t.to_string(), kind: kind.into() });
    };
    match content {
        Value::String(s) => push_text(&mut out, s),
        Value::Array(blocks) => {
            for b in blocks {
                match b.get("type").and_then(|x| x.as_str()).unwrap_or("") {
                    "text" => {
                        if let Some(t) = b.get("text").and_then(|x| x.as_str()) {
                            push_text(&mut out, t);
                        }
                    }
                    "image" => out.push(Msg {
                        role: role.clone(),
                        ts: ts.clone(),
                        text: "[Image]".into(),
                        kind: "image".into(),
                    }),
                    "tool_use" => {
                        let name = b.get("name").and_then(|x| x.as_str()).unwrap_or("tool");
                        let inp = b.get("input");
                        let detail = inp
                            .and_then(|i| {
                                ["description", "command", "file_path", "pattern", "url", "query", "prompt"]
                                    .iter()
                                    .find_map(|k| i.get(*k).and_then(|x| x.as_str()))
                            })
                            .unwrap_or("");
                        out.push(Msg {
                            role: role.clone(),
                            ts: ts.clone(),
                            text: format!("{}: {}", name, clip(detail.lines().next().unwrap_or(""), 160)),
                            kind: "tool".into(),
                        });
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    out
}

fn first_user_text(path: &Path) -> Option<String> {
    let f = File::open(path).ok()?;
    for line in BufReader::new(f).lines().take(400).flatten() {
        if !line.contains("\"type\":\"user\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if let Some(m) = line_messages(&v).into_iter().find(|m| m.role == "user" && m.kind == "text") {
            return Some(clip(m.text.trim(), 80));
        }
    }
    None
}

fn project_label(dir: &Path, cwd: &Option<String>) -> String {
    if let Some(c) = cwd {
        if let Some(n) = Path::new(c).file_name() {
            return n.to_string_lossy().to_string();
        }
    }
    dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

#[tauri::command]
fn list_chats() -> Vec<ChatSummary> {
    let meta = load_metadata();
    let mut chats = Vec::new();
    let Some(root) = projects_dir() else { return chats };
    for dir in subdirs(&root) {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for f in rd.flatten() {
            let p = f.path();
            if p.extension().map(|e| e != "jsonl").unwrap_or(true) {
                continue;
            }
            let id = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let md = f.metadata().ok();
            let size = md.as_ref().map(|m| m.len()).unwrap_or(0);
            let mtime = md
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            let chat = if let Some(m) = meta.get(&id) {
                ChatSummary {
                    id: id.clone(),
                    local_id: m.local_id.clone(),
                    title: m.title.clone().unwrap_or_else(|| "Untitled".into()),
                    account: m.account.clone(),
                    project: project_label(&dir, &m.cwd),
                    cwd: m.cwd.clone(),
                    created_ms: m.created,
                    last_ms: m.last.unwrap_or(mtime),
                    archived: m.archived,
                    size,
                    path: p.to_string_lossy().to_string(),
                    model: m.model.clone(),
                    has_metadata: true,
                }
            } else {
                let Some(title) = first_user_text(&p) else { continue };
                ChatSummary {
                    id: id.clone(),
                    local_id: None,
                    title,
                    account: "unknown".into(),
                    project: project_label(&dir, &None),
                    cwd: None,
                    created_ms: None,
                    last_ms: mtime,
                    archived: false,
                    size,
                    path: p.to_string_lossy().to_string(),
                    model: None,
                    has_metadata: false,
                }
            };
            chats.push(chat);
        }
    }
    chats.sort_by(|a, b| b.last_ms.cmp(&a.last_ms));
    chats
}

fn check_transcript(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let root = projects_dir().ok_or("Cannot find the Claude projects folder")?;
    let canon = p.canonicalize().map_err(|e| e.to_string())?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    if !canon.starts_with(&root) || canon.extension().map(|e| e != "jsonl").unwrap_or(true) {
        return Err("That file is not a Claude transcript".into());
    }
    Ok(canon)
}

#[tauri::command]
async fn read_chat(path: String) -> Result<Vec<Msg>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = check_transcript(&path)?;
        let f = File::open(p).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for line in BufReader::new(f).lines().flatten() {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                out.extend(line_messages(&v));
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn search_chats(query: String) -> Result<Vec<SearchHit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let q = query.trim().to_lowercase();
        if q.chars().count() < 2 {
            return Ok(Vec::new());
        }
        let mut hits = Vec::new();
        for chat in list_chats() {
            let Ok(f) = File::open(&chat.path) else { continue };
            'file: for line in BufReader::new(f).lines().flatten() {
                if !line.to_lowercase().contains(&q) {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                for m in line_messages(&v) {
                    if m.kind == "tool" {
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
                        let snippet = clip(m.text[start..].replace('\n', " ").trim(), 140);
                        hits.push(SearchHit { id: chat.id.clone(), snippet });
                        break 'file;
                    }
                }
            }
        }
        Ok(hits)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), String> {
    let p = check_transcript(&path)?;
    let p = p.to_string_lossy().trim_start_matches(r"\\?\").to_string();
    Command::new("explorer")
        .arg(format!("/select,{}", p))
        .spawn()
        .map_err(|e| e.to_string())?;
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

#[tauri::command]
fn open_in_claude(local_id: String) -> Result<(), String> {
    if !local_id.starts_with("local_")
        || !local_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
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
    let desktop = env_path("USERPROFILE").ok_or("No user profile")?.join("Desktop").join("Claude Chats");
    fs::create_dir_all(&desktop).map_err(|e| e.to_string())?;
    let safe: String = title
        .chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' { c } else { '_' })
        .collect();
    let file = desktop.join(format!("{}.md", clip(safe.trim(), 60).trim_end_matches('…')));
    fs::write(&file, markdown).map_err(|e| e.to_string())?;
    Command::new("explorer")
        .arg(format!("/select,{}", file.to_string_lossy()))
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(file.to_string_lossy().to_string())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

#[tauri::command]
fn save_handoff(title: String, content: String) -> Result<String, String> {
    let dir = env_path("USERPROFILE")
        .ok_or("No user profile")?
        .join("Documents")
        .join("ChatVault Handoffs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = title
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
        .collect();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let file = dir.join(format!("{}-{}.md", clip(&safe, 40).trim_end_matches('…'), stamp));
    fs::write(&file, content).map_err(|e| e.to_string())?;
    Ok(file.to_string_lossy().to_string())
}

/// Opens a new PowerShell window in the chat's folder and starts Claude Code or Codex there.
#[tauri::command]
fn launch_agent(agent: String, id: String, cwd: Option<String>, handoff: Option<String>) -> Result<(), String> {
    let dir = cwd
        .filter(|c| Path::new(c).is_dir())
        .map(PathBuf::from)
        .or_else(|| env_path("USERPROFILE"))
        .ok_or("No folder to start in")?;
    let script = match agent.as_str() {
        "claude" | "claude-fork" => {
            if !valid_id(&id) {
                return Err("Invalid chat id".into());
            }
            let fork = if agent == "claude-fork" { " --fork-session" } else { "" };
            format!("claude --resume {}{}", id, fork)
        }
        "codex" => {
            let path = handoff.ok_or("Missing handoff file")?;
            if path.contains('\'') || !Path::new(&path).is_file() {
                return Err("Invalid handoff file".into());
            }
            format!(
                "codex 'Read the file {} completely. It is the transcript of an earlier Claude Code session on this project. Continue the work from exactly where it stopped, and follow the project rules it mentions.'",
                path
            )
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_chats,
            read_chat,
            search_chats,
            reveal_in_folder,
            open_in_claude,
            open_folder,
            save_markdown,
            save_handoff,
            launch_agent
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_real_chats() {
        let chats = list_chats();
        println!("chats: {}", chats.len());
        let mut accts: HashMap<String, usize> = HashMap::new();
        for c in &chats {
            *accts.entry(c.account.clone()).or_default() += 1;
        }
        println!("accounts: {:?}", accts);
        assert!(!chats.is_empty());
        let big = chats.iter().find(|c| c.id.starts_with("79cbef96")).expect("target chat");
        println!("title: {} / project: {} / cwd: {:?}", big.title, big.project, big.cwd);
        let f = File::open(&big.path).unwrap();
        let mut n = 0;
        let mut tools = 0;
        for line in BufReader::new(f).lines().flatten() {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                for m in line_messages(&v) {
                    n += 1;
                    if m.kind == "tool" {
                        tools += 1;
                    }
                }
            }
        }
        println!("messages: {} (tool steps {})", n, tools);
        assert!(n > 500);
    }
}
