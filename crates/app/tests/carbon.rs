//! Carbon foundation (#56): the design-system stylesheet and the shared
//! component partials live beside the current stylesheet.
//!
//! The contract: one shared stylesheet plus shared partials proven on the
//! shell and one proving page; every other page byte-identical.

use chief_of_rust::{Config, db::Db, llm};
use scraper::{Html, Selector};
use tempfile::TempDir;

fn server_for(dir: &TempDir) -> axum_test::TestServer {
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
    axum_test::TestServer::new(chief_of_rust::routes::router(app))
}

fn count(html: &str, selector: &str) -> usize {
    Html::parse_document(html)
        .select(&Selector::parse(selector).unwrap())
        .count()
}

/// The Carbon stylesheet is served as its own static asset with no external
/// font or asset URL: self-hosted system typography only.
#[tokio::test]
async fn carbon_stylesheet_is_served_with_no_external_asset_url() {
    let dir = TempDir::new().unwrap();
    let server = server_for(&dir);
    let response = server.get("/static/carbon.css").await;
    response.assert_status_ok();
    let css = response.text();
    // Tokens that prove the foundation is real, not an empty file.
    for token in [
        "--cds-background",
        "--cds-text-primary",
        "--cds-text-secondary",
        "--cds-link-primary",
        "--cds-border-subtle",
        "--cds-focus",
        "--cds-support-error",
        "--cds-support-success",
        "--cds-support-warning",
        "--cds-support-info",
        "--cds-spacing-",
        "--cds-type-",
        "--cds-line-height-",
    ] {
        assert!(css.contains(token), "carbon.css carries {token}");
    }
    // No external asset request: no URL fetch, no hosted font import.
    assert!(
        !css.contains("@import")
            && !css.contains("url(http")
            && !css.contains("url(\"http")
            && !css.contains("url('http"),
        "carbon.css is self-hosted"
    );
}

/// The shell keeps its landmarks and gains the shared Carbon classes; the
/// shell links the Carbon stylesheet alongside the current one.
#[tokio::test]
async fn shell_renders_carbon_landmarks_and_shared_classes() {
    let dir = TempDir::new().unwrap();
    let server = server_for(&dir);
    let html = server.get("/").await.text();
    assert!(
        html.contains("/static/carbon.css"),
        "shell loads the Carbon stylesheet: {html}"
    );
    assert_eq!(count(&html, "a.cds-skip-link[href='#main']"), 1, "{html}");
    assert_eq!(count(&html, "header.cds-header"), 1, "{html}");
    assert_eq!(count(&html, "nav.cds-header-nav[aria-label='Products']"), 1);
    assert_eq!(count(&html, "main.cds-content#main"), 1);
    assert_eq!(count(&html, "footer.cds-footer"), 1);
    assert!(!html.contains("<script"), "shell stays script-free: {html}");
}

/// The proving page exercises every shared component partial with no script
/// element, so the rollout ticket (#57) can trust the partials.
#[tokio::test]
async fn proving_page_renders_every_shared_carbon_partial() {
    let dir = TempDir::new().unwrap();
    let server = server_for(&dir);
    let response = server.get("/design").await;
    response.assert_status_ok();
    let html = response.text();
    assert_eq!(
        count(&html, "nav.cds-breadcrumb[aria-label='Breadcrumb']"),
        1,
        "{html}"
    );
    assert_eq!(count(&html, "section.cds-section"), 1, "{html}");
    assert_eq!(count(&html, "article.cds-card"), 1, "{html}");
    assert_eq!(count(&html, "table.cds-table"), 1, "{html}");
    assert_eq!(count(&html, "form.cds-form"), 1, "{html}");
    assert_eq!(count(&html, ".cds-btn.cds-btn--primary"), 1, "{html}");
    assert_eq!(count(&html, ".cds-btn.cds-btn--secondary"), 1, "{html}");
    assert_eq!(count(&html, ".cds-btn.cds-btn--danger"), 1, "{html}");
    assert_eq!(count(&html, ".cds-tag--green"), 1, "{html}");
    assert_eq!(count(&html, ".cds-tag--red"), 1, "{html}");
    assert_eq!(count(&html, ".cds-tag--gray"), 1, "{html}");
    assert_eq!(count(&html, ".cds-notification--info"), 1, "{html}");
    assert_eq!(count(&html, ".cds-notification--warning"), 1, "{html}");
    assert_eq!(count(&html, ".cds-notification--error"), 1, "{html}");
    assert_eq!(count(&html, ".cds-notification--success"), 1, "{html}");
    assert!(
        !html.contains("<script"),
        "proving page stays script-free: {html}"
    );
}

/// The current stylesheet is untouched: byte-identical behavior for pages
/// that have not migrated yet.
#[tokio::test]
async fn current_stylesheet_still_served() {
    let dir = TempDir::new().unwrap();
    let server = server_for(&dir);
    let response = server.get("/static/app.css").await;
    response.assert_status_ok();
    let css = response.text();
    assert!(css.contains(".badge-success"), "app.css keeps its classes");
}
