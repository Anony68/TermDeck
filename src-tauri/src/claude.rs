//! Reads Claude Code's real session state for a pane by tail-parsing the newest
//! transcript at `~/.claude/projects/<escaped-cwd>/<session-uuid>.jsonl`. This is
//! best-effort: the JSONL format is internal to Anthropic, so every field is
//! optional and parse errors are swallowed (we fall back to the empty state).

use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;

/// Live session snapshot surfaced to the frontend. All fields best-effort.
#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub found: bool,
    pub session_id: String,
    pub model: String,
    pub mode: String,
    pub permission_mode: String,
    pub git_branch: String,
    pub last_user: String,
    pub last_assistant: String,
    pub stop_reason: String,
    /// Claude finished its turn and is waiting for the user.
    pub waiting_for_input: bool,
    /// Latest turn's context size (input + cache-read tokens).
    pub context_tokens: u64,
    /// Latest turn's output tokens.
    pub output_tokens: u64,
    /// Transcript file mtime (unix secs) — lets the UI detect staleness.
    pub mtime: u64,
}

/// `E:\Code\xcmd` -> `E--Code-xcmd`: Claude replaces `:` `\` `/` with `-`.
fn escape_cwd(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c == ':' || c == '\\' || c == '/' { '-' } else { c })
        .collect()
}

fn claude_home() -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    Some(PathBuf::from(home).join(".claude"))
}

/// Newest `*.jsonl` in the project dir for `cwd` (by modified time).
fn newest_transcript(cwd: &str) -> Option<(PathBuf, u64)> {
    let dir = claude_home()?.join("projects").join(escape_cwd(cwd));
    let mut best: Option<(PathBuf, std::time::SystemTime)> = None;
    for ent in std::fs::read_dir(&dir).ok()?.flatten() {
        let p = ent.path();
        if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        if let Ok(m) = ent.metadata().and_then(|m| m.modified()) {
            if best.as_ref().map_or(true, |(_, t)| m > *t) {
                best = Some((p, m));
            }
        }
    }
    let (path, t) = best?;
    let secs = t
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some((path, secs))
}

/// Read the last `cap` bytes of a file and return complete trailing lines.
fn tail_lines(path: &PathBuf, cap: u64) -> Vec<String> {
    let Ok(mut f) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(cap);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut buf = String::new();
    if f.read_to_string(&mut buf).is_err() {
        // Non-UTF8 slice at the boundary — retry lossily from raw bytes.
        let mut raw = Vec::new();
        let _ = std::fs::File::open(path).and_then(|mut g| {
            let _ = g.seek(SeekFrom::Start(start));
            g.read_to_end(&mut raw)
        });
        buf = String::from_utf8_lossy(&raw).into_owned();
    }
    let mut lines: Vec<String> = buf.split('\n').map(|s| s.to_string()).collect();
    // Drop the first (possibly partial) line when we didn't start at byte 0.
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    lines
}

/// Pull display text out of a `message.content` value (string, or array of
/// text/thinking blocks). Returns None for tool-result-only content.
fn content_text(content: &Value) -> Option<String> {
    if let Some(s) = content.as_str() {
        let t = s.trim();
        return if t.is_empty() { None } else { Some(t.to_string()) };
    }
    // Collect text blocks; a tool_result-only carrier yields nothing (not a real
    // message), which is exactly what an empty result signals to the caller.
    let arr = content.as_array()?;
    let mut out = String::new();
    for block in arr {
        if block.get("type").and_then(|t| t.as_str()) == Some("text") {
            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(t.trim());
            }
        }
    }
    let out = out.trim().to_string();
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn truncate(s: &str, max: usize) -> String {
    let one_line: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= max {
        one_line
    } else {
        let cut: String = one_line.chars().take(max).collect();
        format!("{cut}…")
    }
}

/// One row in the session browser (A3).
#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub title: String,
    pub mtime: u64,
    pub turns: u64,
}

/// List all sessions for a project (newest first) for the resume picker.
#[tauri::command(rename_all = "camelCase")]
pub fn claude_sessions(cwd: String) -> Vec<SessionInfo> {
    let mut out: Vec<SessionInfo> = Vec::new();
    let Some(home) = claude_home() else {
        return out;
    };
    let dir = home.join("projects").join(escape_cwd(&cwd));
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return out;
    };
    for ent in rd.flatten() {
        let path = ent.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let session_id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let mtime = ent
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        // One pass: first real user prompt = title, count user turns.
        let mut title = String::new();
        let mut turns = 0u64;
        if let Ok(content) = std::fs::read_to_string(&path) {
            for line in content.lines() {
                let Ok(v) = serde_json::from_str::<Value>(line) else {
                    continue;
                };
                if v.get("type").and_then(|t| t.as_str()) == Some("user") {
                    if let Some(txt) = v
                        .get("message")
                        .and_then(|m| m.get("content"))
                        .and_then(content_text)
                    {
                        turns += 1;
                        if title.is_empty() {
                            title = truncate(&txt, 90);
                        }
                    }
                }
            }
        }
        out.push(SessionInfo { session_id, title, mtime, turns });
    }
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    out
}

#[tauri::command(rename_all = "camelCase")]
pub fn claude_session(cwd: String) -> SessionState {
    let mut st = SessionState::default();
    if cwd.trim().is_empty() {
        return st;
    }
    let Some((path, mtime)) = newest_transcript(&cwd) else {
        return st;
    };
    st.mtime = mtime;

    let lines = tail_lines(&path, 256 * 1024);
    // Track the role of the last content-bearing line for waiting detection.
    let mut last_content_role: Option<&'static str> = None;

    for line in &lines {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match ty {
            "mode" => {
                if let Some(m) = v.get("mode").and_then(|m| m.as_str()) {
                    st.mode = m.to_string();
                }
            }
            "permission-mode" => {
                if let Some(m) = v.get("permissionMode").and_then(|m| m.as_str()) {
                    st.permission_mode = m.to_string();
                }
            }
            "assistant" => {
                if let Some(sid) = v.get("sessionId").and_then(|s| s.as_str()) {
                    st.session_id = sid.to_string();
                }
                if let Some(b) = v.get("gitBranch").and_then(|s| s.as_str()) {
                    st.git_branch = b.to_string();
                }
                let msg = v.get("message");
                if let Some(model) = msg.and_then(|m| m.get("model")).and_then(|m| m.as_str()) {
                    st.model = model.to_string();
                }
                if let Some(sr) = msg
                    .and_then(|m| m.get("stop_reason"))
                    .and_then(|m| m.as_str())
                {
                    st.stop_reason = sr.to_string();
                }
                if let Some(u) = msg.and_then(|m| m.get("usage")) {
                    let g = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
                    // Approx. context‑window occupancy for the turn (fresh input +
                    // cached reads); cache_creation is excluded to avoid inflation.
                    let ctx = g("input_tokens") + g("cache_read_input_tokens");
                    if ctx > 0 {
                        st.context_tokens = ctx;
                    }
                    let out = g("output_tokens");
                    if out > 0 {
                        st.output_tokens = out;
                    }
                }
                if let Some(c) = msg.and_then(|m| m.get("content")) {
                    if let Some(txt) = content_text(c) {
                        st.last_assistant = truncate(&txt, 220);
                        last_content_role = Some("assistant");
                    }
                }
            }
            "user" => {
                if let Some(sid) = v.get("sessionId").and_then(|s| s.as_str()) {
                    st.session_id = sid.to_string();
                }
                if let Some(c) = v.get("message").and_then(|m| m.get("content")) {
                    if let Some(txt) = content_text(c) {
                        st.last_user = truncate(&txt, 220);
                        last_content_role = Some("user");
                    }
                }
            }
            _ => {}
        }
    }

    st.found = !st.session_id.is_empty() || !st.model.is_empty() || !st.mode.is_empty();
    // Waiting = the transcript ends on a finished assistant turn.
    st.waiting_for_input =
        last_content_role == Some("assistant") && st.stop_reason == "end_turn";
    st
}
