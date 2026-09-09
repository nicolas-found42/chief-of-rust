//! Walking-skeleton binary (issue #2 prototype): boot config, open SQLite,
//! spawn the background tick, serve the SSR app on loopback.

use std::time::Duration;

use tokio::time::MissedTickBehavior;

use chief_of_rust::{App, Config, db, llm, routes};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cfg = Config::from_env();
    let db = db::Db::open(&cfg.db_path())?;
    let provider = llm::from_config(&cfg);
    tracing::info!(
        port = cfg.port,
        db = %cfg.db_path().display(),
        provider = provider.name(),
        "booting"
    );

    let app = App {
        cfg: cfg.clone(),
        db: db.clone(),
        llm: provider,
    };

    // The background tick: one interval task writing heartbeats to SQLite.
    // The durable clock and job queues grow from exactly this shape.
    tokio::spawn(tick_loop(db));

    // Bind all interfaces: the container's loopback is unreachable from the
    // host, so a published port would otherwise get an empty reply. The
    // loopback-only guarantee lives in the compose publish (127.0.0.1:port).
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", cfg.port)).await?;
    tracing::info!("listening on 0.0.0.0:{}", cfg.port);
    axum::serve(listener, routes::router(app))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn tick_loop(db: db::Db) {
    let mut interval = tokio::time::interval(Duration::from_secs(5));
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        let at = chief_of_rust::now_ms();
        match db.record_tick(at).await {
            Ok(()) => tracing::info!(at, "tick"),
            Err(error) => tracing::error!(%error, "tick write failed"),
        }
    }
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
}
