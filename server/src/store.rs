//! Domain types + the storage abstraction. The server logic depends only on the [`Store`]
//! trait; [`InMemoryStore`] backs it for local dev/tests, and a Postgres adapter will
//! implement the same trait for production (added next). Nothing here can read a record —
//! records are opaque `{ciphertext, nonce}` blobs the client encrypted with its vault key.

use std::collections::HashMap;
use std::sync::Mutex;

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub type AccountId = String;

/// Client-generated crypto material, stored verbatim and echoed back at login. The server
/// treats every field as opaque; only the client can turn these into usable keys.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AccountCrypto {
    pub kdf_version: u32,
    pub salt_hex: String,
    pub argon_params: serde_json::Value,
    pub protected_vk_hex: String,
    pub protected_vk_nonce_hex: String,
    pub recovery_salt_hex: String,
    pub recovery_protected_vk_hex: String,
    pub recovery_protected_vk_nonce_hex: String,
}

/// One encrypted vault record as the server sees it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Record {
    pub id: String,
    pub ciphertext_hex: String,
    pub nonce_hex: String,
    pub seq: i64,
    pub deleted: bool,
}

/// A record change uploaded by a client (server assigns the `seq`).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RecordChange {
    pub id: String,
    pub ciphertext_hex: String,
    pub nonce_hex: String,
    #[serde(default)]
    pub deleted: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum StoreError {
    EmailTaken,
    NotFound,
}

pub trait Store: Send + Sync {
    /// Create an account. `auth_hash` is the PHC string of the client's auth secret.
    fn create_account(&self, email: &str, auth_hash: String, crypto: AccountCrypto)
        -> Result<AccountId, StoreError>;
    /// Look up an account by email, returning its id + stored auth hash for verification.
    fn account_auth(&self, email: &str) -> Option<(AccountId, String)>;
    /// The crypto material to hand back to a client after a successful login.
    fn account_crypto(&self, id: &AccountId) -> Option<AccountCrypto>;
    /// Replace auth hash + protected-key material (change password / recover complete).
    fn update_auth(&self, id: &AccountId, auth_hash: String, crypto: AccountCrypto) -> Result<(), StoreError>;

    fn create_session(&self, id: &AccountId) -> String;
    fn resolve_session(&self, token: &str) -> Option<AccountId>;

    /// Records with `seq > since`, plus the account's current cursor (max seq).
    fn pull(&self, id: &AccountId, since: i64) -> (Vec<Record>, i64);
    /// Apply changes (LWW: each gets a fresh increasing `seq`), return the new cursor.
    fn push(&self, id: &AccountId, changes: Vec<RecordChange>) -> i64;
}

// ---- password/token helpers (shared by any Store impl) ----

/// Hash a client auth secret for storage (Argon2id, random salt, PHC string).
pub fn hash_auth_secret(auth_secret_hex: &str) -> String {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(auth_secret_hex.as_bytes(), &salt)
        .expect("hashing never fails on valid input")
        .to_string()
}

/// Constant-time verify of a client auth secret against a stored PHC hash.
pub fn verify_auth_secret(auth_secret_hex: &str, phc: &str) -> bool {
    match PasswordHash::new(phc) {
        Ok(parsed) => Argon2::default()
            .verify_password(auth_secret_hex.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

fn new_token() -> String {
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    hex::encode(b)
}

fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

// ---- in-memory implementation ----

#[derive(Default)]
struct AccountRow {
    id: AccountId,
    auth_hash: String,
    crypto: AccountCrypto,
    seq: i64,
    records: HashMap<String, Record>,
}

impl Default for AccountCrypto {
    fn default() -> Self {
        AccountCrypto {
            kdf_version: 0,
            salt_hex: String::new(),
            argon_params: serde_json::Value::Null,
            protected_vk_hex: String::new(),
            protected_vk_nonce_hex: String::new(),
            recovery_salt_hex: String::new(),
            recovery_protected_vk_hex: String::new(),
            recovery_protected_vk_nonce_hex: String::new(),
        }
    }
}

#[derive(Default)]
struct Inner {
    by_email: HashMap<String, AccountId>,
    accounts: HashMap<AccountId, AccountRow>,
    sessions: HashMap<String, AccountId>, // token_hash -> account id
}

#[derive(Default)]
pub struct InMemoryStore {
    inner: Mutex<Inner>,
}

impl InMemoryStore {
    pub fn new() -> Self {
        Self::default()
    }
}

fn norm_email(email: &str) -> String {
    email.trim().to_ascii_lowercase()
}

impl Store for InMemoryStore {
    fn create_account(&self, email: &str, auth_hash: String, crypto: AccountCrypto)
        -> Result<AccountId, StoreError> {
        let email = norm_email(email);
        let mut g = self.inner.lock().unwrap();
        if g.by_email.contains_key(&email) {
            return Err(StoreError::EmailTaken);
        }
        let id = new_token(); // random opaque id (reuse the random helper)
        g.by_email.insert(email, id.clone());
        g.accounts.insert(
            id.clone(),
            AccountRow { id: id.clone(), auth_hash, crypto, seq: 0, records: HashMap::new() },
        );
        Ok(id)
    }

    fn account_auth(&self, email: &str) -> Option<(AccountId, String)> {
        let email = norm_email(email);
        let g = self.inner.lock().unwrap();
        let id = g.by_email.get(&email)?;
        let row = g.accounts.get(id)?;
        Some((row.id.clone(), row.auth_hash.clone()))
    }

    fn account_crypto(&self, id: &AccountId) -> Option<AccountCrypto> {
        let g = self.inner.lock().unwrap();
        g.accounts.get(id).map(|r| r.crypto.clone())
    }

    fn update_auth(&self, id: &AccountId, auth_hash: String, crypto: AccountCrypto) -> Result<(), StoreError> {
        let mut g = self.inner.lock().unwrap();
        let row = g.accounts.get_mut(id).ok_or(StoreError::NotFound)?;
        row.auth_hash = auth_hash;
        row.crypto = crypto;
        Ok(())
    }

    fn create_session(&self, id: &AccountId) -> String {
        let token = new_token();
        let mut g = self.inner.lock().unwrap();
        g.sessions.insert(token_hash(&token), id.clone());
        token
    }

    fn resolve_session(&self, token: &str) -> Option<AccountId> {
        let g = self.inner.lock().unwrap();
        g.sessions.get(&token_hash(token)).cloned()
    }

    fn pull(&self, id: &AccountId, since: i64) -> (Vec<Record>, i64) {
        let g = self.inner.lock().unwrap();
        let Some(row) = g.accounts.get(id) else { return (vec![], 0) };
        let mut out: Vec<Record> = row.records.values().filter(|r| r.seq > since).cloned().collect();
        out.sort_by_key(|r| r.seq);
        (out, row.seq)
    }

    fn push(&self, id: &AccountId, changes: Vec<RecordChange>) -> i64 {
        let mut g = self.inner.lock().unwrap();
        let Some(row) = g.accounts.get_mut(id) else { return 0 };
        for c in changes {
            row.seq += 1; // server-assigned monotonic order → LWW is deterministic
            row.records.insert(
                c.id.clone(),
                Record {
                    id: c.id,
                    ciphertext_hex: c.ciphertext_hex,
                    nonce_hex: c.nonce_hex,
                    seq: row.seq,
                    deleted: c.deleted,
                },
            );
        }
        row.seq
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn crypto() -> AccountCrypto {
        AccountCrypto { kdf_version: 1, salt_hex: "07".into(), ..Default::default() }
    }
    fn change(id: &str, ct: &str) -> RecordChange {
        RecordChange { id: id.into(), ciphertext_hex: ct.into(), nonce_hex: "00".into(), deleted: false }
    }

    #[test]
    fn auth_hash_roundtrip() {
        let phc = hash_auth_secret("deadbeef");
        assert!(verify_auth_secret("deadbeef", &phc));
        assert!(!verify_auth_secret("wrong", &phc));
    }

    #[test]
    fn duplicate_email_rejected() {
        let s = InMemoryStore::new();
        s.create_account("A@x.com", "h".into(), crypto()).unwrap();
        assert_eq!(s.create_account("a@x.com", "h".into(), crypto()), Err(StoreError::EmailTaken));
    }

    #[test]
    fn sessions_resolve() {
        let s = InMemoryStore::new();
        let id = s.create_account("u@x.com", "h".into(), crypto()).unwrap();
        let tok = s.create_session(&id);
        assert_eq!(s.resolve_session(&tok).as_ref(), Some(&id));
        assert_eq!(s.resolve_session("nope"), None);
    }

    #[test]
    fn push_assigns_increasing_seq_and_pull_is_incremental() {
        let s = InMemoryStore::new();
        let id = s.create_account("u@x.com", "h".into(), crypto()).unwrap();
        let cur = s.push(&id, vec![change("a", "01"), change("b", "02")]);
        assert_eq!(cur, 2);
        let (recs, cursor) = s.pull(&id, 0);
        assert_eq!(cursor, 2);
        assert_eq!(recs.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
        // Incremental pull returns only what's newer than the client's cursor.
        let (recs2, _) = s.pull(&id, 1);
        assert_eq!(recs2.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["b"]);
    }

    #[test]
    fn last_write_wins_on_same_record() {
        let s = InMemoryStore::new();
        let id = s.create_account("u@x.com", "h".into(), crypto()).unwrap();
        s.push(&id, vec![change("a", "1111")]);
        s.push(&id, vec![change("a", "2222")]); // later upload wins
        let (recs, cursor) = s.pull(&id, 0);
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].ciphertext_hex, "2222");
        assert_eq!(recs[0].seq, cursor); // newest seq
    }

    #[test]
    fn tombstone_propagates() {
        let s = InMemoryStore::new();
        let id = s.create_account("u@x.com", "h".into(), crypto()).unwrap();
        s.push(&id, vec![change("a", "01")]);
        s.push(&id, vec![RecordChange { id: "a".into(), ciphertext_hex: "".into(), nonce_hex: "".into(), deleted: true }]);
        let (recs, _) = s.pull(&id, 0);
        assert_eq!(recs.len(), 1);
        assert!(recs[0].deleted, "deletion must be visible to other devices");
    }
}
