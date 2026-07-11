//! Best-effort Cursor usage for the toolbar widget. Reads the locally stored
//! Cursor auth token — the cursor-agent CLI config first, then the Cursor IDE's
//! state database — and queries the dashboard usage API. These are unofficial
//! endpoints/paths (mirroring what community usage trackers use), so everything
//! degrades to `found: false` rather than erroring.

use base64::Engine;
use serde::Serialize;
use serde_json::Value;

/// Billing-cycle usage from Cursor's `/api/usage-summary` (the same numbers the
/// dashboard shows — works for included-credit plans like Ultra too).
#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CursorUsage {
    pub found: bool,
    /// Membership tier (e.g. "ultra", "pro", "free"); "" if unknown.
    pub plan: String,
    /// Percent of the included allowance used this cycle (0–100).
    pub utilization: f64,
    /// Raw used / limit of the included allowance (0 when not applicable).
    pub used: u64,
    pub limit: u64,
    /// ISO end of the current billing cycle (when the allowance resets).
    pub resets_at: String,
    /// Plans with no fixed cap.
    pub unlimited: bool,
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
/// Read in-process with rusqlite — an external `sqlite3` may not be on PATH,
/// and any subprocess risks flashing a console window on Windows.
fn ide_token() -> Option<String> {
    let db = if cfg!(target_os = "macos") {
        home()?.join("Library/Application Support/Cursor/User/globalStorage/state.vscdb")
    } else if cfg!(target_os = "windows") {
        std::path::PathBuf::from(std::env::var("APPDATA").ok()?)
            .join("Cursor/User/globalStorage/state.vscdb")
    } else {
        home()?.join(".config/Cursor/User/globalStorage/state.vscdb")
    };
    token_from_vscdb(&db)
}

/// Pull the Cursor access token out of a state.vscdb file. Read-only open so a
/// running Cursor (which holds write locks) degrades to None, never an error
/// dialog; a short busy timeout rides out transient locks.
fn token_from_vscdb(db: &std::path::Path) -> Option<String> {
    if !db.exists() {
        return None;
    }
    let conn = rusqlite::Connection::open_with_flags(
        db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(250));
    let s: String = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken'",
            [],
            |r| r.get(0),
        )
        .ok()?;
    let s = s.trim().trim_matches('"').to_string();
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
    let cookie = format!("WorkosCursorSessionToken={user}%3A%3A{token}");

    // GET helper returning a parsed JSON body (None on any failure).
    let get_json = |url: &str| -> Option<Value> {
        let resp = agent.get(url).header("Cookie", &cookie).call().ok()?;
        serde_json::from_str::<Value>(&resp.into_body().read_to_string().ok()?).ok()
    };

    // /api/usage-summary mirrors the dashboard: included-allowance %, raw
    // used/limit, plan tier and the billing-cycle reset — for every plan type.
    let Some(v) = get_json("https://cursor.com/api/usage-summary") else {
        return none;
    };
    let plan = v
        .get("membershipType")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let unlimited = v.get("isUnlimited").and_then(|x| x.as_bool()).unwrap_or(false);
    let resets_at = v
        .get("billingCycleEnd")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let p = v.get("individualUsage").and_then(|u| u.get("plan"));
    let g = |k: &str| p.and_then(|p| p.get(k)).and_then(|x| x.as_f64()).unwrap_or(0.0);
    let utilization = g("totalPercentUsed");
    let used = g("used") as u64;
    let limit = g("limit") as u64;

    CursorUsage {
        found: !plan.is_empty() || p.is_some(),
        plan,
        utilization,
        used,
        limit,
        resets_at,
        unlimited,
    }
}

/// Fetch Cursor plan usage off the main thread (file/sqlite reads + network).
#[tauri::command(rename_all = "camelCase")]
pub async fn cursor_usage() -> CursorUsage {
    tauri::async_runtime::spawn_blocking(fetch_usage)
        .await
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_jwt() -> String {
        // Three dot-separated segments, > 40 chars total.
        format!("{}.{}.{}", "a".repeat(20), "b".repeat(20), "c".repeat(20))
    }

    #[test]
    fn reads_token_from_vscdb() {
        let dir = std::env::temp_dir().join("xcmd-test-vscdb");
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("state.vscdb");
        let _ = std::fs::remove_file(&db);
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)")
            .unwrap();
        let jwt = fake_jwt();
        conn.execute(
            "INSERT INTO ItemTable (key, value) VALUES ('cursorAuth/accessToken', ?1)",
            [&jwt],
        )
        .unwrap();
        drop(conn);

        assert_eq!(token_from_vscdb(&db), Some(jwt));
    }

    #[test]
    fn missing_key_or_db_gives_none() {
        let dir = std::env::temp_dir().join("xcmd-test-vscdb");
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("empty.vscdb");
        let _ = std::fs::remove_file(&db);
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)")
            .unwrap();
        drop(conn);

        assert_eq!(token_from_vscdb(&db), None);
        assert_eq!(token_from_vscdb(&dir.join("does-not-exist.vscdb")), None);
    }

    /// On a dev machine with Cursor installed, verify the real database reads
    /// cleanly in-process. Skips (trivially passes) when Cursor is absent.
    #[test]
    fn reads_real_cursor_db_when_present() {
        let db = if cfg!(target_os = "windows") {
            match std::env::var("APPDATA") {
                Ok(a) => std::path::PathBuf::from(a).join("Cursor/User/globalStorage/state.vscdb"),
                Err(_) => return,
            }
        } else {
            return;
        };
        if !db.exists() {
            return;
        }
        let tok = token_from_vscdb(&db);
        assert!(tok.is_some(), "real state.vscdb exists but no token was read");
    }
}
