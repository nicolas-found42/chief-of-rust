//! Integration tests over the real axum router with axum-test (survey #3:
//! assert on server-rendered HTML and status codes, not a DOM).

use tempfile::TempDir;

use chief_of_rust::{App, Config, db::Db, llm};

fn test_app(dir: &TempDir) -> App {
    let cfg = Config {
        port: 0,
        workspace_dir: dir.path().to_path_buf(),
        llm_provider: "mock".into(),
        openai_api_key: None,
        openai_base_url: None,
        openai_model: "gpt-4o-mini".into(),
        google_secret_path: None,
        google_token_path: dir.path().join("token.json"),
        google_redirect_port: 4319,
    };
    let db = Db::open(&cfg.db_path()).unwrap();
    App {
        cfg: cfg.clone(),
        db: db.clone(),
        llm: llm::from_config(&cfg),
    }
}

fn server_for(dir: &TempDir) -> axum_test::TestServer {
    axum_test::TestServer::new(chief_of_rust::routes::router(test_app(dir)))
}

#[tokio::test]
async fn home_page_renders_the_walking_skeleton() {
    let dir = TempDir::new().unwrap();
    let server = server_for(&dir);

    let response = server.get("/").await;
    assert_eq!(response.status_code(), 200);
    let html = response.text();
    assert!(html.contains("chief-of-rust 0.1.0"), "banner: {html}");
    assert!(html.contains("mock"), "provider name: {html}");
    assert!(html.contains("not connected"), "google state: {html}");
    assert!(html.contains("Background ticks:"), "tick counter: {html}");
    // The vendored htmx is reachable through the served route, not a CDN.
    assert!(html.contains("/static/htmx.min.js"), "htmx tag: {html}");
    let script = server.get("/static/htmx.min.js").await;
    assert_eq!(script.status_code(), 200);
    assert!(script.text().len() > 30_000, "vendored htmx bytes");
}

#[tokio::test]
async fn healthz_returns_the_banner() {
    let dir = TempDir::new().unwrap();
    let server = server_for(&dir);
    let response = server.get("/healthz").await;
    assert_eq!(response.status_code(), 200);
    assert_eq!(response.text(), "chief-of-rust 0.1.0");
}

#[tokio::test]
async fn plain_form_post_renders_full_page_with_reply() {
    let dir = TempDir::new().unwrap();
    let server = server_for(&dir);

    let response = server.post("/llm").form(&[("prompt", "ci check")]).await;
    assert_eq!(response.status_code(), 200);
    let html = response.text();
    assert!(html.contains("[mock] you said: ci check"), "reply: {html}");
    // The full page, not the fragment.
    assert!(html.contains("Background ticks:"), "full page: {html}");
}

#[tokio::test]
async fn htmx_post_gets_only_the_reply_fragment() {
    let dir = TempDir::new().unwrap();
    let server = server_for(&dir);

    let response = server
        .post("/llm")
        .add_header("hx-request", "true")
        .form(&[("prompt", "swap me")])
        .await;
    assert_eq!(response.status_code(), 200);
    let fragment = response.text();
    assert!(
        fragment.contains("[mock] you said: swap me"),
        "fragment: {fragment}"
    );
    assert!(
        !fragment.contains("Background ticks:"),
        "fragment must not be a full page"
    );
    assert!(
        fragment.starts_with("<div id=\"reply\">"),
        "fragment root: {fragment}"
    );
}

#[tokio::test]
async fn model_calls_are_recorded() {
    let dir = TempDir::new().unwrap();
    let server = server_for(&dir);

    server.post("/llm").form(&[("prompt", "record me")]).await;
    // The home page re-renders with the recorded reply and who made it.
    let html = server.get("/").await.text();
    assert!(
        html.contains("mock</strong> replied"),
        "provider shown: {html}"
    );
    assert!(html.contains("record me"), "prompt shown: {html}");
}

#[tokio::test]
async fn google_route_renders_not_connected_without_secret() {
    let dir = TempDir::new().unwrap();
    let server = server_for(&dir);

    let response = server.get("/google/calendars").await;
    assert_eq!(response.status_code(), 200);
    let html = response.text();
    assert!(html.contains("Not connected"), "state: {html}");
    assert!(html.contains("GOOGLE_CLIENT_SECRET_PATH"), "hint: {html}");
}
