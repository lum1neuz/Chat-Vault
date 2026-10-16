mod index;
mod paths;
mod providers;
mod sync;

use index::{ChatSummary, Overview, Page};
use paths::*;
use providers::{clip, messages_for, Msg};
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
    if p == "claude" || p == "codex" {
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
async fn chats_by_ids(provider: String, ids: Vec<String>) -> Result<Vec<ChatSummary>, String> {
    provider_ok(&provider)?;
    tauri::async_runtime::spawn_blocking(move || index::by_ids(&provider, &ids[..ids.len().min(300)]))
        .await
        .map_err(|e| e.to_string())?
}

/// A window of messages. `before` is a message index; without it the newest `limit` messages come back.
#[tauri::command]
async fn read_chat_page(provider: String, path: String, before: Option<usize>, limit: usize) -> Result<MsgPage, String> {
    provider_ok(&provider)?;
    tauri::async_runtime::spawn_blocking(move || {
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
        let p = check_transcript(&path)?;
        let lines = open_lines(&p).ok_or("Cannot open that chat")?;
        let mut out = Vec::new();
        for line in lines {
            if !relevant(&provider, &line) {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                out.extend(messages_for(&provider, &v).into_iter().filter(|m| m.kind != "tool").map(|m| clip_msg(m, 20_000)));
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
        for (id, path) in index::recent_paths(&provider, 3000)? {
            let Some(lines) = open_lines(Path::new(&path)) else { continue };
            'file: for line in lines {
                if !relevant(&provider, &line) || !line.to_lowercase().contains(&q) {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                for m in messages_for(&provider, &v) {
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
    let p = check_transcript(&path)?;
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
            read_chat_page,
            read_chat_all,
            deep_search,
            reveal_in_folder,
            open_folder,
            open_backup_folder,
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
        for prov in ["claude", "codex"] {
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
