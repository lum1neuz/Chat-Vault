//! SQLite index of every chat found on disk, so listing and searching stay fast
//! even with a very large number of chats. Only new or changed files are re-read.

use crate::paths::*;
use crate::providers::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};

static REFRESHING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatSummary {
    pub provider: String,
    pub id: String,
    pub local_id: Option<String>,
    pub title: String,
    pub account: String,
    pub project: String,
    pub cwd: Option<String>,
    pub created_ms: Option<i64>,
    pub last_ms: i64,
    pub archived: bool,
    pub size: i64,
    pub path: String,
    pub model: Option<String>,
    pub has_metadata: bool,
    pub backup: bool,
}

#[derive(Serialize)]
pub struct Page {
    pub items: Vec<ChatSummary>,
    pub total: i64,
}

#[derive(Serialize)]
pub struct AccountCount {
    pub id: String,
    pub count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub total: i64,
    pub accounts: Vec<AccountCount>,
    pub latest_ms: Option<i64>,
}

#[derive(Serialize, Clone)]
struct Progress {
    phase: String,
    done: usize,
    total: usize,
}

pub fn open_db() -> Result<Connection, String> {
    let dir = data_dir().ok_or("No data folder")?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let c = Connection::open(dir.join("index.db")).map_err(|e| e.to_string())?;
    c.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         CREATE TABLE IF NOT EXISTS chats(
           provider TEXT NOT NULL, id TEXT NOT NULL, local_id TEXT, title TEXT NOT NULL,
           account TEXT NOT NULL, project TEXT NOT NULL, cwd TEXT, created_ms INTEGER,
           last_ms INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL,
           mtime INTEGER NOT NULL, path TEXT NOT NULL, model TEXT, has_meta INTEGER NOT NULL DEFAULT 0,
           backup INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(provider, id));
         CREATE INDEX IF NOT EXISTS chats_last ON chats(provider, last_ms DESC);
         CREATE INDEX IF NOT EXISTS chats_acct ON chats(provider, account, last_ms DESC);
         CREATE UNIQUE INDEX IF NOT EXISTS chats_path ON chats(path);
         CREATE VIRTUAL TABLE IF NOT EXISTS chats_fts USING fts5(key UNINDEXED, title, project, preview);",
    )
    .map_err(|e| e.to_string())?;
    Ok(c)
}

fn mtime_ms(p: &Path) -> (i64, i64) {
    fs::metadata(p)
        .map(|m| {
            let t = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            (m.len() as i64, t)
        })
        .unwrap_or((0, 0))
}

struct Found {
    provider: &'static str,
    path: PathBuf,
    backup: bool,
}

fn collect_files() -> Vec<Found> {
    let mut v = Vec::new();
    let mut add = |provider: &'static str, root: Option<PathBuf>, backup: bool, depth: u8| {
        let Some(root) = root else { return };
        let mut files = Vec::new();
        if depth == 1 {
            for d in subdirs(&root) {
                if let Ok(rd) = fs::read_dir(&d) {
                    for e in rd.flatten() {
                        let p = e.path();
                        if p.extension().map(|x| x == "jsonl").unwrap_or(false) {
                            files.push(p);
                        }
                    }
                }
            }
        } else {
            walk_files(&root, &["jsonl", "zst"], &mut files);
        }
        v.extend(files.into_iter().map(|path| Found { provider, path, backup }));
    };
    add("claude", claude_projects(), false, 1);
    add("codex", codex_home().map(|c| c.join("sessions")), false, 9);
    add("codex", codex_home().map(|c| c.join("archived_sessions")), false, 9);
    let b = backup_root();
    add("claude", b.as_ref().map(|b| b.join("claude").join("projects")), true, 1);
    add("codex", b.as_ref().map(|b| b.join("codex").join("sessions")), true, 9);
    add("codex", b.as_ref().map(|b| b.join("codex").join("archived_sessions")), true, 9);
    v
}

struct ClaudeMeta {
    local_id: Option<String>,
    title: Option<String>,
    account: String,
    cwd: Option<String>,
    created: Option<i64>,
    last: Option<i64>,
    archived: bool,
    model: Option<String>,
}

fn load_claude_meta() -> HashMap<String, ClaudeMeta> {
    let mut out = HashMap::new();
    let roots = [claude_meta(), backup_root().map(|b| b.join("claude").join("sessions-meta"))];
    for root in roots.into_iter().flatten() {
        for acct in subdirs(&root) {
            let acct_name = acct.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
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
                    out.entry(cli.to_string()).or_insert(ClaudeMeta {
                        local_id: s("sessionId"),
                        title: s("title"),
                        account: acct_name.clone(),
                        cwd: s("cwd"),
                        created: v.get("createdAt").and_then(|x| x.as_i64()),
                        last: v.get("lastActivityAt").and_then(|x| x.as_i64()),
                        archived: v.get("isArchived").and_then(|x| x.as_bool()).unwrap_or(false),
                        model: s("model"),
                    });
                }
            }
        }
    }
    out
}

fn load_codex_index() -> HashMap<String, (String, Option<i64>)> {
    let mut out = HashMap::new();
    let files = [
        codex_home().map(|c| c.join("session_index.jsonl")),
        backup_root().map(|b| b.join("codex").join("session_index.jsonl")),
    ];
    for f in files.into_iter().flatten() {
        let Ok(file) = File::open(f) else { continue };
        for line in BufReader::new(file).lines().flatten() {
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            let (Some(id), Some(name)) = (
                v.get("id").and_then(|x| x.as_str()),
                v.get("thread_name").and_then(|x| x.as_str()),
            ) else {
                continue;
            };
            let ms = v
                .get("updated_at")
                .and_then(|x| x.as_str())
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.timestamp_millis());
            out.entry(id.to_string()).or_insert((name.to_string(), ms));
        }
    }
    out
}

fn parse_iso(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis())
}

/// Claude names a project folder after the path with every separator turned into "-". When the chat itself does not say
/// where it ran, make that folder name readable instead of showing the whole encoded path.
fn friendly_dir(name: &str) -> String {
    if name.contains("Claude-scratch") || name.contains("scratch-workspaces") {
        return "Claude scratch chat".to_string();
    }
    let mut rest = name;
    if let Some(i) = name.find("-Users-") {
        let after = &name[i + "-Users-".len()..];
        // drop the user name too
        rest = after.split_once('-').map(|(_, r)| r).unwrap_or(after);
    }
    let rest = rest.replace("---", " - ");
    if rest.is_empty() { name.to_string() } else { rest }
}

fn project_of(cwd: &Option<String>, fallback: &str) -> String {
    cwd.as_ref()
        .and_then(|c| Path::new(c).file_name())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| friendly_dir(fallback))
}

struct Row {
    s: ChatSummary,
    mtime: i64,
    preview: String,
}

fn first_user_text(provider: &str, path: &Path, max_lines: usize) -> Option<String> {
    for line in open_lines(path)?.take(max_lines) {
        if !line.contains("\"user\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if let Some(m) = messages_for(provider, &v).into_iter().find(|m| m.role == "user" && m.kind == "text") {
            return Some(clip(m.text.trim(), 300));
        }
    }
    None
}

fn build_row(
    f: &Found,
    size: i64,
    mtime: i64,
    cmeta: &HashMap<String, ClaudeMeta>,
    cindex: &HashMap<String, (String, Option<i64>)>,
) -> Option<Row> {
    let stem = f.path.file_stem()?.to_string_lossy().trim_end_matches(".jsonl").to_string();
    let path = f.path.to_string_lossy().to_string();
    if f.provider == "claude" {
        let dir_name = f.path.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let preview = first_user_text("claude", &f.path, 400);
        if let Some(m) = cmeta.get(&stem) {
            let title = m.title.clone().unwrap_or_else(|| "Untitled".into());
            return Some(Row {
                s: ChatSummary {
                    provider: "claude".into(),
                    id: stem,
                    local_id: m.local_id.clone(),
                    title,
                    account: m.account.clone(),
                    project: project_of(&m.cwd, &dir_name),
                    cwd: m.cwd.clone(),
                    created_ms: m.created,
                    last_ms: m.last.unwrap_or(mtime),
                    archived: m.archived,
                    size,
                    path,
                    model: m.model.clone(),
                    has_metadata: true,
                    backup: f.backup,
                },
                mtime,
                preview: preview.unwrap_or_default(),
            });
        }
        let title = clip(preview.as_deref()?.trim(), 80);
        return Some(Row {
            s: ChatSummary {
                provider: "claude".into(),
                id: stem,
                local_id: None,
                title,
                account: "unknown".into(),
                project: friendly_dir(&dir_name),
                cwd: None,
                created_ms: None,
                last_ms: mtime,
                archived: false,
                size,
                path,
                model: None,
                has_metadata: false,
                backup: f.backup,
            },
            mtime,
            preview: preview.unwrap_or_default(),
        });
    }

    // Codex rollout: the first line is session_meta.
    let first = open_lines(&f.path)?.next()?;
    let v: Value = serde_json::from_str(&first).ok()?;
    let p = v.get("payload")?;
    let id = p
        .get("id")
        .and_then(|x| x.as_str())
        .map(String::from)
        .unwrap_or_else(|| stem.chars().rev().take(36).collect::<Vec<_>>().into_iter().rev().collect());
    let cwd = p.get("cwd").and_then(|x| x.as_str()).map(String::from);
    let account = p
        .get("creator_account_id")
        .and_then(|x| x.as_str())
        .unwrap_or("unknown")
        .to_string();
    let preview = first_user_text("codex", &f.path, 120);
    let (name, updated) = cindex.get(&id).cloned().unzip();
    let title = name
        .or_else(|| preview.as_ref().map(|t| clip(t.trim(), 80)))
        .unwrap_or_else(|| "Untitled".into());
    let archived = f.path.to_string_lossy().contains("archived_sessions");
    Some(Row {
        s: ChatSummary {
            provider: "codex".into(),
            id,
            local_id: None,
            title,
            account,
            project: project_of(&cwd, "unknown"),
            cwd,
            created_ms: p.get("timestamp").and_then(|x| x.as_str()).and_then(parse_iso),
            last_ms: updated.flatten().unwrap_or(mtime),
            archived,
            size,
            path,
            model: p.get("model_provider").and_then(|x| x.as_str()).map(String::from),
            has_metadata: true,
            backup: f.backup,
        },
        mtime,
        preview: preview.unwrap_or_default(),
    })
}

fn upsert(c: &Connection, r: &Row, replace: bool) -> rusqlite::Result<()> {
    let s = &r.s;
    let key = format!("{}:{}", s.provider, s.id);
    if !replace {
        let exists: Option<String> = c
            .query_row("SELECT path FROM chats WHERE provider=?1 AND id=?2", params![s.provider, s.id], |r| r.get(0))
            .optional()?;
        if let Some(p) = exists {
            if Path::new(&p).exists() {
                return Ok(());
            }
        }
    }
    c.execute("DELETE FROM chats WHERE path=?1 AND NOT (provider=?2 AND id=?3)", params![s.path, s.provider, s.id])?;
    c.execute("DELETE FROM chats_fts WHERE key=?1", params![key])?;
    c.execute(
        "INSERT OR REPLACE INTO chats(provider,id,local_id,title,account,project,cwd,created_ms,last_ms,archived,size,mtime,path,model,has_meta,backup)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
        params![
            s.provider, s.id, s.local_id, s.title, s.account, s.project, s.cwd, s.created_ms, s.last_ms,
            s.archived as i64, s.size, r.mtime, s.path, s.model, s.has_metadata as i64, s.backup as i64
        ],
    )?;
    c.execute(
        "INSERT INTO chats_fts(key,title,project,preview) VALUES(?1,?2,?3,?4)",
        params![key, s.title, s.project, r.preview],
    )?;
    Ok(())
}

/// Brings the index up to date. Only files whose size or modified time changed are read again.
/// How many chat files exist and when the newest changed, so new conversations can be spotted without scanning them.
pub fn files_fingerprint() -> (usize, i64) {
    let files = collect_files();
    let newest = files.iter().map(|f| mtime_ms(&f.path).1).max().unwrap_or(0);
    (files.len(), newest)
}

pub fn refresh(app: Option<&AppHandle>) -> Result<(), String> {
    if REFRESHING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let result = (|| {
        let mut c = open_db()?;
        // Rows saved with a raw encoded folder name are rebuilt once so they get the readable project name.
        let _ = c.execute("DELETE FROM chats WHERE provider='claude' AND project LIKE 'C--%'", []);
        let files = collect_files();
        let known: HashMap<String, (i64, i64)> = {
            let mut st = c.prepare("SELECT path,size,mtime FROM chats").map_err(|e| e.to_string())?;
            let rows = st
                .query_map([], |r| Ok((r.get::<_, String>(0)?, (r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))))
                .map_err(|e| e.to_string())?;
            rows.flatten().collect()
        };
        let seen: HashSet<String> = files.iter().map(|f| f.path.to_string_lossy().to_string()).collect();
        let cmeta = load_claude_meta();
        let cindex = load_codex_index();

        let tx = c.transaction().map_err(|e| e.to_string())?;
        for (path, _) in known.iter().filter(|(p, _)| !seen.contains(*p) && !p.starts_with("cursor-") && !Path::new(p).exists()) {
            let _ = tx.execute(
                "DELETE FROM chats_fts WHERE key IN (SELECT provider||':'||id FROM chats WHERE path=?1)",
                params![path],
            );
            let _ = tx.execute("DELETE FROM chats WHERE path=?1", params![path]);
        }
        tx.commit().map_err(|e| e.to_string())?;

        // Live files first so a live copy always wins over its backup.
        let mut todo: Vec<&Found> = Vec::new();
        for f in &files {
            let (size, mtime) = mtime_ms(&f.path);
            let key = f.path.to_string_lossy().to_string();
            let unchanged = known.get(&key).map(|k| *k == (size, mtime)).unwrap_or(false);
            if !unchanged {
                todo.push(f);
            }
        }
        todo.sort_by_key(|f| f.backup);
        let total = todo.len();
        let mut tx = c.transaction().map_err(|e| e.to_string())?;
        for (i, f) in todo.iter().enumerate() {
            let (size, mtime) = mtime_ms(&f.path);
            if let Some(row) = build_row(f, size, mtime, &cmeta, &cindex) {
                let _ = upsert(&tx, &row, !f.backup);
            }
            if i % 200 == 199 {
                tx.commit().map_err(|e| e.to_string())?;
                tx = c.transaction().map_err(|e| e.to_string())?;
                if let Some(a) = app { let _ = a.emit("index-progress", Progress { phase: "Indexing".into(), done: i + 1, total }); }
            }
        }
        tx.commit().map_err(|e| e.to_string())?;

        // Claude titles live in metadata files that change without the transcript changing.
        let tx = c.transaction().map_err(|e| e.to_string())?;
        for (id, m) in &cmeta {
            let _ = tx.execute(
                "UPDATE chats SET title=COALESCE(?1,title), account=?2, last_ms=COALESCE(?3,last_ms), archived=?4, local_id=COALESCE(?5,local_id), has_meta=1 WHERE provider='claude' AND id=?6",
                params![m.title, m.account, m.last, m.archived as i64, m.local_id, id],
            );
        }
        tx.commit().map_err(|e| e.to_string())?;
                // Cursor chats are rebuilt only when Cursor's files changed.
        let fp = crate::cursor::fingerprint();
        let last: i64 = c.query_row("SELECT COALESCE(MAX(mtime),0) FROM chats WHERE provider='cursor'", [], |r| r.get(0)).unwrap_or(0);
        if fp > 0 && fp != last {
            let chats = crate::cursor::scan();
            let tx = c.transaction().map_err(|e| e.to_string())?;
            let _ = tx.execute("DELETE FROM chats_fts WHERE key IN (SELECT provider||':'||id FROM chats WHERE provider='cursor')", []);
            let _ = tx.execute("DELETE FROM chats WHERE provider='cursor'", []);
            for ch in chats {
                let row = Row {
                    s: ChatSummary {
                        provider: "cursor".into(),
                        id: ch.id,
                        local_id: None,
                        title: ch.title.clone(),
                        account: "local".into(),
                        project: project_of(&ch.cwd, "Cursor"),
                        cwd: ch.cwd,
                        created_ms: ch.created_ms,
                        last_ms: ch.last_ms,
                        archived: false,
                        size: ch.size,
                        path: ch.path,
                        model: None,
                        has_metadata: true,
                        backup: false,
                    },
                    mtime: fp,
                    preview: ch.title,
                };
                let _ = upsert(&tx, &row, true);
            }
            tx.commit().map_err(|e| e.to_string())?;
        }
        if let Some(a) = app { let _ = a.emit("index-progress", Progress { phase: "Done".into(), done: total, total }); }
        Ok(())
    })();
    REFRESHING.store(false, Ordering::SeqCst);
    result
}

fn fts_expr(q: &str) -> Option<String> {
    let toks: Vec<String> = q
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"*", t))
        .collect();
    if toks.is_empty() {
        None
    } else {
        Some(toks.join(" "))
    }
}

fn row_to_summary(r: &rusqlite::Row) -> rusqlite::Result<ChatSummary> {
    Ok(ChatSummary {
        provider: r.get(0)?,
        id: r.get(1)?,
        local_id: r.get(2)?,
        title: r.get(3)?,
        account: r.get(4)?,
        project: r.get(5)?,
        cwd: r.get(6)?,
        created_ms: r.get(7)?,
        last_ms: r.get(8)?,
        archived: r.get::<_, i64>(9)? != 0,
        size: r.get(10)?,
        path: r.get(11)?,
        model: r.get(12)?,
        has_metadata: r.get::<_, i64>(13)? != 0,
        backup: r.get::<_, i64>(14)? != 0,
    })
}

const COLS: &str = "provider,id,local_id,title,account,project,cwd,created_ms,last_ms,archived,size,path,model,has_meta,backup";

pub fn query(provider: &str, account: Option<String>, q: &str, offset: i64, limit: i64, sort: &str, scope: &str) -> Result<Page, String> {
    let c = open_db()?;
    let acct = account.filter(|a| a != "all");
    let like = format!("%{}%", q.trim().replace('%', "").replace('_', ""));
    let fts = fts_expr(q);
    let scope_sql = match scope {
        "live" => " AND backup=0",
        "backup" => " AND backup=1",
        "archived" => " AND archived=1",
        _ => "",
    };
    let order_sql = match sort {
        "oldest" => "last_ms ASC",
        "title" => "title COLLATE NOCASE ASC",
        "size" => "size DESC",
        _ => "last_ms DESC",
    };
    let where_sql = format!("provider=?1 AND (?2 IS NULL OR account=?2) AND (?3 = '' OR title LIKE ?4 OR project LIKE ?4 OR (provider||':'||id) IN (SELECT key FROM chats_fts WHERE chats_fts MATCH ?5)){scope_sql}");
    let fts_param = fts.unwrap_or_else(|| "\"\"".into());
    let trimmed = q.trim().to_string();
    let total: i64 = c
        .query_row(&format!("SELECT COUNT(*) FROM chats WHERE {where_sql}"), params![provider, acct, trimmed, like, fts_param], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let mut st = c
        .prepare(&format!("SELECT {COLS} FROM chats WHERE {where_sql} ORDER BY {order_sql} LIMIT ?6 OFFSET ?7"))
        .map_err(|e| e.to_string())?;
    let items = st
        .query_map(params![provider, acct, trimmed, like, fts_param, limit, offset], row_to_summary)
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();
    Ok(Page { items, total })
}

pub fn overview(provider: &str) -> Result<Overview, String> {
    let c = open_db()?;
    let total: i64 = c.query_row("SELECT COUNT(*) FROM chats WHERE provider=?1", params![provider], |r| r.get(0)).map_err(|e| e.to_string())?;
    let latest_ms: Option<i64> = c.query_row("SELECT MAX(last_ms) FROM chats WHERE provider=?1", params![provider], |r| r.get(0)).map_err(|e| e.to_string())?;
    let mut st = c
        .prepare("SELECT account,COUNT(*) FROM chats WHERE provider=?1 GROUP BY account ORDER BY COUNT(*) DESC")
        .map_err(|e| e.to_string())?;
    let accounts = st
        .query_map(params![provider], |r| Ok(AccountCount { id: r.get(0)?, count: r.get(1)? }))
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();
    Ok(Overview { total, accounts, latest_ms })
}

pub fn recent_paths(provider: &str, limit: i64) -> Result<Vec<(String, String)>, String> {
    let c = open_db()?;
    let mut st = c
        .prepare("SELECT id,path FROM chats WHERE provider=?1 ORDER BY last_ms DESC LIMIT ?2")
        .map_err(|e| e.to_string())?;
    let v = st
        .query_map(params![provider, limit], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();
    Ok(v)
}

pub fn by_ids(provider: &str, ids: &[String]) -> Result<Vec<ChatSummary>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let c = open_db()?;
    let marks = vec!["?"; ids.len()].join(",");
    let sql = format!("SELECT {COLS} FROM chats WHERE provider=? AND id IN ({marks}) ORDER BY last_ms DESC");
    let mut st = c.prepare(&sql).map_err(|e| e.to_string())?;
    let mut args: Vec<&dyn rusqlite::ToSql> = vec![&provider];
    for i in ids {
        args.push(i);
    }
    let v = st
        .query_map(args.as_slice(), row_to_summary)
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();
    Ok(v)
}

/// Drops a chat from the index after its file was removed.
pub fn forget(path: &str) -> Result<(), String> {
    let c = open_db()?;
    c.execute(
        "DELETE FROM chats_fts WHERE key IN (SELECT provider||':'||id FROM chats WHERE path=?1)",
        params![path],
    )
    .map_err(|e| e.to_string())?;
    c.execute("DELETE FROM chats WHERE path=?1", params![path]).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize)]
pub struct DayCount {
    pub day: String,
    pub provider: String,
    pub count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStat {
    pub name: String,
    pub count: i64,
    pub claude: i64,
    pub codex: i64,
    pub cursor: i64,
    pub last_ms: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub daily: Vec<DayCount>,
    pub projects: Vec<ProjectStat>,
    pub size_claude: i64,
    pub size_codex: i64,
}

/// Activity for the overview page: chats per day, busiest projects and disk use.
pub fn stats(days: i64) -> Result<Stats, String> {
    let c = open_db()?;
    let since = chrono_now_ms() - days * 86_400_000;
    let mut st = c
        .prepare("SELECT date(last_ms/1000,'unixepoch','localtime') d, provider, COUNT(*) FROM chats WHERE last_ms>=?1 GROUP BY d, provider")
        .map_err(|e| e.to_string())?;
    let daily = st
        .query_map(params![since], |r| Ok(DayCount { day: r.get(0)?, provider: r.get(1)?, count: r.get(2)? }))
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();
    let mut st = c
        .prepare(
            "SELECT project, COUNT(*) n, SUM(provider='claude'), SUM(provider='codex'), SUM(provider='cursor'), MAX(last_ms)
             FROM chats GROUP BY project ORDER BY n DESC, project LIMIT 6",
        )
        .map_err(|e| e.to_string())?;
    let projects = st
        .query_map([], |r| {
            Ok(ProjectStat { name: r.get(0)?, count: r.get(1)?, claude: r.get(2)?, codex: r.get(3)?, cursor: r.get(4)?, last_ms: r.get(5)? })
        })
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();
    let size = |p: &str| -> i64 {
        c.query_row("SELECT COALESCE(SUM(size),0) FROM chats WHERE provider=?1", params![p], |r| r.get(0)).unwrap_or(0)
    };
    Ok(Stats { daily, projects, size_claude: size("claude"), size_codex: size("codex") })
}

fn chrono_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
