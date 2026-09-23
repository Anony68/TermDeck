//! Domain types + the storage abstraction. Server logic depends only on the async [`Store`]
//! trait; [`InMemoryStore`] backs local dev/tests and [`PgStore`] backs production. Records
//! are opaque `{ciphertext, nonce}` blobs the client encrypted with its vault key — the
//! server can never read one.

use std::collections::HashMap;
use std::sync::Mutex;

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use async_trait::async_trait;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub type AccountId = String;

/// Client-generated crypto material, stored verbatim and echoed back at login.
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

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Record {
    pub id: String,
    pub ciphertext_hex: String,
    pub nonce_hex: String,
    pub seq: i64,
    pub deleted: bool,
}

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
    Db,
}

#[async_trait]
pub trait Store: Send + Sync {
    async fn create_account(&self, email: &str, auth_hash: String, recovery_auth_hash: String, crypto: AccountCrypto)
        -> Result<AccountId, StoreError>;
    async fn account_auth(&self, email: &str) -> Option<(AccountId, String)>;
    async fn account_recovery(&self, email: &str) -> Option<(AccountId, String, AccountCrypto)>;
    async fn account_crypto(&self, id: &AccountId) -> Option<AccountCrypto>;
    async fn update_auth(&self, id: &AccountId, auth_hash: String, crypto: AccountCrypto) -> Result<(), StoreError>;
    async fn create_session(&self, id: &AccountId) -> String;
    async fn resolve_session(&self, token: &str) -> Option<AccountId>;
    async fn pull(&self, id: &AccountId, since: i64) -> (Vec<Record>, i64);
    async fn push(&self, id: &AccountId, changes: Vec<RecordChange>) -> i64;
}

// ---- shared helpers ----

pub fn hash_auth_secret(auth_secret_hex: &str) -> String {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(auth_secret_hex.as_bytes(), &salt)
        .expect("hashing never fails on valid input")
        .to_string()
}

pub fn verify_auth_secret(auth_secret_hex: &str, phc: &str) -> bool {
    match PasswordHash::new(phc) {
        Ok(parsed) => Argon2::default().verify_password(auth_secret_hex.as_bytes(), &parsed).is_ok(),
        Err(_) => false,
    }
}

fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut b);
    hex::encode(b)
}
fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}
fn norm_email(email: &str) -> String {
    email.trim().to_ascii_lowercase()
}

// ---- in-memory implementation ----

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

struct AccountRow {
    id: AccountId,
    auth_hash: String,
    recovery_auth_hash: String,
    crypto: AccountCrypto,
    seq: i64,
    records: HashMap<String, Record>,
}

#[derive(Default)]
struct Inner {
    by_email: HashMap<String, AccountId>,
    accounts: HashMap<AccountId, AccountRow>,
    sessions: HashMap<String, AccountId>,
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

#[async_trait]
impl Store for InMemoryStore {
    async fn create_account(&self, email: &str, auth_hash: String, recovery_auth_hash: String, crypto: AccountCrypto)
        -> Result<AccountId, StoreError> {
        let email = norm_email(email);
        let mut g = self.inner.lock().unwrap();
        if g.by_email.contains_key(&email) {
            return Err(StoreError::EmailTaken);
        }
        let id = random_hex(16);
        g.by_email.insert(email, id.clone());
        g.accounts.insert(id.clone(), AccountRow { id: id.clone(), auth_hash, recovery_auth_hash, crypto, seq: 0, records: HashMap::new() });
        Ok(id)
    }
    async fn account_auth(&self, email: &str) -> Option<(AccountId, String)> {
        let g = self.inner.lock().unwrap();
        let id = g.by_email.get(&norm_email(email))?;
        let row = g.accounts.get(id)?;
        Some((row.id.clone(), row.auth_hash.clone()))
    }
    async fn account_recovery(&self, email: &str) -> Option<(AccountId, String, AccountCrypto)> {
        let g = self.inner.lock().unwrap();
        let id = g.by_email.get(&norm_email(email))?;
        let row = g.accounts.get(id)?;
        Some((row.id.clone(), row.recovery_auth_hash.clone(), row.crypto.clone()))
    }
    async fn account_crypto(&self, id: &AccountId) -> Option<AccountCrypto> {
        self.inner.lock().unwrap().accounts.get(id).map(|r| r.crypto.clone())
    }
    async fn update_auth(&self, id: &AccountId, auth_hash: String, crypto: AccountCrypto) -> Result<(), StoreError> {
        let mut g = self.inner.lock().unwrap();
        let row = g.accounts.get_mut(id).ok_or(StoreError::NotFound)?;
        row.auth_hash = auth_hash;
        row.crypto = crypto;
        Ok(())
    }
    async fn create_session(&self, id: &AccountId) -> String {
        let token = random_hex(32);
        self.inner.lock().unwrap().sessions.insert(token_hash(&token), id.clone());
        token
    }
    async fn resolve_session(&self, token: &str) -> Option<AccountId> {
        self.inner.lock().unwrap().sessions.get(&token_hash(token)).cloned()
    }
    async fn pull(&self, id: &AccountId, since: i64) -> (Vec<Record>, i64) {
        let g = self.inner.lock().unwrap();
        let Some(row) = g.accounts.get(id) else { return (vec![], 0) };
        let mut out: Vec<Record> = row.records.values().filter(|r| r.seq > since).cloned().collect();
        out.sort_by_key(|r| r.seq);
        (out, row.seq)
    }
    async fn push(&self, id: &AccountId, changes: Vec<RecordChange>) -> i64 {
        let mut g = self.inner.lock().unwrap();
        let Some(row) = g.accounts.get_mut(id) else { return 0 };
        for c in changes {
            row.seq += 1;
            row.records.insert(c.id.clone(), Record { id: c.id, ciphertext_hex: c.ciphertext_hex, nonce_hex: c.nonce_hex, seq: row.seq, deleted: c.deleted });
        }
        row.seq
    }
}

// ---- Postgres implementation ----

pub use pg::PgStore;
mod pg {
    use super::*;
    use sqlx::{PgPool, Row};

    pub struct PgStore {
        pool: PgPool,
    }

    const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS accounts (
  id text PRIMARY KEY,
  email text UNIQUE NOT NULL,
  auth_hash text NOT NULL,
  recovery_auth_hash text NOT NULL,
  kdf_version int NOT NULL,
  salt_hex text NOT NULL,
  argon_params jsonb NOT NULL,
  protected_vk_hex text NOT NULL,
  protected_vk_nonce_hex text NOT NULL,
  recovery_salt_hex text NOT NULL,
  recovery_protected_vk_hex text NOT NULL,
  recovery_protected_vk_nonce_hex text NOT NULL,
  seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS records (
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id text NOT NULL,
  ciphertext_hex text NOT NULL,
  nonce_hex text NOT NULL,
  seq bigint NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, id)
);
CREATE INDEX IF NOT EXISTS records_seq_idx ON records(account_id, seq);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
"#;

    impl PgStore {
        pub async fn connect(database_url: &str) -> Result<Self, sqlx::Error> {
            let pool = PgPool::connect(database_url).await?;
            sqlx::raw_sql(SCHEMA).execute(&pool).await?;
            Ok(Self { pool })
        }

        fn crypto_from_row(row: &sqlx::postgres::PgRow) -> AccountCrypto {
            AccountCrypto {
                kdf_version: row.get::<i32, _>("kdf_version") as u32,
                salt_hex: row.get("salt_hex"),
                argon_params: row.get("argon_params"),
                protected_vk_hex: row.get("protected_vk_hex"),
                protected_vk_nonce_hex: row.get("protected_vk_nonce_hex"),
                recovery_salt_hex: row.get("recovery_salt_hex"),
                recovery_protected_vk_hex: row.get("recovery_protected_vk_hex"),
                recovery_protected_vk_nonce_hex: row.get("recovery_protected_vk_nonce_hex"),
            }
        }
    }

    #[async_trait]
    impl Store for PgStore {
        async fn create_account(&self, email: &str, auth_hash: String, recovery_auth_hash: String, crypto: AccountCrypto)
            -> Result<AccountId, StoreError> {
            let id = random_hex(16);
            let res = sqlx::query(
                "INSERT INTO accounts (id,email,auth_hash,recovery_auth_hash,kdf_version,salt_hex,argon_params,\
                 protected_vk_hex,protected_vk_nonce_hex,recovery_salt_hex,recovery_protected_vk_hex,recovery_protected_vk_nonce_hex)\
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)")
                .bind(&id).bind(norm_email(email)).bind(&auth_hash).bind(&recovery_auth_hash)
                .bind(crypto.kdf_version as i32).bind(&crypto.salt_hex).bind(&crypto.argon_params)
                .bind(&crypto.protected_vk_hex).bind(&crypto.protected_vk_nonce_hex)
                .bind(&crypto.recovery_salt_hex).bind(&crypto.recovery_protected_vk_hex).bind(&crypto.recovery_protected_vk_nonce_hex)
                .execute(&self.pool).await;
            match res {
                Ok(_) => Ok(id),
                Err(sqlx::Error::Database(e)) if e.is_unique_violation() => Err(StoreError::EmailTaken),
                Err(e) => { tracing::error!("create_account: {e}"); Err(StoreError::Db) }
            }
        }
        async fn account_auth(&self, email: &str) -> Option<(AccountId, String)> {
            sqlx::query("SELECT id, auth_hash FROM accounts WHERE email=$1")
                .bind(norm_email(email)).fetch_optional(&self.pool).await.ok().flatten()
                .map(|r| (r.get("id"), r.get("auth_hash")))
        }
        async fn account_recovery(&self, email: &str) -> Option<(AccountId, String, AccountCrypto)> {
            let r = sqlx::query("SELECT * FROM accounts WHERE email=$1")
                .bind(norm_email(email)).fetch_optional(&self.pool).await.ok().flatten()?;
            Some((r.get("id"), r.get("recovery_auth_hash"), Self::crypto_from_row(&r)))
        }
        async fn account_crypto(&self, id: &AccountId) -> Option<AccountCrypto> {
            let r = sqlx::query("SELECT * FROM accounts WHERE id=$1").bind(id)
                .fetch_optional(&self.pool).await.ok().flatten()?;
            Some(Self::crypto_from_row(&r))
        }
        async fn update_auth(&self, id: &AccountId, auth_hash: String, crypto: AccountCrypto) -> Result<(), StoreError> {
            sqlx::query(
                "UPDATE accounts SET auth_hash=$2,kdf_version=$3,salt_hex=$4,argon_params=$5,\
                 protected_vk_hex=$6,protected_vk_nonce_hex=$7,recovery_salt_hex=$8,\
                 recovery_protected_vk_hex=$9,recovery_protected_vk_nonce_hex=$10 WHERE id=$1")
                .bind(id).bind(&auth_hash).bind(crypto.kdf_version as i32).bind(&crypto.salt_hex).bind(&crypto.argon_params)
                .bind(&crypto.protected_vk_hex).bind(&crypto.protected_vk_nonce_hex).bind(&crypto.recovery_salt_hex)
                .bind(&crypto.recovery_protected_vk_hex).bind(&crypto.recovery_protected_vk_nonce_hex)
                .execute(&self.pool).await.map(|_| ()).map_err(|e| { tracing::error!("update_auth: {e}"); StoreError::Db })
        }
        async fn create_session(&self, id: &AccountId) -> String {
            let token = random_hex(32);
            let _ = sqlx::query("INSERT INTO sessions (token_hash, account_id) VALUES ($1,$2)")
                .bind(token_hash(&token)).bind(id).execute(&self.pool).await;
            token
        }
        async fn resolve_session(&self, token: &str) -> Option<AccountId> {
            sqlx::query("SELECT account_id FROM sessions WHERE token_hash=$1")
                .bind(token_hash(token)).fetch_optional(&self.pool).await.ok().flatten().map(|r| r.get("account_id"))
        }
        async fn pull(&self, id: &AccountId, since: i64) -> (Vec<Record>, i64) {
            let rows = sqlx::query("SELECT id,ciphertext_hex,nonce_hex,seq,deleted FROM records WHERE account_id=$1 AND seq>$2 ORDER BY seq")
                .bind(id).bind(since).fetch_all(&self.pool).await.unwrap_or_default();
            let recs = rows.iter().map(|r| Record {
                id: r.get("id"), ciphertext_hex: r.get("ciphertext_hex"), nonce_hex: r.get("nonce_hex"),
                seq: r.get("seq"), deleted: r.get("deleted"),
            }).collect();
            let cursor = sqlx::query("SELECT seq FROM accounts WHERE id=$1").bind(id)
                .fetch_optional(&self.pool).await.ok().flatten().map(|r| r.get::<i64, _>("seq")).unwrap_or(0);
            (recs, cursor)
        }
        async fn push(&self, id: &AccountId, changes: Vec<RecordChange>) -> i64 {
            let mut tx = match self.pool.begin().await { Ok(t) => t, Err(e) => { tracing::error!("push begin: {e}"); return 0 } };
            let mut cursor = 0i64;
            for c in changes {
                let seq: i64 = match sqlx::query("UPDATE accounts SET seq=seq+1 WHERE id=$1 RETURNING seq")
                    .bind(id).fetch_one(&mut *tx).await { Ok(r) => r.get("seq"), Err(e) => { tracing::error!("push seq: {e}"); return cursor } };
                cursor = seq;
                if let Err(e) = sqlx::query(
                    "INSERT INTO records (account_id,id,ciphertext_hex,nonce_hex,seq,deleted) VALUES ($1,$2,$3,$4,$5,$6)\
                     ON CONFLICT (account_id,id) DO UPDATE SET ciphertext_hex=EXCLUDED.ciphertext_hex,\
                     nonce_hex=EXCLUDED.nonce_hex,seq=EXCLUDED.seq,deleted=EXCLUDED.deleted,updated_at=now()")
                    .bind(id).bind(&c.id).bind(&c.ciphertext_hex).bind(&c.nonce_hex).bind(seq).bind(c.deleted)
                    .execute(&mut *tx).await { tracing::error!("push upsert: {e}"); return cursor; }
            }
            if let Err(e) = tx.commit().await { tracing::error!("push commit: {e}"); }
            cursor
        }
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

    #[tokio::test]
    async fn duplicate_email_rejected() {
        let s = InMemoryStore::new();
        s.create_account("A@x.com", "h".into(), "rh".into(), crypto()).await.unwrap();
        assert_eq!(s.create_account("a@x.com", "h".into(), "rh".into(), crypto()).await, Err(StoreError::EmailTaken));
    }

    #[tokio::test]
    async fn sessions_resolve() {
        let s = InMemoryStore::new();
        let id = s.create_account("u@x.com", "h".into(), "rh".into(), crypto()).await.unwrap();
        let tok = s.create_session(&id).await;
        assert_eq!(s.resolve_session(&tok).await.as_ref(), Some(&id));
        assert_eq!(s.resolve_session("nope").await, None);
    }

    #[tokio::test]
    async fn push_assigns_increasing_seq_and_pull_is_incremental() {
        let s = InMemoryStore::new();
        let id = s.create_account("u@x.com", "h".into(), "rh".into(), crypto()).await.unwrap();
        assert_eq!(s.push(&id, vec![change("a", "01"), change("b", "02")]).await, 2);
        let (recs, cursor) = s.pull(&id, 0).await;
        assert_eq!(cursor, 2);
        assert_eq!(recs.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
        let (recs2, _) = s.pull(&id, 1).await;
        assert_eq!(recs2.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["b"]);
    }

    #[tokio::test]
    async fn last_write_wins_and_tombstone() {
        let s = InMemoryStore::new();
        let id = s.create_account("u@x.com", "h".into(), "rh".into(), crypto()).await.unwrap();
        s.push(&id, vec![change("a", "1111")]).await;
        s.push(&id, vec![change("a", "2222")]).await;
        let (recs, cursor) = s.pull(&id, 0).await;
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].ciphertext_hex, "2222");
        assert_eq!(recs[0].seq, cursor);
        s.push(&id, vec![RecordChange { id: "a".into(), ciphertext_hex: "".into(), nonce_hex: "".into(), deleted: true }]).await;
        let (recs, _) = s.pull(&id, 0).await;
        assert!(recs[0].deleted);
    }
}
