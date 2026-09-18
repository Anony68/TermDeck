//! Desktop side of E2EE cloud sync.
//!
//! The master password and vault key (VK) live **only here**, in Rust: the frontend sends
//! the password once (register/login/unlock) and thereafter deals in plaintext host JSON;
//! this module wraps/unwraps VK and encrypts/decrypts records. VK is held in memory and
//! zeroized on lock. All server I/O is opaque ciphertext.
//!
//! Wire contract with the server is snake_case JSON (built/parsed manually here); the
//! contract with the frontend is camelCase ([`AccountMaterial`]).

use std::io::Read;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use vault_crypto::{
    derive_auth_secret, derive_kek, derive_master_key, derive_recovery_key, generate_recovery,
    generate_salt, generate_vault_key, open, seal, unwrap_vault_key, wrap_vault_key, Key, Sealed,
    ARGON_M_COST, ARGON_P_COST, ARGON_T_COST, KDF_VERSION,
};

/// Non-secret account material the frontend caches so it can unlock offline after a
/// restart (everything here is either public salt or E2EE-wrapped).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountMaterial {
    pub kdf_version: u32,
    pub salt_hex: String,
    pub protected_vk_hex: String,
    pub protected_vk_nonce_hex: String,
    pub recovery_salt_hex: String,
    pub recovery_protected_vk_hex: String,
    pub recovery_protected_vk_nonce_hex: String,
}

#[derive(Default)]
struct Session {
    base_url: String,
    email: String,
    token: Option<String>,
    account: Option<AccountMaterial>,
    vk: Option<Key>,
}

#[derive(Default)]
pub struct SyncState {
    inner: Mutex<Session>,
}

impl SyncState {
    pub fn new() -> Self {
        Self::default()
    }
}

type R<T> = Result<T, String>;

fn sealed_to_hex(s: &Sealed) -> (String, String) {
    (hex::encode(&s.ciphertext), hex::encode(s.nonce))
}
fn hex_to_sealed(ct_hex: &str, nonce_hex: &str) -> R<Sealed> {
    let ciphertext = hex::decode(ct_hex).map_err(|e| e.to_string())?;
    let nb = hex::decode(nonce_hex).map_err(|e| e.to_string())?;
    if nb.len() != 24 {
        return Err("bad nonce length".into());
    }
    let mut nonce = [0u8; 24];
    nonce.copy_from_slice(&nb);
    Ok(Sealed { nonce, ciphertext })
}

fn argon_params() -> Value {
    json!({ "m": ARGON_M_COST, "t": ARGON_T_COST, "p": ARGON_P_COST })
}

// ---- server HTTP (snake_case wire) ----

fn post(base_url: &str, path: &str, token: Option<&str>, body: &Value) -> R<Value> {
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    let mut req = ureq::post(&url).header("content-type", "application/json");
    if let Some(t) = token {
        req = req.header("authorization", &format!("Bearer {t}"));
    }
    let resp = req.send(body.to_string()).map_err(|e| e.to_string())?;
    let mut s = String::new();
    resp.into_body().into_reader().read_to_string(&mut s).map_err(|e| e.to_string())?;
    if s.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&s).map_err(|e| e.to_string())
}

fn get(base_url: &str, path: &str, token: &str) -> R<Value> {
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    let resp = ureq::get(&url)
        .header("authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| e.to_string())?;
    let mut s = String::new();
    resp.into_body().into_reader().read_to_string(&mut s).map_err(|e| e.to_string())?;
    serde_json::from_str(&s).map_err(|e| e.to_string())
}

// ---- crypto helpers ----

/// Derive KEK from the master password + account salt, then unwrap VK. Fails on a wrong
/// password (AEAD tag mismatch), which is how login/unlock verifies the password locally.
fn unlock_vk(master_password: &str, account: &AccountMaterial) -> R<Key> {
    let salt = hex::decode(&account.salt_hex).map_err(|e| e.to_string())?;
    let master_key = derive_master_key(master_password, &salt).map_err(|e| e.to_string())?;
    let kek = derive_kek(&master_key);
    let protected = hex_to_sealed(&account.protected_vk_hex, &account.protected_vk_nonce_hex)?;
    unwrap_vault_key(&kek, &protected).map_err(|_| "wrong password".to_string())
}

/// Build fresh account material (new salt/KEK/protectedVK) for a given VK + master password.
fn build_account_material(master_password: &str, vk: &Key, recovery: &AccountMaterialRecovery) -> R<(AccountMaterial, String)> {
    let salt = generate_salt();
    let master_key = derive_master_key(master_password, &salt).map_err(|e| e.to_string())?;
    let kek = derive_kek(&master_key);
    let auth_secret = derive_auth_secret(&master_key);
    let protected = wrap_vault_key(&kek, vk).map_err(|e| e.to_string())?;
    let (pv_hex, pv_nonce) = sealed_to_hex(&protected);
    let account = AccountMaterial {
        kdf_version: KDF_VERSION,
        salt_hex: hex::encode(salt),
        protected_vk_hex: pv_hex,
        protected_vk_nonce_hex: pv_nonce,
        recovery_salt_hex: recovery.salt_hex.clone(),
        recovery_protected_vk_hex: recovery.protected_vk_hex.clone(),
        recovery_protected_vk_nonce_hex: recovery.protected_vk_nonce_hex.clone(),
    };
    Ok((account, hex::encode(auth_secret)))
}

/// The recovery half of the account material (kept stable across password changes).
struct AccountMaterialRecovery {
    salt_hex: String,
    protected_vk_hex: String,
    protected_vk_nonce_hex: String,
}

// ---- commands ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterResult {
    pub token: String,
    pub recovery_code: String,
    pub account: AccountMaterial,
}

#[tauri::command(rename_all = "camelCase")]
pub fn cloud_register(
    state: State<SyncState>,
    base_url: String,
    email: String,
    master_password: String,
) -> R<RegisterResult> {
    let vk = generate_vault_key();

    // Recovery: random code -> key -> wrap VK + auth secret.
    let rec = generate_recovery().map_err(|e| e.to_string())?;
    let rec_wrap = wrap_vault_key(&rec.key, &vk).map_err(|e| e.to_string())?;
    let (rec_ct, rec_nonce) = sealed_to_hex(&rec_wrap);
    let recovery = AccountMaterialRecovery {
        salt_hex: hex::encode(rec.salt),
        protected_vk_hex: rec_ct,
        protected_vk_nonce_hex: rec_nonce,
    };
    let recovery_auth_secret = hex::encode(derive_auth_secret(&rec.key));

    let (account, auth_secret_hex) = build_account_material(&master_password, &vk, &recovery)?;

    let body = json!({
        "email": email,
        "auth_secret_hex": auth_secret_hex,
        "recovery_auth_secret_hex": recovery_auth_secret,
        "kdf_version": account.kdf_version,
        "salt_hex": account.salt_hex,
        "argon_params": argon_params(),
        "protected_vk_hex": account.protected_vk_hex,
        "protected_vk_nonce_hex": account.protected_vk_nonce_hex,
        "recovery_salt_hex": account.recovery_salt_hex,
        "recovery_protected_vk_hex": account.recovery_protected_vk_hex,
        "recovery_protected_vk_nonce_hex": account.recovery_protected_vk_nonce_hex,
    });
    let resp = post(&base_url, "/v1/auth/register", None, &body)?;
    let token = resp["token"].as_str().ok_or("no token in response")?.to_string();

    let mut g = state.inner.lock().unwrap();
    *g = Session {
        base_url,
        email,
        token: Some(token.clone()),
        account: Some(account.clone()),
        vk: Some(vk),
    };
    Ok(RegisterResult { token, recovery_code: rec.code, account })
}

/// Fetch an account's public salt + E2EE-wrapped material by email (pre-auth).
///
/// Login is fetch-then-unlock: the auth secret is derived from password+salt, and the salt
/// is not secret, so a fresh device fetches the material first (this call), then
/// [`cloud_unlock`] derives keys and logs in. Safe: returns only public salt + ciphertext,
/// mirroring the server's recover-begin.
#[tauri::command(rename_all = "camelCase")]
pub fn cloud_login_fetch(base_url: String, email: String) -> R<AccountMaterial> {
    let resp = post(&base_url, "/v1/auth/recover-begin", None, &json!({ "email": email }))?;
    parse_account_material(&resp)
}

fn parse_account_material(v: &Value) -> R<AccountMaterial> {
    Ok(AccountMaterial {
        kdf_version: v["kdf_version"].as_u64().unwrap_or(KDF_VERSION as u64) as u32,
        salt_hex: v["salt_hex"].as_str().unwrap_or_default().to_string(),
        protected_vk_hex: v["protected_vk_hex"].as_str().unwrap_or_default().to_string(),
        protected_vk_nonce_hex: v["protected_vk_nonce_hex"].as_str().unwrap_or_default().to_string(),
        recovery_salt_hex: v["recovery_salt_hex"].as_str().unwrap_or_default().to_string(),
        recovery_protected_vk_hex: v["recovery_protected_vk_hex"].as_str().unwrap_or_default().to_string(),
        recovery_protected_vk_nonce_hex: v["recovery_protected_vk_nonce_hex"].as_str().unwrap_or_default().to_string(),
    })
}

/// Unlock with the master password + cached/fetched account material. Derives the auth
/// secret and logs in to obtain a session token, and holds VK in memory.
#[tauri::command(rename_all = "camelCase")]
pub fn cloud_unlock(
    state: State<SyncState>,
    base_url: String,
    email: String,
    master_password: String,
    account: AccountMaterial,
) -> R<String> {
    let vk = unlock_vk(&master_password, &account)?; // verifies password locally

    // Derive the auth secret and log in for a token.
    let salt = hex::decode(&account.salt_hex).map_err(|e| e.to_string())?;
    let master_key = derive_master_key(&master_password, &salt).map_err(|e| e.to_string())?;
    let auth_secret_hex = hex::encode(derive_auth_secret(&master_key));
    let resp = post(&base_url, "/v1/auth/login", None, &json!({
        "email": email, "auth_secret_hex": auth_secret_hex,
    }))?;
    let token = resp["token"].as_str().ok_or("login failed")?.to_string();

    let mut g = state.inner.lock().unwrap();
    *g = Session {
        base_url,
        email,
        token: Some(token.clone()),
        account: Some(account),
        vk: Some(vk),
    };
    Ok(token)
}

#[tauri::command]
pub fn cloud_lock(state: State<SyncState>) {
    let mut g = state.inner.lock().unwrap();
    g.vk = None; // Key zeroizes on drop
    g.token = None;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudStatus {
    pub signed_in: bool,
    pub unlocked: bool,
    pub email: String,
}

#[tauri::command]
pub fn cloud_status(state: State<SyncState>) -> CloudStatus {
    let g = state.inner.lock().unwrap();
    CloudStatus {
        signed_in: g.account.is_some(),
        unlocked: g.vk.is_some(),
        email: g.email.clone(),
    }
}

// ---- record sync ----
//
// A vault record's plaintext is `{ "host": <non-secret host fields>, "secret": <password or
// key passphrase>, "keyContent": <private key PEM> }`. The frontend only ever supplies and
// receives the non-secret host fields; the secret + key material are read from / written to
// the OS keyring and a managed key-file dir here in Rust, so plaintext secrets never enter
// the webview.

const KEYRING_SERVICE: &str = "TermDeck";

fn keyring_entry(id: &str) -> R<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("ssh:{id}")).map_err(|e| e.to_string())
}
fn secret_get(id: &str) -> String {
    keyring_entry(id).ok().and_then(|e| e.get_password().ok()).unwrap_or_default()
}
fn secret_put(id: &str, value: &str) -> R<()> {
    let e = keyring_entry(id)?;
    if value.is_empty() {
        let _ = e.delete_credential();
        Ok(())
    } else {
        e.set_password(value).map_err(|e| e.to_string())
    }
}

/// Assemble the encrypted-record plaintext from its parts (pure; unit-tested).
fn build_plaintext(host: &Value, secret: &str, key_content: &str) -> String {
    json!({ "host": host, "secret": secret, "keyContent": key_content }).to_string()
}
/// Split a decrypted record back into (host, secret, keyContent) (pure; unit-tested).
fn split_plaintext(pt: &str) -> R<(Value, String, String)> {
    let v: Value = serde_json::from_str(pt).map_err(|e| e.to_string())?;
    Ok((
        v["host"].clone(),
        v["secret"].as_str().unwrap_or_default().to_string(),
        v["keyContent"].as_str().unwrap_or_default().to_string(),
    ))
}

fn keys_dir(app: &tauri::AppHandle) -> R<std::path::PathBuf> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("vault-keys");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushHost {
    pub id: String,
    /// The host's non-secret fields as JSON (empty when `deleted`).
    #[serde(default)]
    pub host_json: String,
    #[serde(default)]
    pub deleted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PulledHost {
    pub id: String,
    pub host_json: String,
    pub deleted: bool,
    pub seq: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullResult {
    pub records: Vec<PulledHost>,
    pub cursor: i64,
}

/// Encrypt each host (meta + its keyring secret + key file) with VK and upload.
#[tauri::command(rename_all = "camelCase")]
pub fn cloud_push(state: State<SyncState>, records: Vec<PushHost>) -> R<i64> {
    let g = state.inner.lock().unwrap();
    let vk = g.vk.as_ref().ok_or("vault is locked")?;
    let token = g.token.as_deref().ok_or("not signed in")?;
    let base_url = g.base_url.clone();

    let mut changes = Vec::with_capacity(records.len());
    for r in &records {
        if r.deleted {
            changes.push(json!({ "id": r.id, "ciphertext_hex": "", "nonce_hex": "", "deleted": true }));
            continue;
        }
        let host: Value = serde_json::from_str(&r.host_json).map_err(|e| e.to_string())?;
        let secret = secret_get(&format!("{}:term", r.id));
        let key_content = if host["auth"] == "key" {
            match host["keyPath"].as_str() {
                Some(p) if !p.is_empty() => std::fs::read_to_string(p).unwrap_or_default(),
                _ => String::new(),
            }
        } else {
            String::new()
        };
        let sealed = seal(vk, build_plaintext(&host, &secret, &key_content).as_bytes())
            .map_err(|e| e.to_string())?;
        let (ct, nonce) = sealed_to_hex(&sealed);
        changes.push(json!({ "id": r.id, "ciphertext_hex": ct, "nonce_hex": nonce, "deleted": false }));
    }
    let resp = post(&base_url, "/v1/sync", Some(token), &json!({ "changes": changes }))?;
    Ok(resp["cursor"].as_i64().unwrap_or(0))
}

/// Download records since `since`, decrypt with VK, restore secrets to the keyring + key
/// files locally, and return only the non-secret host fields to the frontend.
#[tauri::command(rename_all = "camelCase")]
pub fn cloud_pull(app: tauri::AppHandle, state: State<SyncState>, since: i64) -> R<PullResult> {
    let (vk_present, token, base_url) = {
        let g = state.inner.lock().unwrap();
        (g.vk.is_some(), g.token.clone(), g.base_url.clone())
    };
    if !vk_present {
        return Err("vault is locked".into());
    }
    let token = token.ok_or("not signed in")?;
    let resp = get(&base_url, &format!("/v1/sync?since={since}"), &token)?;
    let cursor = resp["cursor"].as_i64().unwrap_or(0);

    let g = state.inner.lock().unwrap();
    let vk = g.vk.as_ref().ok_or("vault is locked")?;
    let mut out = Vec::new();
    if let Some(arr) = resp["records"].as_array() {
        for r in arr {
            let id = r["id"].as_str().unwrap_or_default().to_string();
            let seq = r["seq"].as_i64().unwrap_or(0);
            if r["deleted"].as_bool().unwrap_or(false) {
                out.push(PulledHost { id, host_json: String::new(), deleted: true, seq });
                continue;
            }
            let sealed = hex_to_sealed(
                r["ciphertext_hex"].as_str().unwrap_or_default(),
                r["nonce_hex"].as_str().unwrap_or_default(),
            )?;
            let pt = open(vk, &sealed).map_err(|_| "decrypt failed (wrong vault key)".to_string())?;
            let pt = String::from_utf8(pt).map_err(|e| e.to_string())?;
            let (mut host, secret, key_content) = split_plaintext(&pt)?;

            // Restore the secret to the keyring for both derived sessions.
            secret_put(&format!("{id}:term"), &secret)?;
            secret_put(&format!("{id}:sftp"), &secret)?;

            // Materialize a synced private key to a managed file and repoint keyPath.
            if !key_content.is_empty() {
                let path = keys_dir(&app)?.join(format!("{id}.pem"));
                std::fs::write(&path, key_content.as_bytes()).map_err(|e| e.to_string())?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
                }
                host["keyPath"] = json!(path.to_string_lossy());
            }
            out.push(PulledHost { id, host_json: host.to_string(), deleted: false, seq });
        }
    }
    Ok(PullResult { records: out, cursor })
}

/// Change the master password: re-wrap the in-memory VK under a new KEK and upload the new
/// protected key + auth secret. Records are untouched (VK unchanged). Returns the new
/// account material for the frontend to cache.
#[tauri::command(rename_all = "camelCase")]
pub fn cloud_change_password(state: State<SyncState>, new_master_password: String) -> R<AccountMaterial> {
    let mut g = state.inner.lock().unwrap();
    let vk = g.vk.as_ref().ok_or("vault is locked")?;
    let token = g.token.as_deref().ok_or("not signed in")?.to_string();
    let base_url = g.base_url.clone();
    let old = g.account.as_ref().ok_or("no account")?;
    let recovery = AccountMaterialRecovery {
        salt_hex: old.recovery_salt_hex.clone(),
        protected_vk_hex: old.recovery_protected_vk_hex.clone(),
        protected_vk_nonce_hex: old.recovery_protected_vk_nonce_hex.clone(),
    };
    let (account, auth_secret_hex) = build_account_material(&new_master_password, vk, &recovery)?;
    post(&base_url, "/v1/auth/change-password", Some(&token), &json!({
        "new_auth_secret_hex": auth_secret_hex,
        "kdf_version": account.kdf_version,
        "salt_hex": account.salt_hex,
        "argon_params": argon_params(),
        "protected_vk_hex": account.protected_vk_hex,
        "protected_vk_nonce_hex": account.protected_vk_nonce_hex,
        "recovery_salt_hex": account.recovery_salt_hex,
        "recovery_protected_vk_hex": account.recovery_protected_vk_hex,
        "recovery_protected_vk_nonce_hex": account.recovery_protected_vk_nonce_hex,
    }))?;
    g.account = Some(account.clone());
    Ok(account)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverResult {
    pub token: String,
    pub account: AccountMaterial,
}

/// Recover access with the recovery code: fetch the recovery material, unwrap VK with the
/// recovery key, set a fresh master password, and sign in. VK (and thus all records) is
/// preserved.
#[tauri::command(rename_all = "camelCase")]
pub fn cloud_recover_complete(
    state: State<SyncState>,
    base_url: String,
    email: String,
    recovery_code: String,
    new_master_password: String,
) -> R<RecoverResult> {
    let material = {
        let resp = post(&base_url, "/v1/auth/recover-begin", None, &json!({ "email": email }))?;
        parse_account_material(&resp)?
    };
    // Derive the recovery key and unwrap VK.
    let rec_salt = hex::decode(&material.recovery_salt_hex).map_err(|e| e.to_string())?;
    let rec_key = derive_recovery_key(&recovery_code, &rec_salt).map_err(|e| e.to_string())?;
    let rec_protected = hex_to_sealed(&material.recovery_protected_vk_hex, &material.recovery_protected_vk_nonce_hex)?;
    let vk = unwrap_vault_key(&rec_key, &rec_protected).map_err(|_| "invalid recovery code".to_string())?;
    let recovery_auth_secret = hex::encode(derive_auth_secret(&rec_key));

    // Build fresh master-password material (keep the recovery half stable).
    let recovery = AccountMaterialRecovery {
        salt_hex: material.recovery_salt_hex.clone(),
        protected_vk_hex: material.recovery_protected_vk_hex.clone(),
        protected_vk_nonce_hex: material.recovery_protected_vk_nonce_hex.clone(),
    };
    let (account, auth_secret_hex) = build_account_material(&new_master_password, &vk, &recovery)?;

    let resp = post(&base_url, "/v1/auth/recover-complete", None, &json!({
        "email": email,
        "recovery_auth_secret_hex": recovery_auth_secret,
        "new_auth_secret_hex": auth_secret_hex,
        "kdf_version": account.kdf_version,
        "salt_hex": account.salt_hex,
        "argon_params": argon_params(),
        "protected_vk_hex": account.protected_vk_hex,
        "protected_vk_nonce_hex": account.protected_vk_nonce_hex,
        "recovery_salt_hex": account.recovery_salt_hex,
        "recovery_protected_vk_hex": account.recovery_protected_vk_hex,
        "recovery_protected_vk_nonce_hex": account.recovery_protected_vk_nonce_hex,
    }))?;
    let token = resp["token"].as_str().ok_or("recover failed")?.to_string();

    let mut g = state.inner.lock().unwrap();
    *g = Session { base_url, email, token: Some(token.clone()), account: Some(account.clone()), vk: Some(vk) };
    Ok(RecoverResult { token, account })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unlock_roundtrip_and_wrong_password() {
        // Register-equivalent material built locally, then unlock verifies the password.
        let vk = generate_vault_key();
        let rec = generate_recovery().unwrap();
        let rec_wrap = wrap_vault_key(&rec.key, &vk).unwrap();
        let (rec_ct, rec_nonce) = sealed_to_hex(&rec_wrap);
        let recovery = AccountMaterialRecovery {
            salt_hex: hex::encode(rec.salt),
            protected_vk_hex: rec_ct,
            protected_vk_nonce_hex: rec_nonce,
        };
        let (account, _auth) = build_account_material("pw", &vk, &recovery).unwrap();

        let unlocked = unlock_vk("pw", &account).unwrap();
        assert_eq!(unlocked.0, vk.0);
        assert!(unlock_vk("nope", &account).is_err(), "wrong password must fail");
    }

    #[test]
    fn record_seal_open_via_vk() {
        let vk = generate_vault_key();
        let json = r#"{"type":"host","host":"1.2.3.4"}"#;
        let sealed = seal(&vk, json.as_bytes()).unwrap();
        let (ct, nonce) = sealed_to_hex(&sealed);
        let back = hex_to_sealed(&ct, &nonce).unwrap();
        assert_eq!(open(&vk, &back).unwrap(), json.as_bytes());
    }

    #[test]
    fn plaintext_build_split_roundtrip() {
        let host = json!({"id":"h1","host":"1.2.3.4","user":"root","auth":"key","keyPath":"/tmp/k.pem"});
        let pt = build_plaintext(&host, "hunter2", "-----BEGIN KEY-----\nabc\n-----END KEY-----");
        let (h, secret, key) = split_plaintext(&pt).unwrap();
        assert_eq!(h["host"], "1.2.3.4");
        assert_eq!(secret, "hunter2");
        assert!(key.contains("BEGIN KEY"));
    }

    #[test]
    fn full_record_roundtrip_through_vk() {
        let vk = generate_vault_key();
        let host = json!({"id":"h1","host":"1.2.3.4","auth":"password"});
        let pt = build_plaintext(&host, "s3cr3t", "");
        let sealed = seal(&vk, pt.as_bytes()).unwrap();
        let (ct, nonce) = sealed_to_hex(&sealed);
        let opened = String::from_utf8(open(&vk, &hex_to_sealed(&ct, &nonce).unwrap()).unwrap()).unwrap();
        let (h, secret, _key) = split_plaintext(&opened).unwrap();
        assert_eq!(h["id"], "h1");
        assert_eq!(secret, "s3cr3t");
    }
}
