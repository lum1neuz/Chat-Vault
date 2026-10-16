//! Parsers that turn one transcript line into displayable messages, for Claude Code and Codex.

use serde::Serialize;
use serde_json::Value;

#[derive(Serialize, Clone)]
pub struct Msg {
    pub role: String,
    pub ts: String,
    pub text: String,
    pub kind: String,
}

pub fn clip(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(n).collect();
        out.push('…');
        out
    }
}

fn claude_noise(t: &str) -> bool {
    let t = t.trim_start();
    t.starts_with("<system-reminder>")
        || t.starts_with("<local-command")
        || t.starts_with("<command-name>")
        || t.starts_with("<command-message>")
        || t.starts_with("<ide_")
        || t.starts_with("[Request interrupted")
}

const CODEX_NOISE: [&str; 14] = [
    "<environment_context",
    "<codex_internal_context",
    "<in-app-browser-context",
    "<external_codex_apps",
    "<send_user_message",
    "<image",
    "</image>",
    "<user_instructions",
    "<turn_aborted",
    "<permissions",
    "<app-context",
    "# AGENTS.md instructions",
    "# Files mentioned",
    "<collaboration_mode",
];

fn codex_noise(t: &str) -> bool {
    let t = t.trim_start();
    CODEX_NOISE.iter().any(|p| t.starts_with(p))
}

fn first_detail(inp: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|k| inp.get(*k).and_then(|x| x.as_str()))
        .unwrap_or("")
        .lines()
        .next()
        .unwrap_or("")
        .to_string()
}

/// One Claude Code transcript line.
pub fn claude_messages(v: &Value) -> Vec<Msg> {
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
        if t.trim().is_empty() || (role == "user" && claude_noise(t)) {
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
                        let detail = b
                            .get("input")
                            .map(|i| first_detail(i, &["description", "command", "file_path", "pattern", "url", "query", "prompt"]))
                            .unwrap_or_default();
                        out.push(Msg {
                            role: role.clone(),
                            ts: ts.clone(),
                            text: format!("{}: {}", name, clip(&detail, 160)),
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

/// One Codex rollout line.
pub fn codex_messages(v: &Value) -> Vec<Msg> {
    let mut out = Vec::new();
    if v.get("type").and_then(|x| x.as_str()) != Some("response_item") {
        return out;
    }
    let Some(p) = v.get("payload") else { return out };
    let ts = v.get("timestamp").and_then(|x| x.as_str()).unwrap_or("").to_string();
    match p.get("type").and_then(|x| x.as_str()).unwrap_or("") {
        "message" => {
            let role = p.get("role").and_then(|x| x.as_str()).unwrap_or("");
            if role != "user" && role != "assistant" {
                return out;
            }
            let Some(blocks) = p.get("content").and_then(|c| c.as_array()) else { return out };
            for b in blocks {
                match b.get("type").and_then(|x| x.as_str()).unwrap_or("") {
                    "input_text" | "output_text" => {
                        let t = b.get("text").and_then(|x| x.as_str()).unwrap_or("");
                        if t.trim().is_empty() || (role == "user" && codex_noise(t)) {
                            continue;
                        }
                        out.push(Msg { role: role.into(), ts: ts.clone(), text: t.to_string(), kind: "text".into() });
                    }
                    "input_image" => out.push(Msg {
                        role: role.into(),
                        ts: ts.clone(),
                        text: "[Image]".into(),
                        kind: "image".into(),
                    }),
                    _ => {}
                }
            }
        }
        "function_call" => {
            let name = p.get("name").and_then(|x| x.as_str()).unwrap_or("tool");
            let args = p.get("arguments").and_then(|x| x.as_str()).unwrap_or("");
            let detail = serde_json::from_str::<Value>(args)
                .map(|a| first_detail(&a, &["cmd", "command", "path", "query", "url"]))
                .unwrap_or_else(|_| args.lines().next().unwrap_or("").to_string());
            out.push(Msg {
                role: "assistant".into(),
                ts,
                text: format!("{}: {}", name, clip(&detail, 160)),
                kind: "tool".into(),
            });
        }
        "custom_tool_call" => {
            let name = p.get("name").and_then(|x| x.as_str()).unwrap_or("tool");
            let input = p.get("input").and_then(|x| x.as_str()).unwrap_or("");
            out.push(Msg {
                role: "assistant".into(),
                ts,
                text: format!("{}: {}", name, clip(input.lines().next().unwrap_or(""), 160)),
                kind: "tool".into(),
            });
        }
        _ => {}
    }
    out
}

pub fn messages_for(provider: &str, v: &Value) -> Vec<Msg> {
    if provider == "codex" {
        codex_messages(v)
    } else {
        claude_messages(v)
    }
}
