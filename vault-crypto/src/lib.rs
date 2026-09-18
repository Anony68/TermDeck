//! TermDeck E2EE vault cryptography.
//!
//! The scheme (Bitwarden/1Password-style) turns a single master password into two
//! independent secrets — a **KEK** that wraps the random per-account **vault key (VK)**,
//! and an **auth secret** the client sends to the server to log in. The server only ever
//! stores ciphertext + the auth *hash*; it can never derive VK or read a record.
//!
//! Every parameter here is fixed and versioned ([`KDF_VERSION`]) so the Rust desktop
//! client, this reference implementation, and the Android (Kotlin) re-implementation all
//! produce identical bytes. `examples/gen_vectors.rs` emits `test-vectors.json`, the
//! cross-language contract Android is tested against.
//!
//! AEAD: XChaCha20-Poly1305 (24-byte nonce, 16-byte tag). KDF: Argon2id.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;
use zeroize::Zeroize;

/// Bumped only when the KDF/AEAD scheme changes; stored per account so old vaults migrate.
pub const KDF_VERSION: u32 = 1;

/// Argon2id memory in KiB (64 MiB).
pub const ARGON_M_COST: u32 = 64 * 1024;
/// Argon2id iterations.
pub const ARGON_T_COST: u32 = 3;
/// Argon2id parallelism.
pub const ARGON_P_COST: u32 = 4;

const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 24;
const SALT_LEN: usize = 16;
const RECOVERY_CODE_LEN: usize = 20;

const HKDF_INFO_KEK: &[u8] = b"termdeck-kek";
const HKDF_INFO_AUTH: &[u8] = b"termdeck-auth";

/// A 32-byte symmetric key that zeroizes itself on drop.
#[derive(Clone, Zeroize)]
#[zeroize(drop)]
pub struct Key(pub [u8; KEY_LEN]);

impl Key {
    fn from_slice(s: &[u8]) -> Self {
        let mut k = [0u8; KEY_LEN];
        k.copy_from_slice(s);
        Key(k)
    }
}

/// Ciphertext plus the random nonce it was produced with (both stored server-side).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sealed {
    pub nonce: [u8; NONCE_LEN],
    pub ciphertext: Vec<u8>,
}

#[derive(Debug)]
pub enum CryptoError {
    Kdf,
    Aead,
    BadLength,
    BadRecoveryCode,
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CryptoError::Kdf => write!(f, "key derivation failed"),
            CryptoError::Aead => write!(f, "decryption failed (wrong key or corrupt data)"),
            CryptoError::BadLength => write!(f, "invalid key/nonce length"),
            CryptoError::BadRecoveryCode => write!(f, "invalid recovery code"),
        }
    }
}
impl std::error::Error for CryptoError {}

fn argon2() -> Argon2<'static> {
    let params = Params::new(ARGON_M_COST, ARGON_T_COST, ARGON_P_COST, Some(KEY_LEN))
        .expect("valid argon2 params");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

/// `masterKey = Argon2id(masterPassword, salt)`. The root secret; never leaves the client.
pub fn derive_master_key(master_password: &str, salt: &[u8]) -> Result<Key, CryptoError> {
    let mut out = [0u8; KEY_LEN];
    argon2()
        .hash_password_into(master_password.as_bytes(), salt, &mut out)
        .map_err(|_| CryptoError::Kdf)?;
    let k = Key::from_slice(&out);
    out.zeroize();
    Ok(k)
}

fn hkdf_expand(master_key: &Key, info: &[u8]) -> Key {
    let hk = Hkdf::<Sha256>::new(None, &master_key.0);
    let mut out = [0u8; KEY_LEN];
    hk.expand(info, &mut out).expect("32 is a valid HKDF length");
    let k = Key::from_slice(&out);
    out.zeroize();
    k
}

/// Key-encryption key: wraps/unwraps the vault key. `HKDF(masterKey, "termdeck-kek")`.
pub fn derive_kek(master_key: &Key) -> Key {
    hkdf_expand(master_key, HKDF_INFO_KEK)
}

/// Auth secret sent to the server at login. `HKDF(masterKey, "termdeck-auth")`.
/// The server stores only `argon2id(authSecret)`, so this value proves knowledge of the
/// master password without revealing it or the KEK.
pub fn derive_auth_secret(master_key: &Key) -> [u8; KEY_LEN] {
    hkdf_expand(master_key, HKDF_INFO_AUTH).0
}

/// Encrypt `plaintext` under `key` with a fresh random nonce (XChaCha20-Poly1305).
pub fn seal(key: &Key, plaintext: &[u8]) -> Result<Sealed, CryptoError> {
    let mut nonce = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce);
    seal_with_nonce(key, &nonce, plaintext)
}

/// Deterministic variant used by the test-vector generator. Prefer [`seal`] in production.
pub fn seal_with_nonce(key: &Key, nonce: &[u8; NONCE_LEN], plaintext: &[u8]) -> Result<Sealed, CryptoError> {
    let cipher = XChaCha20Poly1305::new_from_slice(&key.0).map_err(|_| CryptoError::BadLength)?;
    let ct = cipher
        .encrypt(XNonce::from_slice(nonce), Payload { msg: plaintext, aad: b"" })
        .map_err(|_| CryptoError::Aead)?;
    Ok(Sealed { nonce: *nonce, ciphertext: ct })
}

/// Decrypt a [`Sealed`] value under `key`. Fails ([`CryptoError::Aead`]) on wrong key or
/// tampering.
pub fn open(key: &Key, sealed: &Sealed) -> Result<Vec<u8>, CryptoError> {
    let cipher = XChaCha20Poly1305::new_from_slice(&key.0).map_err(|_| CryptoError::BadLength)?;
    cipher
        .decrypt(XNonce::from_slice(&sealed.nonce), Payload { msg: &sealed.ciphertext, aad: b"" })
        .map_err(|_| CryptoError::Aead)
}

/// Generate a fresh random vault key. Created once per account at registration.
pub fn generate_vault_key() -> Key {
    let mut k = [0u8; KEY_LEN];
    rand::thread_rng().fill_bytes(&mut k);
    let key = Key::from_slice(&k);
    k.zeroize();
    key
}

/// Random per-account salt for [`derive_master_key`].
pub fn generate_salt() -> [u8; SALT_LEN] {
    let mut s = [0u8; SALT_LEN];
    rand::thread_rng().fill_bytes(&mut s);
    s
}

/// Wrap the vault key with the KEK for storage on the server (`protectedVK`).
pub fn wrap_vault_key(kek: &Key, vk: &Key) -> Result<Sealed, CryptoError> {
    seal(kek, &vk.0)
}

/// Unwrap `protectedVK` back into the vault key.
pub fn unwrap_vault_key(kek: &Key, protected: &Sealed) -> Result<Key, CryptoError> {
    let bytes = open(kek, protected)?;
    if bytes.len() != KEY_LEN {
        return Err(CryptoError::BadLength);
    }
    Ok(Key::from_slice(&bytes))
}

/// A human-facing recovery code (Base32, dash-grouped) and the key derived from it.
pub struct Recovery {
    pub code: String,
    pub salt: [u8; SALT_LEN],
    pub key: Key,
}

/// Create a fresh recovery code + its derived key. Show `code` to the user once; store
/// `salt` and `wrap_vault_key(&key, vk)` server-side as the recovery path.
pub fn generate_recovery() -> Result<Recovery, CryptoError> {
    let mut raw = [0u8; RECOVERY_CODE_LEN];
    rand::thread_rng().fill_bytes(&mut raw);
    let code = format_recovery_code(&raw);
    raw.zeroize();
    let salt = generate_salt();
    let key = derive_recovery_key(&code, &salt)?;
    Ok(Recovery { code, salt, key })
}

/// Re-derive the recovery key from a user-entered code + stored salt (Argon2id).
pub fn derive_recovery_key(code: &str, salt: &[u8]) -> Result<Key, CryptoError> {
    let normalized = normalize_recovery_code(code);
    if normalized.is_empty() {
        return Err(CryptoError::BadRecoveryCode);
    }
    let mut out = [0u8; KEY_LEN];
    argon2()
        .hash_password_into(normalized.as_bytes(), salt, &mut out)
        .map_err(|_| CryptoError::Kdf)?;
    let k = Key::from_slice(&out);
    out.zeroize();
    Ok(k)
}

/// Base32 (no padding), grouped in 4s with dashes: `XXXX-XXXX-…`.
fn format_recovery_code(raw: &[u8]) -> String {
    let b32 = base32::encode(base32::Alphabet::Rfc4648 { padding: false }, raw);
    b32.as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).unwrap())
        .collect::<Vec<_>>()
        .join("-")
}

/// Strip dashes/whitespace and upper-case, so display formatting never affects the key.
fn normalize_recovery_code(code: &str) -> String {
    code.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PW: &str = "correct horse battery staple";
    const SALT: [u8; SALT_LEN] = [7u8; SALT_LEN];

    #[test]
    fn derivation_is_deterministic() {
        let mk1 = derive_master_key(PW, &SALT).unwrap();
        let mk2 = derive_master_key(PW, &SALT).unwrap();
        assert_eq!(mk1.0, mk2.0, "argon2id must be deterministic for the same inputs");
        // KEK and auth secret must be independent (different HKDF info).
        assert_ne!(derive_kek(&mk1).0, derive_auth_secret(&mk1));
    }

    #[test]
    fn wrong_password_yields_different_key() {
        let a = derive_master_key(PW, &SALT).unwrap();
        let b = derive_master_key("wrong", &SALT).unwrap();
        assert_ne!(a.0, b.0);
    }

    #[test]
    fn vault_key_wrap_roundtrip() {
        let mk = derive_master_key(PW, &SALT).unwrap();
        let kek = derive_kek(&mk);
        let vk = generate_vault_key();
        let protected = wrap_vault_key(&kek, &vk).unwrap();
        let unwrapped = unwrap_vault_key(&kek, &protected).unwrap();
        assert_eq!(vk.0, unwrapped.0);
    }

    #[test]
    fn wrong_kek_fails_to_unwrap() {
        let vk = generate_vault_key();
        let kek = generate_vault_key();
        let other = generate_vault_key();
        let protected = wrap_vault_key(&kek, &vk).unwrap();
        assert!(matches!(unwrap_vault_key(&other, &protected), Err(CryptoError::Aead)));
    }

    #[test]
    fn record_encrypt_roundtrip() {
        let vk = generate_vault_key();
        let plaintext = br#"{"type":"host","host":"1.2.3.4","user":"root","secret":"hunter2"}"#;
        let sealed = seal(&vk, plaintext).unwrap();
        assert_ne!(&sealed.ciphertext[..], &plaintext[..], "must not store plaintext");
        assert_eq!(open(&vk, &sealed).unwrap(), plaintext);
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let vk = generate_vault_key();
        let mut sealed = seal(&vk, b"secret").unwrap();
        sealed.ciphertext[0] ^= 0xff;
        assert!(matches!(open(&vk, &sealed), Err(CryptoError::Aead)));
    }

    #[test]
    fn recovery_roundtrip_unwraps_vault_key() {
        let vk = generate_vault_key();
        let rec = generate_recovery().unwrap();
        let protected = wrap_vault_key(&rec.key, &vk).unwrap();
        // Later: user types the code back (with display dashes) → must recover VK.
        let rederived = derive_recovery_key(&rec.code, &rec.salt).unwrap();
        let unwrapped = unwrap_vault_key(&rederived, &protected).unwrap();
        assert_eq!(vk.0, unwrapped.0);
    }

    #[test]
    fn recovery_code_normalization_ignores_formatting() {
        assert_eq!(normalize_recovery_code("abcd-EF12  gh"), "ABCDEF12GH");
    }
}
