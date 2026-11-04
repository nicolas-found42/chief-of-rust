//! Bootstrap the single-user Workspace and its durable worker.
use chief_of_rust::routes;
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args().nth(1).as_deref() == Some(chief_of_rust::pdf::WORKER_ARG) {
        return chief_of_rust::pdf::run_worker().await;
    }
    // `inspect` never boots the server: it reads the workspace store
    // read-only and exits, so investigation works while the app is down.
    if std::env::args().nth(1).as_deref() == Some("inspect") {
        let args: Vec<String> = std::env::args().skip(2).collect();
        return chief_of_rust::inspect::run(&args);
    }
    // `RUST_LOG_FORMAT=json` selects line-delimited JSON for log aggregation;
    // the default human-readable format is unchanged for local runs.
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    if std::env::var("RUST_LOG_FORMAT").is_ok_and(|v| v == "json") {
        tracing_subscriber::fmt()
            .json()
            .with_env_filter(filter)
            .init();
    } else {
        tracing_subscriber::fmt().with_env_filter(filter).init();
    }
    let app = chief_of_rust::Installation::from_env()?.app();
    let worker = chief_of_rust::work::spawn_supervised(app.clone());
    let bind = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1".into());
    let listener = tokio::net::TcpListener::bind((bind.as_str(), app.cfg().port)).await?;
    let selected = chief_of_rust::settings::providers::resolve(&app).await?;
    tracing::info!(
        port = app.cfg().port,
        provider = selected.llm().name(),
        model = selected.cfg().llm_model(),
        "Workspace ready"
    );
    axum::serve(listener, routes::router(app.clone()))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    worker.abort();
    let _ = worker.await;
    // Best-effort lifecycle marker: boot and shutdown pairs make restart
    // history reconstructable from the store alone.
    let _ = app
        .db()
        .record_ops_event("lifecycle", "shutdown", None)
        .await;
    Ok(())
}
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {_=ctrl_c=>{},_=terminate=>{}}
    tracing::info!("Shutting down; admitted Runs remain durable");
}
