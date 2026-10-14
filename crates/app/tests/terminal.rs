//! Bloomberg Terminal HTTP seam: landing, company lifecycle, cutover.
use chief_of_rust::{App, Config, db::Db, llm::LlmProvider, terminal::Company};
use std::sync::Arc;

struct Reply;
#[async_trait::async_trait]
impl LlmProvider for Reply {
    fn name(&self) -> &'static str {
        "test"
    }
    async fn complete(&self, _: &str) -> anyhow::Result<String> {
        Ok("{}".into())
    }
}
fn app(dir: &tempfile::TempDir) -> App {
    let cfg = Config::for_workspace(dir.path().to_path_buf());
    App {
        judge: chief_of_rust::judgments::from_config(&cfg),
        db: Db::open(&cfg.db_path()).unwrap(),
        llm: Arc::new(Reply),
        cfg,
    }
}
fn server(app: &App) -> axum_test::TestServer {
    axum_test::TestServer::new(chief_of_rust::routes::router(app.clone()))
}

#[tokio::test]
async fn terminal_landing_shows_adjacent_person_and_company_sections() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let server = server(&app);
    server
        .get("/terminal")
        .await
        .assert_status_ok()
        .assert_text_contains("Person Profiles")
        .assert_text_contains("Company Profiles")
        .assert_text_contains("/terminal/people")
        .assert_text_contains("/terminal/companies");
}

#[tokio::test]
async fn old_person_routes_are_gone_without_redirects() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let server = server(&app);
    server.get("/people").await.assert_status_not_found();
}

#[tokio::test]
async fn company_create_edit_and_stale_save_behaves() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let server = server(&app);
    server
        .post("/terminal/companies")
        .form(&[
            ("name", "Acme Corp"),
            ("website", "https://acme.example.com"),
            ("jurisdiction", "Delaware"),
            ("identifiers", "LEI: 1234"),
            ("aliases", "Acme"),
        ])
        .await
        .assert_status_see_other();
    let c = app
        .db
        .list::<Company>("company")
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(c.domain, "acme.example.com");
    assert_eq!(c.version, 1);
    // Saving identity starts no Run.
    assert!(chief_of_rust::work::list(&app.db).await.unwrap().is_empty());
    server
        .get(&format!("/terminal/companies/{}", c.id))
        .await
        .assert_status_ok()
        .assert_text_contains("Acme Corp")
        .assert_text_contains("Run full research");
    server
        .post(&format!("/terminal/companies/{}", c.id))
        .form(&[("name", "Acme Corporation"), ("version", "1")])
        .await
        .assert_status_see_other();
    server
        .post(&format!("/terminal/companies/{}", c.id))
        .form(&[("name", "Lost update"), ("version", "1")])
        .await
        .assert_status_conflict();
    let current: Company = app.db.get("company", &c.id).await.unwrap().unwrap();
    assert_eq!(current.name, "Acme Corporation");
    assert_eq!(current.version, 2);
    // Directory search finds the renamed company.
    server
        .get("/terminal/companies?q=corporation")
        .await
        .assert_status_ok()
        .assert_text_contains("Acme Corporation");
}

#[tokio::test]
async fn company_website_must_be_credential_free_https() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let server = server(&app);
    server
        .post("/terminal/companies")
        .form(&[("name", "Bad"), ("website", "http://insecure.example.com")])
        .await
        .assert_status_bad_request();
    assert!(app.db.list::<Company>("company").await.unwrap().is_empty());
}
