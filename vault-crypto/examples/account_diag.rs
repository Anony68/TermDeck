//! Local diagnostic: reproduces the desktop app's unlock → login → pull against the live
//! server using the cached account material in the Tauri store, to pinpoint why sync isn't
//! working. Prompts for the master password on stdin (stays local; never printed).
//!
//! Run in Terminal:  cargo run --quiet --example account-diag

use std::io::{Read, Write};
use serde_json::Value;
use vault_crypto::*;

fn post(base: &str, path: &str, token: Option<&str>, body: &Value) -> (u16, Value) {
    let mut req = ureq::post(&format!("{base}{path}")).header("content-type", "application/json");
    if let Some(t) = token { req = req.header("authorization", &format!("Bearer {t}")); }
    match req.send(body.to_string()) {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let mut s = String::new();
            let _ = resp.into_body().into_reader().read_to_string(&mut s);
            (status, serde_json::from_str(&s).unwrap_or(Value::Null))
        }
        Err(ureq::Error::StatusCode(code)) => (code, Value::Null),
        Err(e) => { println!("   http error: {e}"); (0, Value::Null) }
    }
}

fn main() {
    let store_path = format!("{}/Library/Application Support/com.termdeck.app/termdeck.json",
        std::env::var("HOME").unwrap());
    let raw: Value = serde_json::from_str(&std::fs::read_to_string(&store_path).expect("read store")).unwrap();
    let st = raw.get("state").unwrap_or(&raw);
    let c = &st["cloud"];
    let base = c["baseUrl"].as_str().unwrap_or("");
    let email = c["email"].as_str().unwrap_or("");
    let acct = &c["account"];
    let salt_hex = acct["saltHex"].as_str().unwrap_or("");
    let pv_hex = acct["protectedVkHex"].as_str().unwrap_or("");
    let pv_nonce = acct["protectedVkNonceHex"].as_str().unwrap_or("");
    let hosts = st["hosts"].as_array().cloned().unwrap_or_default();

    println!("server : {base}");
    println!("email  : {email}");
    println!("hosts  : {} local", hosts.len());
    println!("account cached: {}", if acct.is_object() { "yes" } else { "NO (never signed in)" });

    print!("\nMaster password: ");
    std::io::stdout().flush().unwrap();
    let mut pw = String::new();
    std::io::stdin().read_line(&mut pw).unwrap();
    let pw = pw.trim_end_matches(['\n', '\r']);

    // 1) unlock — derive KEK from password + cached salt, unwrap the vault key.
    let salt = hex::decode(salt_hex).unwrap_or_default();
    let mk = match derive_master_key(pw, &salt) { Ok(k) => k, Err(e) => { println!("[1] derive: {e}"); return; } };
    let kek = derive_kek(&mk);
    let sealed = Sealed { nonce: {
        let n = hex::decode(pv_nonce).unwrap_or_default();
        let mut a = [0u8; 24]; a.copy_from_slice(&n[..24.min(n.len())]); a
    }, ciphertext: hex::decode(pv_hex).unwrap_or_default() };
    match unwrap_vault_key(&kek, &sealed) {
        Ok(_) => println!("[1] unlock (password → vault key): OK ✅"),
        Err(_) => { println!("[1] unlock: FAIL ❌  → sai MẬT KHẨU CHÍNH (khác lúc đăng ký tài khoản này)"); return; }
    }

    // 2) login — server verifies the derived auth secret.
    let auth = hex::encode(derive_auth_secret(&mk));
    let (code, body) = post(base, "/v1/auth/login", None, &serde_json::json!({ "email": email, "auth_secret_hex": auth }));
    let token = body["token"].as_str().unwrap_or("");
    if code == 200 && !token.is_empty() {
        println!("[2] login (server auth): OK ✅");
    } else {
        println!("[2] login: FAIL ❌ (http {code}) → tài khoản trên server dùng mật khẩu/khóa khác (có thể đăng ký ở máy khác)");
        return;
    }

    // 3) pull — proves the token works and shows what's on the server.
    let base_owned = base.to_string();
    let url = format!("{}/v1/sync?since=0", base_owned.trim_end_matches('/'));
    let resp = ureq::get(&url).header("authorization", &format!("Bearer {token}")).call();
    match resp {
        Ok(r) => {
            let mut s = String::new();
            let _ = r.into_body().into_reader().read_to_string(&mut s);
            let v: Value = serde_json::from_str(&s).unwrap_or(Value::Null);
            let n = v["records"].as_array().map(|a| a.len()).unwrap_or(0);
            println!("[3] pull: OK ✅  server đang có {n} record, cursor={}", v["cursor"]);
        }
        Err(e) => println!("[3] pull: FAIL ❌ {e}"),
    }
    println!("\nKết luận: nếu [1][2][3] đều OK thì đăng nhập/kết nối tốt — vấn đề chỉ là bấm 'Đồng bộ ngay' trên bản mới để đẩy VPS.");
}
