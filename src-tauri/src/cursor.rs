//! Best-effort Cursor usage for the toolbar widget. Reads the locally stored
//! Cursor auth token — the cursor-agent CLI config first, then the Cursor IDE's
//! state database — and queries the dashboard usage API. These are unofficial
//! endpoints/paths (mirroring what community usage trackers use), so everything
//! degrades to `found: false` rather than erroring.

use base64::Engine;
use serde::Serialize;
use serde_json::Value;

/// Monthly plan usage. `max_requests == 0` means the plan has no fixed request
/// quota (usage-based pricing) — the UI then shows the raw count only.
#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CursorUsage {
    pub found: bool,
    pub used_requests: u64,
    pub max_requests: u64,
    /// Percent of the monthly quota used (0 when the quota is unknown).
    pub utilization: f64,
    /// ISO start of the current billing month; it resets one month later.
    pub start_of_month: String,
}

fn home() -> Option<std::path::PathBuf> {
    let h = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    Some(std::path::PathBuf::from(h))
}

/// A JWT has exactly three dot-separated segments.
fn looks_like_jwt(s: &str) -> bool {
    s.split('.').count() == 3 && s.len() > 40
}

/// Recursively search a JSON blob for a JWT under a token-ish key.
fn deep_find_token(v: &Value) -> Option<String> {
    match v {
        Value::Object(m) => {
            for (k, val) in m {
                let kl = k.to_lowercase();
                if kl.contains("accesstoken") || kl == "token" {
                    if let Some(s) = val.as_str() {
                        if looks_like_jwt(s) {
                            return Some(s.to_string());
                        }
                    }
                }
            }
            m.values().find_map(deep_find_token)
        }
        Value::Array(a) => a.iter().find_map(deep_find_token),
        _ => None,
    }
}

/// cursor-agent CLI: token lives somewhere in `~/.cursor/cli-config.json`.
fn cli_token() -> Option<String> {
    let p = home()?.join(".cursor").join("cli-config.json");
    let v: Value = serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()?;
    deep_find_token(&v)
}

/// Cursor IDE: `cursorAuth/accessToken` in the state.vscdb sqlite database.
/// Read via the system `sqlite3` (present on macOS/Linux; skipped elsewhere).
fn ide_token() -> Option<String> {
    let db = if cfg!(target_os = "macos") {
        home()?.join("Library/Application Support/Cursor/User/globalStorage/state.vscdb")
    } else if cfg!(target_os = "windows") {
        std::path::PathBuf::from(std::env::var("APPDATA").ok()?)
            .join("Cursor/User/globalStorage/state.vscdb")
    } else {
        home()?.join(".config/Cursor/User/globalStorage/state.vscdb")
    };
    if !db.exists() {
        return None;
    }
    let out = std::process::Command::new("sqlite3")
        .arg(&db)
        .arg("SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken'")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout)
        .trim()
        .trim_matches('"')
        .to_string();
    looks_like_jwt(&s).then_some(s)
}

/// The dashboard user id is the tail of the JWT's `sub` claim
/// (e.g. "auth0|user_01AB…" -> "user_01AB…").
fn user_id_from_jwt(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    let sub = v.get("sub")?.as_str()?;
    Some(sub.rsplit('|').next()?.to_string())
}

fn fetch_usage() -> CursorUsage {
    let none = CursorUsage::default();
    let Some(token) = cli_token().or_else(ide_token) else {
        return none;
    };
    let Some(user) = user_id_from_jwt(&token) else {
        return none;
    };
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(10)))
        .build()
        .into();
    let Ok(resp) = agent
        .get(format!("https://cursor.com/api/usage?user={user}"))
        .header(
            "Cookie",
            &format!("WorkosCursorSessionToken={user}%3A%3A{token}"),
        )
        .call()
    else {
        return none;
    };
    let Ok(txt) = resp.into_body().read_to_string() else {
        return none;
    };
    let Ok(v) = serde_json::from_str::<Value>(&txt) else {
        return none;
    };
    let premium = v.get("gpt-4");
    let used = premium
        .and_then(|p| p.get("numRequests"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0);
    let max = premium
        .and_then(|p| p.get("maxRequestUsage"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0);
    let start = v
        .get("startOfMonth")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    CursorUsage {
        found: premium.is_some() || !start.is_empty(),
        used_requests: used,
        max_requests: max,
        utilization: if max > 0 {
            used as f64 * 100.0 / max as f64
        } else {
            0.0
        },
        start_of_month: start,
    }
}

/// Fetch Cursor plan usage off the main thread (file/sqlite reads + network).
#[tauri::command(rename_all = "camelCase")]
pub async fn cursor_usage() -> CursorUsage {
    tauri::async_runtime::spawn_blocking(fetch_usage)
        .await
        .unwrap_or_default()
}
