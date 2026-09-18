# TermDeck Cloud Sync + Android — Design Spec

Date: 2026-09-18 · Status: approved for implementation

## Context

TermDeck is a personal VPS manager (SSH terminal + SFTP), Tauri v2 + Rust + React,
desktop-only, with hosts stored locally (config in `plugin-store`, secrets in the OS
keyring). The owner wants to evolve it toward Termius: **sync SSH configuration to a
cloud/self-hosted server and use it everywhere, plus an Android client**.

Decisions locked during brainstorming (2026-09-16):

- **Audience:** personal, multi-device (no teams, no billing, no multi-tenant SaaS).
- **Encryption:** **end-to-end encrypted (E2EE) vault** — secrets encrypted on-device;
  the server only ever stores ciphertext.
- **Backend:** self-hosted small server, **Rust (Axum) + Postgres**.
- **Android:** **full client** — interactive SSH terminal + SFTP + synced vault.
- **Sync model:** **per-record, last-write-wins** (LWW) by server sequence.
- **Identity/keys:** **email + one master password** (Bitwarden-style): the master
  password derives both a login auth secret and the vault key; a recovery code is the
  only account-recovery path.

## Goals / acceptance

1. A user creates an account (email + master password), receives a **recovery code**.
2. Hosts and SSH keys added on one device appear on every signed-in device after sync,
   **including secrets** (passwords, private keys), decryptable only with the master
   password (or recovery code).
3. The server, if fully compromised, cannot read any secret or host detail — only
   metadata (email, record count/size, timestamps).
4. Desktop (TermDeck) and Android both connect to real servers using synced credentials
   without re-entering them per device.
5. Editing different hosts on two devices both survive; editing the same host resolves by
   last upload (LWW), no data corruption.
6. Offline edits queue and sync when back online.

## Non-goals (this phase)

Teams / shared vaults, snippets, port-forwarding, realtime push (poll instead), iOS,
OAuth/SSO, syncing `known_hosts`. These are future phases.

## Sub-projects (one spec, three ordered implementation plans)

- **SP1 — Sync server + vault protocol** (Rust/Axum + Postgres). Foundation; defines the
  crypto + wire format all clients share.
- **SP2 — Desktop sync integration** (TermDeck): account UI, unlock/lock, hosts↔vault,
  migration of existing local hosts, background sync.
- **SP3 — Android client** (Kotlin/Compose): vault sync + interactive SSH terminal + SFTP.

Order is mandatory: SP2 and SP3 both depend on SP1's crypto parameters and API.

---

## 1. Cryptography & vault model

The scheme mirrors Bitwarden/1Password-style E2EE. All KDF/AEAD parameters are fixed and
identical across Rust (desktop + server verification) and Kotlin (Android) so vaults
interoperate. Versioned via a `kdf_version` field for future migration.

**Key derivation (client-only):**
```
salt          = per-account random 16 bytes (created at register, stored server-side, public)
masterKey     = Argon2id(masterPassword, salt, m=64MiB, t=3, p=4) -> 32 bytes
KEK           = HKDF-SHA256(masterKey, info="termdeck-kek")   -> 32 bytes  (key-encryption key)
authSecret    = HKDF-SHA256(masterKey, info="termdeck-auth")  -> 32 bytes  (sent to server to log in)
```

**Vault key (per account, random, created once at register):**
```
VK            = random 32 bytes
protectedVK   = XChaCha20-Poly1305(KEK, nonce, VK)            (stored server-side)
```

**Recovery:**
```
recoveryCode          = random 20 bytes, shown to user once as Base32 groups
RK                    = Argon2id(recoveryCode, recoverySalt, same params) -> 32 bytes
recoveryProtectedVK   = XChaCha20-Poly1305(RK, nonce, VK)     (stored server-side)
```
Losing **both** master password and recovery code = permanent data loss (by design; no
server-side reset can recover E2EE data).

**Record encryption:** each vault record's plaintext (JSON) is encrypted directly with
**VK** using XChaCha20-Poly1305 with a fresh random 24-byte nonce. Ciphertext + nonce are
what the server stores. (Direct-with-VK, not per-record data keys — YAGNI for personal;
per-record keys are a future prerequisite for sharing.)

**Server-side auth verification:** server stores `argon2id(authSecret, authServerSalt)`.
Login: client sends `authSecret`; server verifies the stored hash and issues a session
token. Server never sees `masterPassword`, `masterKey`, `KEK`, or `VK`.

**Change master password:** re-derive KEK from the new password, re-wrap VK
(`protectedVK'`), recompute `authSecret'` + server hash; upload both. **Records are not
re-encrypted** (VK unchanged).

**Rust crates:** `argon2`, `chacha20poly1305` (XChaCha20), `hkdf`, `sha2`, `rand`, `zeroize`
(wipe key material). **Android:** BouncyCastle/Tink for Argon2id + XChaCha20-Poly1305 +
HKDF, matching parameters exactly. A shared **crypto test-vector file** (committed JSON:
inputs → expected ciphertext) pins cross-language compatibility.

## 2. Data model

**Vault record types** (plaintext shape, before encryption):
- `host`: `{ id, name, host, port, user, auth: 'password'|'key', keyId?, remotePath?, presetCommand? }`
- `key`: `{ id, name, privateKeyPem, passphrase? }` — reusable across hosts (referenced by
  `host.keyId`).
- Secrets that used to live in the OS keyring / as a file path now live **inside** the
  encrypted record: a `host` with `auth:'password'` carries its password; a `key` carries
  the PEM. This is the change that makes cross-device use possible.

**Server tables (Postgres):**
- `accounts(id uuid pk, email citext unique, kdf_version int, salt bytea, argon_params jsonb,
  auth_hash text, protected_vk bytea, protected_vk_nonce bytea, recovery_salt bytea,
  recovery_protected_vk bytea, recovery_protected_vk_nonce bytea, seq bigint default 0,
  created_at timestamptz)`
- `records(account_id uuid, id uuid, ciphertext bytea, nonce bytea, seq bigint, deleted bool,
  updated_at timestamptz, primary key(account_id, id))` — `seq` unique per account, indexed.
- `sessions(token_hash text pk, account_id uuid, created_at, expires_at, device_label text)`
  (opaque tokens; store only a hash).

**Sync cursor:** `accounts.seq` is a monotonic counter; every record write does
`seq = ++accounts.seq` (atomic). Clients persist `lastCursor` and pull `records.seq > lastCursor`.

## 3. Sync protocol (HTTPS/JSON, bearer token)

- `POST /v1/auth/register` `{ email, kdf_version, salt, argon_params, auth_secret,
  protected_vk(+nonce), recovery_salt, recovery_protected_vk(+nonce) }` → `{ token }`.
  (Client generates all crypto material; server stores as-is and hashes `auth_secret`.)
- `POST /v1/auth/login` `{ email, auth_secret }` → `{ token, kdf_version, salt, argon_params,
  protected_vk(+nonce) }`.
- `POST /v1/auth/change-password` (auth) `{ new_auth_secret, new_protected_vk(+nonce),
  new_salt, argon_params }`.
- `POST /v1/auth/recover` `{ email, recovery_auth? }` flow → returns `recovery_protected_vk`
  so the client can unwrap VK with RK, then immediately `change-password`.
- `GET /v1/sync?since=<cursor>` (auth) → `{ records: [{id, ciphertext, nonce, seq, deleted}],
  cursor }`.
- `POST /v1/sync` (auth) `{ changes: [{id, ciphertext, nonce, deleted}] }` → server assigns
  `seq` to each, returns `{ cursor, records: [...changed since the client's prior cursor...] }`.
  **Conflict = LWW by server `seq`** (the later upload wins; overwrite is silent, acceptable
  for personal use). Deletes are tombstones (kept so other devices learn of the deletion;
  GC tombstones older than 90 days).

**When clients sync:** on unlock / app foreground, after a local change (debounced ~2 s),
and on a periodic timer (~5 min). Realtime push (WebSocket) is out of scope this phase.

## 4. Server (Rust / Axum)

Thin, stateless-per-request service:
- Axum + `sqlx` (Postgres) + `tokio`. Opaque bearer tokens (32 random bytes, stored hashed).
- Argon2id verification for `auth_secret`; per-IP + per-account **rate limiting** on
  `/auth/*` (tower middleware) to blunt online guessing.
- No plaintext business logic — the server cannot decrypt anything.
- Config via env (`DATABASE_URL`, `BIND_ADDR`, token TTL). Migrations via `sqlx migrate`.
- **Deploy:** single binary + Postgres, TLS terminated by **Caddy** (automatic HTTPS) in
  front. Runs on the owner's VPS. A `docker-compose.yml` (app + Postgres + Caddy) is
  provided for one-command bring-up.
- Lives in the repo under `server/` as its own Cargo crate (workspace member).

## 5. Desktop integration (TermDeck / SP2)

- **Crypto module** (`src-tauri/src/vault.rs`): KDF, wrap/unwrap VK, record encrypt/decrypt,
  recovery. Exposed to the frontend via Tauri commands (`vault_*`); the master password and
  derived keys **never leave Rust** (frontend only sends the password once at unlock; Rust
  holds `VK` in memory, zeroized on lock).
- **Sync client** (`src-tauri/src/sync.rs`): HTTP client to the server, cursor persistence,
  push/pull, offline queue.
- **Frontend** (`src/`): Account screen (register / login / enter master password / show &
  confirm recovery code); a lock state with auto-lock after N minutes; sync status in the
  status bar; settings for server URL + account.
- **Store changes:** hosts become projections of decrypted vault records; add `keys`
  (SSH key records). While signed in + unlocked, the vault is the source of truth and the
  SSH layer reads secrets from the in-memory decrypted vault (no per-host OS-keyring for
  synced hosts). **Local-only mode** (not signed in) keeps today's behavior.
- **Migration:** on first login with existing local hosts, offer to import them into the
  vault (read secrets from the old keyring, encrypt into records, upload).

## 6. Android client (SP3)

- Kotlin + Jetpack Compose; MVVM; Room for the local encrypted-record cache; DataStore for
  session token + cursor.
- **Crypto:** BouncyCastle/Tink, parameters identical to Rust (validated against the shared
  test vectors). `VK` cached behind **BiometricPrompt** via Android Keystore-wrapped storage;
  auto-lock timer.
- **SSH/SFTP:** `sshj` (Apache MINA alternative acceptable). Interactive terminal via a
  terminal-emulator view (Termux `terminal-view`/`terminal-emulator` libs, or a focused
  custom view) wired to the sshj shell channel; SFTP browser (list/upload/download/edit) via
  sshj's SFTP client. Host-key pinning (TOFU) per device.
- **Screens:** VPS list (synced) → host detail with Terminal and Files tabs, mirroring the
  desktop UX.
- Lives in a sibling repo/folder `android/` (own Gradle project).

## 7. Threat model

- **Server compromise:** attacker obtains ciphertext, `auth_hash`, `protected_vk`,
  `recovery_protected_vk`, and metadata (email, record count/size, timestamps). Cannot
  derive `VK` without the master password (Argon2id m=64MiB makes offline guessing costly)
  or the recovery code. Enforce a strong master-password policy in the UI.
- **Network:** TLS required; optional cert pinning on Android.
- **Device compromise / rooted device:** out of scope; mitigated by auto-lock + biometric
  gate + `zeroize` of key material.
- **No data-recovering password reset** (E2EE): the recovery code is the only path.

## 8. Edge cases

- Clock skew → ordering uses server `seq`, never client time.
- Same-record concurrent edit → LWW by `seq` (later upload wins; documented as acceptable).
- Offline edits → queued locally, flushed on reconnect (each still gets a server `seq`).
- Deleting a `key` still referenced by a `host` → warn; host falls back to password/prompt.
- Large vault → cursor pagination on `/sync`.
- Token expiry / revoked session → client re-authenticates (re-enter master password).
- Duplicate register email → server rejects; login race → idempotent.

## 9. Testing strategy

- **Crypto unit tests** (Rust + Kotlin) against a **shared committed test-vector JSON**:
  identical inputs must yield identical ciphertext/keys cross-language.
- **Server integration tests** (`sqlx` test DB): register/login/change-password/recover,
  sync push/pull, LWW ordering, tombstones, rate limiting.
- **Sync merge property tests:** simulate two clients editing overlapping/disjoint records;
  assert convergence + LWW semantics.
- **Desktop:** vault lock/unlock, migration, host CRUD round-trips through the vault, an SSH
  connect using a synced secret (against a local sshd in CI/container).
- **Android:** instrumented tests for crypto compatibility + a scripted SSH/SFTP session
  against a local sshd; manual E2E across desktop + Android emulator + local server.
- **E2E:** two desktop instances + one Android emulator against a locally-run server
  (docker-compose) — add a host on one, see it on the others.

## 10. Prerequisites from the owner (infrastructure)

- A VPS to run the server + Postgres + Caddy, and a domain/subdomain for TLS.
- Android build toolchain (Android Studio / SDK + emulator) and a signing keystore for
  release APKs. (This environment may not have these; SP3 code will be written but its
  build/run happens on the owner's Android toolchain.)

## 11. Rollout order

1. SP1 server + crypto core (buildable/testable here) → deploy to VPS.
2. SP2 desktop integration → dogfood sync across two desktop instances.
3. SP3 Android → build on the owner's toolchain, test against the deployed server.
