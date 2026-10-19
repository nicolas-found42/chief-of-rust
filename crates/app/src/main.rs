//! Bootstrap the single-user Workspace and its durable worker.
use chief_of_rust::routes;
use std::time::Duration;
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args().nth(1).as_deref() == Some(chief_of_rust::pdf::WORKER_ARG) {
        return chief_of_rust::pdf::run_worker().await;
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    let app = chief_of_rust::Installation::from_env()?.app();
    let worker_app = app.clone();
    let worker = tokio::spawn(async move {
        loop {
            if let Err(error) = chief_of_rust::settings::tick(&worker_app).await {
                tracing::error!(%error,"schedule admission failed");
            }
            match chief_of_rust::work::run_once(&worker_app).await {
                Ok(true) => continue,
                Err(error) => tracing::error!(%error,"worker failed"),
                Ok(false) => {}
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
    let bind = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1".into());
    let listener = tokio::net::TcpListener::bind((bind.as_str(), app.cfg().port)).await?;
    let selected = chief_of_rust::settings::providers::resolve(&app).await?;
    tracing::info!(
        port = app.cfg().port,
        provider = selected.llm().name(),
        model = selected.cfg().llm_model(),
        "Workspace ready"
    );
    axum::serve(listener, routes::router(app))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    worker.abort();
    let _ = worker.await;
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
