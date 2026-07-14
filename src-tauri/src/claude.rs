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

// ---------- plan viewer (the last ExitPlanMode plan of a session) ----------

/// The most recent plan Claude proposed in the newest session for a cwd.
#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlanInfo {
    pub found: bool,
    pub plan: String,
}

/// Last `ExitPlanMode` tool call's `input.plan` in a transcript. Transcripts run
/// to tens of MB, so lines are substring-filtered before any JSON parsing.
fn last_plan_in_file(path: &std::path::Path) -> Option<String> {
    let raw = std::fs::read(path).ok()?;
    let content = String::from_utf8_lossy(&raw);
    let mut last: Option<String> = None;
    for line in content.lines() {
        if !line.contains("ExitPlanMode") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(blocks) = v
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
        else {
            continue;
        };
        for b in blocks {
            if b.get("type").and_then(|t| t.as_str()) == Some("tool_use")
                && b.get("name").and_then(|n| n.as_str()) == Some("ExitPlanMode")
            {
                if let Some(p) = b
                    .get("input")
                    .and_then(|i| i.get("plan"))
                    .and_then(|p| p.as_str())
                {
                    let p = p.trim();
                    if !p.is_empty() {
                        last = Some(p.to_string());
                    }
                }
            }
        }
    }
    last
}

/// Latest plan for the newest session of `cwd` (blocking full-file scan, so it
/// runs off the main thread and only when the user asks to view the plan).
#[tauri::command(rename_all = "camelCase")]
pub async fn claude_plan(cwd: String) -> PlanInfo {
    tauri::async_runtime::spawn_blocking(move || {
        let Some((path, _)) = newest_transcript(&cwd) else {
            return PlanInfo::default();
        };
        match last_plan_in_file(&path) {
            Some(plan) => PlanInfo { found: true, plan },
            None => PlanInfo::default(),
        }
    })
    .await
    .unwrap_or_default()
}

// ---------- plan usage (the data behind the CLI's /usage screen) ----------

/// One rate-limit window: percent used (0–100) + ISO reset timestamp.
#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub utilization: f64,
    pub resets_at: String,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageInfo {
    pub found: bool,
    /// "Current session" on the web (5-hour window).
    pub five_hour: UsageWindow,
    /// Weekly limit across all models.
    pub seven_day: UsageWindow,
    /// Weekly limit for the plan's premium model, if the API reports one
    /// (`seven_day_opus`, `seven_day_fable`, …). `model_label` is empty when absent.
    pub seven_day_model: UsageWindow,
    /// Display name for `seven_day_model`, derived from the API key ("Opus", "Fable").
    pub model_label: String,
    /// Served from cache because the last refresh failed (rate limit / offline).
    pub stale: bool,
}

fn token_from_json(s: &str) -> Option<String> {
    let v: Value = serde_json::from_str(s.trim()).ok()?;
    v.get("claudeAiOauth")?
        .get("accessToken")?
        .as_str()
        .map(|t| t.to_string())
}

/// Claude Code's OAuth access token: macOS keeps it in the login keychain,
/// other platforms in `~/.claude/.credentials.json`.
fn oauth_token() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = std::process::Command::new("security")
            .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
            .output()
        {
            if out.status.success() {
                if let Some(tok) = token_from_json(&String::from_utf8_lossy(&out.stdout)) {
                    return Some(tok);
                }
            }
        }
    }
    let path = claude_home()?.join(".credentials.json");
    token_from_json(&std::fs::read_to_string(path).ok()?)
}

/// Parse the `/api/oauth/usage` payload. Windows are objects with `utilization`
/// + `resets_at`; besides the two fixed ones the API may expose a weekly window
/// for the plan's premium model under `seven_day_<model>` (opus, fable, …) —
/// that's the third bar the web UI shows, so pick up whatever key is there.
fn parse_usage(v: &Value) -> Option<UsageInfo> {
    let win = |o: Option<&Value>| UsageWindow {
        utilization: o
            .and_then(|o| o.get("utilization"))
            .and_then(|x| x.as_f64())
            .unwrap_or(0.0),
        resets_at: o
            .and_then(|o| o.get("resets_at"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
    };
    let obj = v.as_object()?;
    if !obj.contains_key("five_hour") && !obj.contains_key("seven_day") {
        return None; // error payload or a shape we don't understand
    }
    // The premium-model weekly window, whatever Anthropic calls it this month.
    let extra = obj
        .iter()
        .filter(|(k, o)| {
            k.starts_with("seven_day_") && o.get("utilization").is_some_and(|u| u.is_number())
        })
        .max_by(|a, b| {
            let u = |o: &Value| o.get("utilization").and_then(|x| x.as_f64()).unwrap_or(0.0);
            u(a.1).total_cmp(&u(b.1))
        });
    let model_label = extra
        .map(|(k, _)| {
            let raw = k.trim_start_matches("seven_day_").replace('_', " ");
            let mut c = raw.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .unwrap_or_default();
    Some(UsageInfo {
        found: true,
        five_hour: win(obj.get("five_hour")),
        seven_day: win(obj.get("seven_day")),
        seven_day_model: win(extra.map(|(_, o)| o)),
        model_label,
        stale: false,
    })
}

fn request_usage() -> Option<UsageInfo> {
    let token = oauth_token()?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(10)))
        .build()
        .into();
    // Non-2xx (notably 429) is an Err in ureq 3 — treated as a failed refresh, so
    // the cached snapshot is kept instead of being blanked out.
    let resp = agent
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", &format!("Bearer {token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .call()
        .ok()?;
    let txt = resp.into_body().read_to_string().ok()?;
    parse_usage(&serde_json::from_str::<Value>(&txt).ok()?)
}

/// Last good snapshot + how hard we're allowed to hit the API.
///
/// `/api/oauth/usage` rate-limits aggressively (429 even at ~1 req/min, since the
/// Claude Code CLI polls the same endpoint for the same account). Before this
/// cache every 429 blanked the widget — that's the "sometimes no data" flicker.
struct UsageCache {
    data: Option<UsageInfo>,
    /// When `data` was fetched.
    at: Option<std::time::Instant>,
    /// Don't call the API again before this (exponential backoff after failures).
    next_try: Option<std::time::Instant>,
    fails: u32,
}

static USAGE_CACHE: std::sync::Mutex<UsageCache> = std::sync::Mutex::new(UsageCache {
    data: None,
    at: None,
    next_try: None,
    fails: 0,
});

/// Serve the cache without touching the network for this long.
const USAGE_FRESH: std::time::Duration = std::time::Duration::from_secs(120);
/// Past this age the snapshot is flagged `stale` (still shown, just marked).
const USAGE_STALE: std::time::Duration = std::time::Duration::from_secs(900);

/// A cached snapshot, flagged stale once it gets old. `None` when nothing was
/// ever fetched successfully.
fn cached(c: &UsageCache) -> Option<UsageInfo> {
    let (d, at) = (c.data.as_ref()?, c.at?);
    let mut d = d.clone();
    d.stale = at.elapsed() > USAGE_STALE;
    Some(d)
}

fn fetch_usage() -> UsageInfo {
    {
        let c = USAGE_CACHE.lock().unwrap();
        let fresh = c.at.is_some_and(|at| at.elapsed() < USAGE_FRESH);
        let backing_off = c
            .next_try
            .is_some_and(|t| std::time::Instant::now() < t);
        if fresh || backing_off {
            // Backing off with nothing cached yet → empty, but still no API call.
            return cached(&c).unwrap_or_default();
        }
    }
    match request_usage() {
        Some(u) => {
            let mut c = USAGE_CACHE.lock().unwrap();
            c.data = Some(u.clone());
            c.at = Some(std::time::Instant::now());
            c.next_try = None;
            c.fails = 0;
            u
        }
        None => {
            let mut c = USAGE_CACHE.lock().unwrap();
            c.fails = c.fails.saturating_add(1).min(5);
            // 1, 2, 4, 8, 16 minutes.
            let wait = std::time::Duration::from_secs(60 << (c.fails - 1));
            c.next_try = Some(std::time::Instant::now() + wait);
            cached(&c).unwrap_or_default()
        }
    }
}

/// Fetch plan usage off the main thread (network + keychain access).
#[tauri::command(rename_all = "camelCase")]
pub async fn claude_usage() -> UsageInfo {
    tauri::async_runtime::spawn_blocking(fetch_usage)
        .await
        .unwrap_or_default()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn plan_line(plan: &str) -> String {
        serde_json::json!({
            "type": "assistant",
            "message": { "content": [
                { "type": "tool_use", "name": "ExitPlanMode", "input": { "plan": plan } }
            ]}
        })
        .to_string()
    }

    #[test]
    fn last_plan_wins() {
        let dir = std::env::temp_dir().join("termdeck-plan-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.jsonl");
        let noise = r#"{"type":"user","message":{"content":"ExitPlanMode mentioned in text"}}"#;
        std::fs::write(
            &path,
            format!("{}\n{}\n{}\n", plan_line("# old plan"), noise, plan_line("# new plan")),
        )
        .unwrap();
        assert_eq!(last_plan_in_file(&path).as_deref(), Some("# new plan"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn no_plan_gives_none() {
        let dir = std::env::temp_dir().join("termdeck-plan-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("empty.jsonl");
        std::fs::write(&path, r#"{"type":"assistant","message":{"content":[]}}"#).unwrap();
        assert_eq!(last_plan_in_file(&path), None);
        assert_eq!(last_plan_in_file(&dir.join("missing.jsonl")), None);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn parses_three_windows() {
        let v = serde_json::json!({
            "five_hour": { "utilization": 16.0, "resets_at": "2026-07-14T12:00:00Z" },
            "seven_day": { "utilization": 34.0, "resets_at": "2026-07-18T03:00:00Z" },
            "seven_day_fable": { "utilization": 45.0, "resets_at": "2026-07-18T03:00:00Z" },
        });
        let u = parse_usage(&v).unwrap();
        assert!(u.found && !u.stale);
        assert_eq!(u.five_hour.utilization, 16.0);
        assert_eq!(u.seven_day.utilization, 34.0);
        assert_eq!(u.seven_day_model.utilization, 45.0);
        assert_eq!(u.model_label, "Fable");
    }

    #[test]
    fn parses_without_model_window() {
        let v = serde_json::json!({ "five_hour": { "utilization": 5.0 } });
        let u = parse_usage(&v).unwrap();
        assert!(u.model_label.is_empty());
        assert_eq!(u.seven_day_model.utilization, 0.0);
        assert_eq!(u.five_hour.resets_at, "");
    }

    #[test]
    fn rejects_error_payload() {
        // A 429 body must not be mistaken for "0% used" — it has to stay None so
        // the caller keeps serving the cached snapshot.
        let v = serde_json::json!({ "error": { "type": "rate_limit_error" } });
        assert!(parse_usage(&v).is_none());
    }
}
