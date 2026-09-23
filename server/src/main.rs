//! TermDeck E2EE sync server entrypoint.
//!
//! Storage is pluggable via the `Store` trait. Today it runs on an in-memory store
//! (great for local dev + the desktop dogfood loop; data is lost on restart). A Postgres
//! adapter implementing the same trait is the next task for durable production use.

mod routes;
mod store;

use std::sync::Arc;

use routes::{router, AppState};
use store::{InMemoryStore, PgStore, Store};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let bind = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8787".into());
    // DATABASE_URL → durable Postgres; unset → ephemeral in-memory (dev only).
    let store: Arc<dyn Store> = match std::env::var("DATABASE_URL") {
        Ok(url) => {
            tracing::info!("using Postgres store");
            Arc::new(PgStore::connect(&url).await.expect("connect to Postgres"))
        }
        Err(_) => {
            tracing::warn!("DATABASE_URL not set — using in-memory store (data lost on restart)");
            Arc::new(InMemoryStore::new())
        }
    };
    let app = router(AppState { store });

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
