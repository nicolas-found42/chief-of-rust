//! Carbon design system (#56 foundation, #57 rollout): one shared stylesheet
//! and one shared component vocabulary across every product page.
//!
//! The contract: every route stays server-rendered and script-free, every page
//! renders the Carbon landmarks and shared classes, and no page keeps a local
//! markup convention of its own.

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

/// Every product page, in navigation order. Each one must render on the
/// Carbon system; no route may opt out with local markup.
const PRODUCT_PAGES: &[&str] = &[
    "/",
    "/meetings",
    "/meetings/history",
    "/meetings/weekly",
    "/transcripts",
    "/content",
    "/content-scout",
    "/content-research",
    "/research",
    "/youtube",
    "/terminal",
    "/terminal/people",
    "/terminal/companies",
    "/tasks",
    "/settings",
    "/onboarding",
    "/runs",
];

/// Classes the rollout removed. Their absence is the proof that a page uses
/// the shared vocabulary instead of a local one.
const LEGACY_CLASSES: &[&str] = &[
    "btn-primary",
    "btn-secondary",
    "btn-danger",
    "btn-sm",
    "badge-success",
    "badge-warning",
    "badge-danger",
    "badge-neutral",
    "class=\"badge",
    "class=\"notice\"",
    "class=\"prose\"",
    "form-grid",
    "class=\"toolbar\"",
    "class=\"inline-form\"",
    "class=\"steps\"",
    "class=\"stack\"",
    "class=\"progress\"",
    "class=\"check\"",
    "class=\"finding\"",
    "class=\"schedule\"",
    "class=\"preserve-lines\"",
    "class=\"danger-zone\"",
    "class=\"input-sm\"",
    "class=\"eyebrow\"",
    "class=\"lead\"",
    "class=\"grid",
];

/// The Carbon stylesheet is the only stylesheet served, and it is self-hosted:
/// no external font, script, image or stylesheet request.
#[tokio::test]
async fn carbon_stylesheet_is_served_with_no_external_asset_url() {
    let dir = TempDir::new().unwrap();
    let server = server_for(&dir);
    let response = server.get("/static/carbon.css").await;
    response.assert_status_ok();
    let css = response.text();
    // Tokens that prove the design system is real, not an empty file.
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
        // Rollout components.
        ".cds-card",
        ".cds-table",
        ".cds-form",
        ".cds-btn--danger",
        ".cds-tag--red",
        ".cds-notification--error",
        ".cds-cards",
        ".cds-toolbar",
        ".cds-steps",
    ] {
        assert!(css.contains(token), "carbon.css carries {token}");
    }
    // No external asset request: no URL fetch, no hosted font import.
    assert!(
        !css.contains("@import")
            && !css.contains("url(http")
            && !css.contains("url(\"http")
            && !css.contains("url('http")
            && !css.contains("url(//"),
        "carbon.css is self-hosted"
    );
    // Keyboard focus stays visible on every interactive element.
    assert!(
        css.contains(":focus-visible"),
        "carbon.css keeps focus visible"
    );
    for control in ["a", "button", "input", "select", "textarea", "summary"] {
        assert!(
            css.contains(&format!("{control}:focus-visible")),
            "carbon.css draws focus on {control}"
        );
    }
    // The superseded stylesheet is gone: one shared stylesheet carries the
    // system, and no page keeps a second local convention.
    server
        .get("/static/app.css")
        .await
        .assert_status_not_found();
}

/// Every product page renders the Carbon landmarks and shared classes, links
/// only the shared stylesheet, and stays script-free.
#[tokio::test]
async fn every_product_page_renders_carbon_landmarks_and_shared_classes() {
    let dir = TempDir::new().unwrap();
    let server = server_for(&dir);
    for path in PRODUCT_PAGES {
        let response = server.get(path).await;
        response.assert_status_ok();
        let html = response.text();
        assert_eq!(
            count(&html, "a.cds-skip-link[href='#main']"),
            1,
            "{path} keeps the skip link: {html}"
        );
        assert_eq!(count(&html, "header.cds-header"), 1, "{path}");
        assert_eq!(
            count(&html, "nav.cds-header-nav[aria-label='Products']"),
            1,
            "{path}"
        );
        assert_eq!(count(&html, "main.cds-content#main"), 1, "{path}");
        assert_eq!(count(&html, "footer.cds-footer"), 1, "{path}");
        assert_eq!(
            count(&html, "link[rel='stylesheet'][href='/static/carbon.css']"),
            1,
            "{path} links the shared stylesheet"
        );
        assert_eq!(
            count(&html, "link[rel='stylesheet']"),
            1,
            "{path} links exactly one stylesheet: {html}"
        );
        assert_eq!(
            count(&html, "script"),
            0,
            "{path} stays script-free: {html}"
        );
        assert_eq!(
            count(&html, "h1"),
            1,
            "{path} declares one page heading: {html}"
        );
        for legacy in LEGACY_CLASSES {
            assert!(
                !html.contains(legacy),
                "{path} keeps the legacy class {legacy}: {html}"
            );
        }
        // No remote asset of any kind: the page's own attributes never point
        // at another origin.
        for element in ["link", "script", "img", "iframe", "source"] {
            for node in Html::parse_document(&html).select(&Selector::parse(element).unwrap()) {
                for attribute in ["href", "src"] {
                    if let Some(value) = node.value().attr(attribute) {
                        assert!(
                            !value.starts_with("http://") && !value.starts_with("https://"),
                            "{path} loads a remote asset from {value}"
                        );
                    }
                }
            }
        }
    }
}

/// The proving page exercises every shared component partial with no script
/// element, so the rollout has one gallery of the vocabulary.
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

/// Severity is carried by the shared tag palette, so a partial, blocked or
/// failed state never renders with the success color.
#[test]
fn severity_keeps_its_meaning_in_the_shared_tag() {
    use chief_of_rust::web::badge;
    for (state, class, text) in [
        ("partial", "cds-tag--yellow", "Partial"),
        ("blocked", "cds-tag--red", "Blocked"),
        ("failed", "cds-tag--red", "Failed"),
        ("pending", "cds-tag--yellow", "Pending"),
        ("running", "cds-tag--yellow", "Running"),
        ("done", "cds-tag--green", "Done"),
        ("needs review", "cds-tag--yellow", "Needs review"),
        ("unknown state", "cds-tag--gray", "Unknown state"),
    ] {
        let html = badge(state);
        assert!(
            html.contains(class) && html.contains(text),
            "{state} renders as {class} with its text: {html}"
        );
        if class != "cds-tag--green" {
            assert!(
                !html.contains("cds-tag--green"),
                "{state} never looks successful: {html}"
            );
        }
    }
}
