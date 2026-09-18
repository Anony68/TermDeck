//! Emit `test-vectors.json` — the cross-language crypto contract. The Android (Kotlin)
//! re-implementation must reproduce every output byte-for-byte from the same inputs.
//!
//! Run: `cargo run --example gen-vectors > test-vectors.json`

use vault_crypto::*;

fn main() {
    let password = "correct horse battery staple";
    let salt = [0x07u8; 16];
    let vk_bytes = [0x2au8; 32];
    let kek_nonce = [0x01u8; 24];
    let record_nonce = [0x02u8; 24];
    let record_plaintext = br#"{"type":"host","host":"203.0.113.7","port":22,"user":"root","secret":"hunter2"}"#;
    let recovery_code = "ABCD-EF12-GH34-JK56-MN78-PQ90";
    let recovery_salt = [0x09u8; 16];

    let master_key = derive_master_key(password, &salt).unwrap();
    let kek = derive_kek(&master_key);
    let auth_secret = derive_auth_secret(&master_key);

    let vk = Key(vk_bytes);

    let protected_vk = seal_with_nonce(&kek, &kek_nonce, &vk.0).unwrap();
    let record = seal_with_nonce(&vk, &record_nonce, record_plaintext).unwrap();

    let recovery_key = derive_recovery_key(recovery_code, &recovery_salt).unwrap();
    let recovery_protected_vk = seal_with_nonce(&recovery_key, &kek_nonce, &vk.0).unwrap();

    println!("{{");
    println!("  \"kdf_version\": {},", KDF_VERSION);
    println!("  \"argon\": {{ \"m_cost\": {}, \"t_cost\": {}, \"p_cost\": {} }},", ARGON_M_COST, ARGON_T_COST, ARGON_P_COST);
    println!("  \"password\": {:?},", password);
    println!("  \"salt_hex\": \"{}\",", hex::encode(salt));
    println!("  \"master_key_hex\": \"{}\",", hex::encode(&master_key.0));
    println!("  \"kek_hex\": \"{}\",", hex::encode(&kek.0));
    println!("  \"auth_secret_hex\": \"{}\",", hex::encode(auth_secret));
    println!("  \"vk_hex\": \"{}\",", hex::encode(vk_bytes));
    println!("  \"kek_nonce_hex\": \"{}\",", hex::encode(kek_nonce));
    println!("  \"protected_vk_hex\": \"{}\",", hex::encode(&protected_vk.ciphertext));
    println!("  \"record_plaintext\": {:?},", std::str::from_utf8(record_plaintext).unwrap());
    println!("  \"record_nonce_hex\": \"{}\",", hex::encode(record_nonce));
    println!("  \"record_ciphertext_hex\": \"{}\",", hex::encode(&record.ciphertext));
    println!("  \"recovery_code\": {:?},", recovery_code);
    println!("  \"recovery_salt_hex\": \"{}\",", hex::encode(recovery_salt));
    println!("  \"recovery_key_hex\": \"{}\",", hex::encode(&recovery_key.0));
    println!("  \"recovery_protected_vk_hex\": \"{}\"", hex::encode(&recovery_protected_vk.ciphertext));
    println!("}}");
}
