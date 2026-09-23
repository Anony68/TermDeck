//! Desktop-side actor for the cross-platform live sync proof: registers an account and
//! pushes one encrypted host to the sync server, using the exact scheme + record format as
//! the desktop app (`src-tauri/cloud.rs`). An Android VaultManager can then unlock the same
//! account and decrypt the host — proving desktop → Android interop over the wire.
//!
//! Env: BASE_URL, SYNC_EMAIL, SYNC_PW. Run: cargo run --example desktop-push

use std::io::Read;
use serde_json::json;
use vault_crypto::*;

fn post(base: &str, path: &str, token: Option<&str>, body: &serde_json::Value) -> serde_json::Value {
    let mut req = ureq::post(&format!("{base}{path}")).header("content-type", "application/json");
    if let Some(t) = token {
        req = req.header("authorization", &format!("Bearer {t}"));
    }
    let resp = req.send(body.to_string()).expect("http");
    let mut s = String::new();
    resp.into_body().into_reader().read_to_string(&mut s).unwrap();
    if s.is_empty() { serde_json::Value::Null } else { serde_json::from_str(&s).unwrap() }
}

fn hexs(s: &Sealed) -> (String, String) {
    (hex::encode(&s.ciphertext), hex::encode(s.nonce))
}

fn main() {
    let base = std::env::var("BASE_URL").unwrap();
    let email = std::env::var("SYNC_EMAIL").unwrap();
    let pw = std::env::var("SYNC_PW").unwrap();

    let vk = generate_vault_key();
    let rec = generate_recovery().unwrap();
    let (rec_ct, rec_nonce) = hexs(&wrap_vault_key(&rec.key, &vk).unwrap());
    let recovery_auth = hex::encode(derive_auth_secret(&rec.key));

    let salt = generate_salt();
    let mk = derive_master_key(&pw, &salt).unwrap();
    let kek = derive_kek(&mk);
    let auth = hex::encode(derive_auth_secret(&mk));
    let (pv_ct, pv_nonce) = hexs(&wrap_vault_key(&kek, &vk).unwrap());

    let token = post(&base, "/v1/auth/register", None, &json!({
        "email": email, "auth_secret_hex": auth, "recovery_auth_secret_hex": recovery_auth,
        "kdf_version": KDF_VERSION, "salt_hex": hex::encode(salt),
        "argon_params": { "m": ARGON_M_COST, "t": ARGON_T_COST, "p": ARGON_P_COST },
        "protected_vk_hex": pv_ct, "protected_vk_nonce_hex": pv_nonce,
        "recovery_salt_hex": hex::encode(rec.salt), "recovery_protected_vk_hex": rec_ct,
        "recovery_protected_vk_nonce_hex": rec_nonce,
    }))["token"].as_str().unwrap().to_string();

    // Same record plaintext shape as cloud.rs: {host, secret, keyContent}.
    let host = json!({ "id": "desk1", "name": "From Desktop", "host": "10.9.9.9", "port": 22, "user": "root", "auth": "password" });
    let plaintext = json!({ "host": host, "secret": "from-desktop-secret", "keyContent": "" }).to_string();
    let (ct, nonce) = hexs(&seal(&vk, plaintext.as_bytes()).unwrap());
    let cursor = post(&base, "/v1/sync", Some(&token), &json!({
        "changes": [{ "id": "desk1", "ciphertext_hex": ct, "nonce_hex": nonce, "deleted": false }]
    }))["cursor"].clone();

    println!("desktop pushed host 'desk1' for {email} (cursor={cursor})");
}
