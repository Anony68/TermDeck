CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  auth_hash TEXT NOT NULL,
  recovery_auth_hash TEXT NOT NULL,
  kdf_version INTEGER NOT NULL,
  salt_hex TEXT NOT NULL,
  argon_params TEXT NOT NULL,
  protected_vk_hex TEXT NOT NULL,
  protected_vk_nonce_hex TEXT NOT NULL,
  recovery_salt_hex TEXT NOT NULL,
  recovery_protected_vk_hex TEXT NOT NULL,
  recovery_protected_vk_nonce_hex TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS records (
  account_id TEXT NOT NULL,
  id TEXT NOT NULL,
  ciphertext_hex TEXT NOT NULL,
  nonce_hex TEXT NOT NULL,
  seq INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX IF NOT EXISTS records_seq ON records(account_id, seq);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL
);
