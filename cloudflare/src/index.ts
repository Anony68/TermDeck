/**
 * TermDeck sync server on Cloudflare Workers + D1 — a drop-in for the Rust server,
 * implementing the same HTTP contract so the desktop and Android clients work unchanged
 * (just point baseUrl at the Worker URL). It stores only ciphertext + auth hashes and can
 * never read a vault (E2EE is entirely client-side).
 *
 * The server's auth hash is SHA-256 of the client's auth secret; that secret is already a
 * 256-bit KDF output on the client, so a fast server hash is sufficient here.
 */

export interface Env {
  DB: D1Database;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const err = (status: number, error: string) => json({ error }, status);

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const normEmail = (e: string) => e.trim().toLowerCase();

// Fields the client sends for register/change-password/recover-complete and that login /
// recover-begin echo back.
const ACCOUNT_FIELDS = [
  "kdf_version", "salt_hex", "argon_params", "protected_vk_hex", "protected_vk_nonce_hex",
  "recovery_salt_hex", "recovery_protected_vk_hex", "recovery_protected_vk_nonce_hex",
] as const;

function accountMaterial(row: any) {
  return {
    kdf_version: row.kdf_version,
    salt_hex: row.salt_hex,
    argon_params: JSON.parse(row.argon_params ?? "{}"),
    protected_vk_hex: row.protected_vk_hex,
    protected_vk_nonce_hex: row.protected_vk_nonce_hex,
    recovery_salt_hex: row.recovery_salt_hex,
    recovery_protected_vk_hex: row.recovery_protected_vk_hex,
    recovery_protected_vk_nonce_hex: row.recovery_protected_vk_nonce_hex,
  };
}

async function auth(env: Env, req: Request): Promise<string | null> {
  const h = req.headers.get("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return null;
  const row = await env.DB.prepare("SELECT account_id FROM sessions WHERE token_hash=?")
    .bind(await sha256hex(token)).first<{ account_id: string }>();
  return row?.account_id ?? null;
}

async function newSession(env: Env, accountId: string): Promise<string> {
  const token = randomToken();
  await env.DB.prepare("INSERT INTO sessions (token_hash, account_id) VALUES (?,?)")
    .bind(await sha256hex(token), accountId).run();
  return token;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === "/healthz") return new Response("ok");

      if (p === "/v1/auth/register" && req.method === "POST") return register(req, env);
      if (p === "/v1/auth/login" && req.method === "POST") return login(req, env);
      if (p === "/v1/auth/change-password" && req.method === "POST") return changePassword(req, env);
      if (p === "/v1/auth/recover-begin" && req.method === "POST") return recoverBegin(req, env);
      if (p === "/v1/auth/recover-complete" && req.method === "POST") return recoverComplete(req, env);
      if (p === "/v1/sync" && req.method === "GET") return syncPull(req, env, url);
      if (p === "/v1/sync" && req.method === "POST") return syncPush(req, env);

      return err(404, "not found");
    } catch (e: any) {
      return err(500, `server error: ${e?.message ?? e}`);
    }
  },
} satisfies ExportedHandler<Env>;

function accountInsertValues(id: string, email: string, authHash: string, recoveryHash: string, b: any) {
  return [
    id, email, authHash, recoveryHash, b.kdf_version, b.salt_hex, JSON.stringify(b.argon_params ?? {}),
    b.protected_vk_hex, b.protected_vk_nonce_hex, b.recovery_salt_hex, b.recovery_protected_vk_hex,
    b.recovery_protected_vk_nonce_hex,
  ];
}

async function register(req: Request, env: Env): Promise<Response> {
  const b: any = await req.json();
  if (!b.email || !b.auth_secret_hex || !b.recovery_auth_secret_hex)
    return err(400, "email, auth_secret and recovery_auth_secret required");
  const email = normEmail(b.email);
  const exists = await env.DB.prepare("SELECT 1 FROM accounts WHERE email=?").bind(email).first();
  if (exists) return err(409, "email already registered");
  const id = randomToken().slice(0, 32);
  const authHash = await sha256hex(b.auth_secret_hex);
  const recoveryHash = await sha256hex(b.recovery_auth_secret_hex);
  await env.DB.prepare(
    `INSERT INTO accounts (id,email,auth_hash,recovery_auth_hash,kdf_version,salt_hex,argon_params,
      protected_vk_hex,protected_vk_nonce_hex,recovery_salt_hex,recovery_protected_vk_hex,recovery_protected_vk_nonce_hex)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(...accountInsertValues(id, email, authHash, recoveryHash, b)).run();
  return json({ token: await newSession(env, id) });
}

async function login(req: Request, env: Env): Promise<Response> {
  const b: any = await req.json();
  const row = await env.DB.prepare("SELECT * FROM accounts WHERE email=?").bind(normEmail(b.email)).first<any>();
  if (!row || row.auth_hash !== (await sha256hex(b.auth_secret_hex ?? ""))) return err(401, "invalid credentials");
  return json({ token: await newSession(env, row.id), ...accountMaterial(row) });
}

async function changePassword(req: Request, env: Env): Promise<Response> {
  const accountId = await auth(env, req);
  if (!accountId) return err(401, "invalid or expired token");
  const b: any = await req.json();
  const authHash = await sha256hex(b.new_auth_secret_hex ?? "");
  await env.DB.prepare(
    `UPDATE accounts SET auth_hash=?,kdf_version=?,salt_hex=?,argon_params=?,protected_vk_hex=?,
      protected_vk_nonce_hex=?,recovery_salt_hex=?,recovery_protected_vk_hex=?,recovery_protected_vk_nonce_hex=? WHERE id=?`)
    .bind(authHash, b.kdf_version, b.salt_hex, JSON.stringify(b.argon_params ?? {}), b.protected_vk_hex,
      b.protected_vk_nonce_hex, b.recovery_salt_hex, b.recovery_protected_vk_hex, b.recovery_protected_vk_nonce_hex, accountId).run();
  return new Response(null, { status: 204 });
}

async function recoverBegin(req: Request, env: Env): Promise<Response> {
  const b: any = await req.json();
  const row = await env.DB.prepare("SELECT * FROM accounts WHERE email=?").bind(normEmail(b.email)).first<any>();
  if (!row) return err(404, "no such account");
  return json(accountMaterial(row));
}

async function recoverComplete(req: Request, env: Env): Promise<Response> {
  const b: any = await req.json();
  const row = await env.DB.prepare("SELECT * FROM accounts WHERE email=?").bind(normEmail(b.email)).first<any>();
  if (!row || row.recovery_auth_hash !== (await sha256hex(b.recovery_auth_secret_hex ?? ""))) return err(401, "invalid recovery code");
  const authHash = await sha256hex(b.new_auth_secret_hex ?? "");
  await env.DB.prepare(
    `UPDATE accounts SET auth_hash=?,kdf_version=?,salt_hex=?,argon_params=?,protected_vk_hex=?,
      protected_vk_nonce_hex=?,recovery_salt_hex=?,recovery_protected_vk_hex=?,recovery_protected_vk_nonce_hex=? WHERE id=?`)
    .bind(authHash, b.kdf_version, b.salt_hex, JSON.stringify(b.argon_params ?? {}), b.protected_vk_hex,
      b.protected_vk_nonce_hex, b.recovery_salt_hex, b.recovery_protected_vk_hex, b.recovery_protected_vk_nonce_hex, row.id).run();
  return json({ token: await newSession(env, row.id) });
}

async function syncPull(req: Request, env: Env, url: URL): Promise<Response> {
  const accountId = await auth(env, req);
  if (!accountId) return err(401, "invalid or expired token");
  const since = Number(url.searchParams.get("since") ?? "0");
  const rs = await env.DB.prepare(
    "SELECT id,ciphertext_hex,nonce_hex,seq,deleted FROM records WHERE account_id=? AND seq>? ORDER BY seq")
    .bind(accountId, since).all<any>();
  const acc = await env.DB.prepare("SELECT seq FROM accounts WHERE id=?").bind(accountId).first<{ seq: number }>();
  const records = (rs.results ?? []).map((r) => ({
    id: r.id, ciphertext_hex: r.ciphertext_hex, nonce_hex: r.nonce_hex, seq: r.seq, deleted: !!r.deleted,
  }));
  return json({ records, cursor: acc?.seq ?? 0 });
}

async function syncPush(req: Request, env: Env): Promise<Response> {
  const accountId = await auth(env, req);
  if (!accountId) return err(401, "invalid or expired token");
  const b: any = await req.json();
  let cursor = 0;
  for (const c of b.changes ?? []) {
    const upd = await env.DB.prepare("UPDATE accounts SET seq=seq+1 WHERE id=? RETURNING seq")
      .bind(accountId).first<{ seq: number }>();
    cursor = upd?.seq ?? cursor;
    await env.DB.prepare(
      `INSERT INTO records (account_id,id,ciphertext_hex,nonce_hex,seq,deleted) VALUES (?,?,?,?,?,?)
       ON CONFLICT(account_id,id) DO UPDATE SET ciphertext_hex=excluded.ciphertext_hex,
       nonce_hex=excluded.nonce_hex,seq=excluded.seq,deleted=excluded.deleted`)
      .bind(accountId, c.id, c.ciphertext_hex ?? "", c.nonce_hex ?? "", cursor, c.deleted ? 1 : 0).run();
  }
  return json({ cursor });
}
