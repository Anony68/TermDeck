//! HTTP surface (Axum). Thin: validate → call the [`Store`] → return JSON. No plaintext
//! business logic; the server never decrypts a record.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::store::{
    hash_auth_secret, verify_auth_secret, AccountCrypto, AccountId, Record, RecordChange, Store,
    StoreError,
};

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<dyn Store>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/v1/auth/register", post(register))
        .route("/v1/auth/login", post(login))
        .route("/v1/auth/change-password", post(change_password))
        .route("/v1/auth/recover-begin", post(recover_begin))
        .route("/v1/auth/recover-complete", post(recover_complete))
        .route("/v1/sync", get(sync_pull).post(sync_push))
        .with_state(state)
}

// ---- error type ----

struct ApiError(StatusCode, &'static str);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({ "error": self.1 }))).into_response()
    }
}
type ApiResult<T> = Result<T, ApiError>;

async fn require_auth(state: &AppState, headers: &HeaderMap) -> ApiResult<AccountId> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .ok_or(ApiError(StatusCode::UNAUTHORIZED, "missing bearer token"))?;
    state
        .store
        .resolve_session(token)
        .await
        .ok_or(ApiError(StatusCode::UNAUTHORIZED, "invalid or expired token"))
}

// ---- auth ----

#[derive(Deserialize)]
struct RegisterReq {
    email: String,
    auth_secret_hex: String,
    /// Auth secret derived from the recovery code; proves possession during recovery.
    recovery_auth_secret_hex: String,
    #[serde(flatten)]
    crypto: AccountCrypto,
}
#[derive(Serialize)]
struct TokenResp {
    token: String,
}

async fn register(State(state): State<AppState>, Json(req): Json<RegisterReq>) -> ApiResult<Json<TokenResp>> {
    if req.email.trim().is_empty() || req.auth_secret_hex.is_empty() || req.recovery_auth_secret_hex.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "email, auth_secret and recovery_auth_secret required"));
    }
    let hash = hash_auth_secret(&req.auth_secret_hex);
    let recovery_hash = hash_auth_secret(&req.recovery_auth_secret_hex);
    let id = state
        .store
        .create_account(&req.email, hash, recovery_hash, req.crypto)
        .await
        .map_err(|e| match e {
            StoreError::EmailTaken => ApiError(StatusCode::CONFLICT, "email already registered"),
            _ => ApiError(StatusCode::INTERNAL_SERVER_ERROR, "store error"),
        })?;
    Ok(Json(TokenResp { token: state.store.create_session(&id).await }))
}

#[derive(Deserialize)]
struct LoginReq {
    email: String,
    auth_secret_hex: String,
}
#[derive(Serialize)]
struct LoginResp {
    token: String,
    #[serde(flatten)]
    crypto: AccountCrypto,
}

async fn login(State(state): State<AppState>, Json(req): Json<LoginReq>) -> ApiResult<Json<LoginResp>> {
    let (id, hash) = state
        .store
        .account_auth(&req.email)
        .await
        .ok_or(ApiError(StatusCode::UNAUTHORIZED, "invalid credentials"))?;
    if !verify_auth_secret(&req.auth_secret_hex, &hash) {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "invalid credentials"));
    }
    let crypto = state
        .store
        .account_crypto(&id)
        .await
        .ok_or(ApiError(StatusCode::INTERNAL_SERVER_ERROR, "store error"))?;
    Ok(Json(LoginResp { token: state.store.create_session(&id).await, crypto }))
}

#[derive(Deserialize)]
struct ChangePasswordReq {
    new_auth_secret_hex: String,
    #[serde(flatten)]
    crypto: AccountCrypto,
}

async fn change_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ChangePasswordReq>,
) -> ApiResult<StatusCode> {
    let id = require_auth(&state, &headers).await?;
    let hash = hash_auth_secret(&req.new_auth_secret_hex);
    state
        .store
        .update_auth(&id, hash, req.crypto)
        .await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "store error"))?;
    Ok(StatusCode::NO_CONTENT)
}

// ---- recovery ----
// Two-step: `begin` hands back the (E2EE) recovery material for an email so the client can
// derive the recovery key from the user's recovery code and unwrap the vault key locally;
// `complete` verifies possession of the recovery code (via the recovery auth secret) and
// swaps in a fresh master-password protected key. The vault key itself never changes, so
// records stay readable.

#[derive(Deserialize)]
struct RecoverBeginReq {
    email: String,
}
#[derive(Serialize)]
struct RecoverBeginResp {
    #[serde(flatten)]
    crypto: AccountCrypto,
}

async fn recover_begin(State(state): State<AppState>, Json(req): Json<RecoverBeginReq>) -> ApiResult<Json<RecoverBeginResp>> {
    // Returns only E2EE-encrypted material + public salts; useless without the recovery code.
    let (_, _, crypto) = state
        .store
        .account_recovery(&req.email)
        .await
        .ok_or(ApiError(StatusCode::NOT_FOUND, "no such account"))?;
    Ok(Json(RecoverBeginResp { crypto }))
}

#[derive(Deserialize)]
struct RecoverCompleteReq {
    email: String,
    recovery_auth_secret_hex: String,
    new_auth_secret_hex: String,
    #[serde(flatten)]
    crypto: AccountCrypto,
}

async fn recover_complete(State(state): State<AppState>, Json(req): Json<RecoverCompleteReq>) -> ApiResult<Json<TokenResp>> {
    let (id, recovery_hash, _) = state
        .store
        .account_recovery(&req.email)
        .await
        .ok_or(ApiError(StatusCode::UNAUTHORIZED, "invalid recovery"))?;
    if !verify_auth_secret(&req.recovery_auth_secret_hex, &recovery_hash) {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "invalid recovery code"));
    }
    let hash = hash_auth_secret(&req.new_auth_secret_hex);
    state
        .store
        .update_auth(&id, hash, req.crypto)
        .await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "store error"))?;
    Ok(Json(TokenResp { token: state.store.create_session(&id).await }))
}

// ---- sync ----

#[derive(Deserialize)]
struct SyncQuery {
    #[serde(default)]
    since: i64,
}
#[derive(Serialize)]
struct SyncPullResp {
    records: Vec<Record>,
    cursor: i64,
}

async fn sync_pull(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<SyncQuery>,
) -> ApiResult<Json<SyncPullResp>> {
    let id = require_auth(&state, &headers).await?;
    let (records, cursor) = state.store.pull(&id, q.since).await;
    Ok(Json(SyncPullResp { records, cursor }))
}

#[derive(Deserialize)]
struct SyncPushReq {
    changes: Vec<RecordChange>,
}
#[derive(Serialize)]
struct SyncPushResp {
    cursor: i64,
}

async fn sync_push(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<SyncPushReq>,
) -> ApiResult<Json<SyncPushResp>> {
    let id = require_auth(&state, &headers).await?;
    let cursor = state.store.push(&id, req.changes).await;
    Ok(Json(SyncPushResp { cursor }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::InMemoryStore;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt; // for `oneshot`

    fn app() -> Router {
        router(AppState { store: Arc::new(InMemoryStore::new()) })
    }

    async fn send(app: &Router, method: &str, uri: &str, token: Option<&str>, body: serde_json::Value)
        -> (StatusCode, serde_json::Value) {
        let mut req = Request::builder().method(method).uri(uri).header("content-type", "application/json");
        if let Some(t) = token {
            req = req.header("authorization", format!("Bearer {t}"));
        }
        let req = req.body(Body::from(body.to_string())).unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let json = if bytes.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
        };
        (status, json)
    }

    fn register_body(email: &str, auth: &str) -> serde_json::Value {
        serde_json::json!({
            "email": email, "auth_secret_hex": auth, "recovery_auth_secret_hex": "rec-a92833f2",
            "kdf_version": 1, "salt_hex": "07", "argon_params": {"m":65536,"t":3,"p":4},
            "protected_vk_hex": "bc10", "protected_vk_nonce_hex": "0101",
            "recovery_salt_hex": "09", "recovery_protected_vk_hex": "5b39", "recovery_protected_vk_nonce_hex": "0101"
        })
    }

    #[tokio::test]
    async fn full_auth_and_sync_flow() {
        let app = app();

        // register
        let (st, body) = send(&app, "POST", "/v1/auth/register", None, register_body("me@x.com", "a92833f2")).await;
        assert_eq!(st, StatusCode::OK);
        let token = body["token"].as_str().unwrap().to_string();

        // duplicate email -> 409
        let (st, _) = send(&app, "POST", "/v1/auth/register", None, register_body("ME@x.com", "a92833f2")).await;
        assert_eq!(st, StatusCode::CONFLICT);

        // login wrong secret -> 401
        let (st, _) = send(&app, "POST", "/v1/auth/login", None,
            serde_json::json!({"email":"me@x.com","auth_secret_hex":"BAD"})).await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);

        // login correct -> token + echoes crypto material
        let (st, body) = send(&app, "POST", "/v1/auth/login", None,
            serde_json::json!({"email":"me@x.com","auth_secret_hex":"a92833f2"})).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["protected_vk_hex"], "bc10");
        assert_eq!(body["kdf_version"], 1);

        // unauth push -> 401
        let (st, _) = send(&app, "POST", "/v1/sync", None,
            serde_json::json!({"changes":[]})).await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);

        // push two records
        let (st, body) = send(&app, "POST", "/v1/sync", Some(&token), serde_json::json!({"changes":[
            {"id":"host-1","ciphertext_hex":"8a680a","nonce_hex":"0202"},
            {"id":"host-2","ciphertext_hex":"ffee","nonce_hex":"0303"}
        ]})).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["cursor"], 2);

        // pull all
        let (st, body) = send(&app, "GET", "/v1/sync?since=0", Some(&token), serde_json::Value::Null).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["cursor"], 2);
        assert_eq!(body["records"].as_array().unwrap().len(), 2);

        // incremental pull
        let (_, body) = send(&app, "GET", "/v1/sync?since=1", Some(&token), serde_json::Value::Null).await;
        assert_eq!(body["records"].as_array().unwrap().len(), 1);
        assert_eq!(body["records"][0]["id"], "host-2");

        // change password, then old-secret login fails, new works
        let (st, _) = send(&app, "POST", "/v1/auth/change-password", Some(&token), serde_json::json!({
            "new_auth_secret_hex": "cafef00d",
            "kdf_version": 1, "salt_hex": "aa", "argon_params": {},
            "protected_vk_hex": "beef", "protected_vk_nonce_hex": "0101",
            "recovery_salt_hex": "09", "recovery_protected_vk_hex": "5b39", "recovery_protected_vk_nonce_hex": "0101"
        })).await;
        assert_eq!(st, StatusCode::NO_CONTENT);
        let (st, _) = send(&app, "POST", "/v1/auth/login", None,
            serde_json::json!({"email":"me@x.com","auth_secret_hex":"a92833f2"})).await;
        assert_eq!(st, StatusCode::UNAUTHORIZED, "old secret must stop working");
        let (st, body) = send(&app, "POST", "/v1/auth/login", None,
            serde_json::json!({"email":"me@x.com","auth_secret_hex":"cafef00d"})).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["protected_vk_hex"], "beef", "re-wrapped VK is returned");
    }

    #[tokio::test]
    async fn recovery_flow() {
        let app = app();
        let (_, body) = send(&app, "POST", "/v1/auth/register", None, register_body("r@x.com", "aaaa")).await;
        assert!(body["token"].is_string());

        // begin: hands back the E2EE recovery material (for any email — blob is useless
        // without the recovery code).
        let (st, body) = send(&app, "POST", "/v1/auth/recover-begin", None,
            serde_json::json!({"email":"r@x.com"})).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["recovery_protected_vk_hex"], "5b39");

        // complete with the WRONG recovery secret → 401
        let (st, _) = send(&app, "POST", "/v1/auth/recover-complete", None, serde_json::json!({
            "email":"r@x.com", "recovery_auth_secret_hex":"WRONG", "new_auth_secret_hex":"newnew",
            "kdf_version":1, "salt_hex":"bb", "argon_params":{},
            "protected_vk_hex":"d00d", "protected_vk_nonce_hex":"0101",
            "recovery_salt_hex":"09", "recovery_protected_vk_hex":"5b39", "recovery_protected_vk_nonce_hex":"0101"
        })).await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);

        // complete with the correct recovery secret → new token, new password works
        let (st, body) = send(&app, "POST", "/v1/auth/recover-complete", None, serde_json::json!({
            "email":"r@x.com", "recovery_auth_secret_hex":"rec-a92833f2", "new_auth_secret_hex":"newnew",
            "kdf_version":1, "salt_hex":"bb", "argon_params":{},
            "protected_vk_hex":"d00d", "protected_vk_nonce_hex":"0101",
            "recovery_salt_hex":"09", "recovery_protected_vk_hex":"5b39", "recovery_protected_vk_nonce_hex":"0101"
        })).await;
        assert_eq!(st, StatusCode::OK);
        assert!(body["token"].is_string());

        let (st, body) = send(&app, "POST", "/v1/auth/login", None,
            serde_json::json!({"email":"r@x.com","auth_secret_hex":"newnew"})).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body["protected_vk_hex"], "d00d");
    }
}
