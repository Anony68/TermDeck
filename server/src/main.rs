//! TermDeck E2EE sync server entrypoint.
//!
//! Storage is pluggable via the `Store` trait. Today it runs on an in-memory store
//! (great for local dev + the desktop dogfood loop; data is lost on restart). A Postgres
//! adapter implementing the same trait is the next task for durable production use.

mod routes;
mod store;

use std::sync::Arc;

use routes::{router, AppState};
use store::InMemoryStore;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let bind = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let state = AppState { store: Arc::new(InMemoryStore::new()) };
    let app = router(state);

    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .unwrap_or_else(|e| panic!("cannot bind {bind}: {e}"));
    tracing::info!("termdeck-sync-server (in-memory) listening on http://{bind}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("server error");
}
