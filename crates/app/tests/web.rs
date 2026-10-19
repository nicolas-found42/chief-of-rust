//! Exercise the integrated SSR shell, rather than only individual product routers.
use chief_of_rust::{Config, db::Db, llm};
use tempfile::TempDir;
fn server_for(dir: &TempDir) -> (axum_test::TestServer, Db) {
    let cfg = Config::for_workspace(dir.path().to_path_buf());
    let db = Db::open(&cfg.db_path()).unwrap();
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        db.clone(),
        llm::from_config(&cfg),
        chief_of_rust::judgments::from_config(&cfg),
        std::sync::Arc::new(chief_of_rust::collect::Pacer::system()),
    )
    .app();
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
        ("/terminal/people", "People"),
        ("/tasks", "Tasks"),
        ("/settings", "demo fixture"),
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
async fn browser_forms_keep_same_origin_and_reject_opaque_or_foreign_origins() {
    let dir = TempDir::new().unwrap();
    let (server, db) = server_for(&dir);
    let page = server.get("/terminal/people").await;
    assert_eq!(page.header("referrer-policy"), "same-origin");
    server
        .post("/terminal/people")
        .add_header("host", "localhost:5317")
        .add_header("origin", "http://localhost:5317")
        .add_header("sec-fetch-site", "same-origin")
        .form(&[
            ("name", "Browser Person"),
            ("email", "browser@example.test"),
        ])
        .await
        .assert_status_see_other();
    assert_eq!(
        db.list::<serde_json::Value>("person").await.unwrap().len(),
        1
    );
    for origin in ["null", "http://evil.example", "http://localhost:4317"] {
        server
            .post("/terminal/people")
            .add_header("host", "localhost:5317")
            .add_header("origin", origin)
            .form(&[("name", "Rejected Person")])
            .await
            .assert_status_forbidden();
    }
    assert_eq!(
        db.list::<serde_json::Value>("person").await.unwrap().len(),
        1
    );
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

#[test]
fn saved_times_are_readable_and_use_workspace_timezone_across_dst() {
    let summer = chief_of_rust::web::saved_time(1791893978391, "America/New_York");
    assert!(summer.contains("Oct 13, 2026 · 08:19 EDT"));
    assert!(summer.contains("datetime=\"2026-10-13T12:19:38.391+00:00\""));
    let winter = chief_of_rust::web::saved_time(0, "America/New_York");
    assert!(winter.contains("Dec 31, 1969 · 19:00 EST"));
    assert!(chief_of_rust::web::saved_time(0, "invalid-zone").contains("Jan 1, 1970 · 00:00 UTC"));
    assert_eq!(
        chief_of_rust::web::saved_time(i64::MAX, "UTC"),
        "Unknown time"
    );
}
