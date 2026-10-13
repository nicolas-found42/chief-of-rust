//! Exercise the integrated SSR shell, rather than only individual product routers.
use chief_of_rust::{App, Config, db::Db, llm};
use tempfile::TempDir;
fn server_for(dir: &TempDir) -> (axum_test::TestServer, Db) {
    let cfg = Config::for_workspace(dir.path().to_path_buf());
    let db = Db::open(&cfg.db_path()).unwrap();
    let app = App {
        cfg: cfg.clone(),
        db: db.clone(),
        llm: llm::from_config(&cfg),
    };
    (
        axum_test::TestServer::new(chief_of_rust::routes::router(app)),
        db,
    )
}
#[tokio::test]
async fn five_product_pages_are_server_rendered_and_work_without_javascript() {
    let dir = TempDir::new().unwrap();
    let (server, _) = server_for(&dir);
    for (path, title) in [
        ("/", "Chief of Staff"),
        ("/meetings", "Upcoming"),
        ("/content-scout", "Content Engine"),
        ("/content-research", "Research"),
        ("/people", "People"),
        ("/tasks", "Tasks"),
        ("/settings", "mistral-large-4"),
        ("/runs", "Runs"),
    ] {
        let response = server.get(path).await;
        response.assert_status_ok();
        let html = response.text();
        assert!(html.contains(title), "{path}: {html}");
        assert!(html.contains("<nav aria-label=\"Products\""));
        assert!(!html.contains("<script"));
    }
    let html = server.get("/").await.text();
    assert!(html.contains("Offline test mode"));
    server.get("/static/app.css").await.assert_status_ok();
    server
        .get("/unknown-product")
        .await
        .assert_status_not_found();
}
#[tokio::test]
async fn healthz_names_the_binary() {
    let dir = TempDir::new().unwrap();
    let (server, _) = server_for(&dir);
    assert_eq!(server.get("/healthz").await.text(), "chief-of-rust 0.1.0");
}
#[tokio::test]
async fn diagnostic_records_actual_provider_and_escapes_response() {
    let dir = TempDir::new().unwrap();
    let (server, db) = server_for(&dir);
    let response = server
        .post("/llm")
        .form(&[("prompt", "<script>alert('x')</script>")])
        .await;
    response.assert_status_ok();
    let html = response.text();
    assert!(html.contains("&lt;script&gt;"));
    assert!(!html.contains("<script>"));
    let call = db.stats().await.unwrap().last_call.unwrap();
    assert_eq!(call.provider, "mock");
    assert_eq!(call.prompt, "<script>alert('x')</script>");
    assert_eq!(call.reply, "[mock] you said: <script>alert('x')</script>");
    server
        .post("/llm")
        .form(&[("prompt", "")])
        .await
        .assert_status_bad_request();
}
#[tokio::test]
async fn missing_google_credentials_explain_connection() {
    let dir = TempDir::new().unwrap();
    let (server, _) = server_for(&dir);
    let html = server.get("/google/calendars").await.text();
    assert!(html.contains("Not connected"));
    assert!(html.contains("GOOGLE_CLIENT_SECRET_PATH"));
}
