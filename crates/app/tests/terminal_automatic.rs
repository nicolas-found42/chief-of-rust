//! Public HTTP/worker seam for automatic intake, publication and reports.
use chief_of_rust::{
    App, Config,
    db::Db,
    llm::LlmProvider,
    people::Person,
    terminal::{
        Company,
        automatic::{Candidate, Dossier, Request},
    },
};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{method, path},
};

struct Replies(Arc<Mutex<VecDeque<String>>>);
#[async_trait::async_trait]
impl LlmProvider for Replies {
    fn name(&self) -> &'static str {
        "test"
    }
    async fn complete(&self, _: &str) -> anyhow::Result<String> {
        self.0
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| anyhow::anyhow!("Unexpected generation call"))
    }
}
struct Fixture {
    app: App,
    server: axum_test::TestServer,
    replies: Arc<Mutex<VecDeque<String>>>,
    _search: MockServer,
    dir: tempfile::TempDir,
}
impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let search = MockServer::start().await;
        Mock::given(method("GET")).and(path("/search")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"results":[{"title":"Verified identity","url":"https://example.org/identity","content":"Jane Smith leads Acme. Jane Smith previously worked at Other. Acme makes widgets. Other makes tools. Jane Smith works at NewCo as CEO. Alex Jones is an Acme executive."}],"unresponsive_engines":[]}))).mount(&search).await;
        let mut cfg = Config::for_workspace(dir.path().to_path_buf());
        cfg.searxng_base_url = Some(search.uri());
        let replies = Arc::new(Mutex::new(VecDeque::new()));
        let app = App {
            db: Db::open(&cfg.db_path()).unwrap(),
            judge: chief_of_rust::judgments::from_config(&cfg),
            llm: Arc::new(Replies(replies.clone())),
            cfg,
        };
        let server = axum_test::TestServer::new(chief_of_rust::routes::router(app.clone()));
        Self {
            app,
            server,
            replies,
            _search: search,
            dir,
        }
    }
    fn reply(&self, value: Value) {
        self.replies.lock().unwrap().push_back(value.to_string());
    }
    async fn run(&self) {
        assert!(chief_of_rust::work::run_once(&self.app).await.unwrap());
    }
    async fn requests(&self) -> Vec<Request> {
        self.app.db.list("terminal_request").await.unwrap()
    }
}

fn dossier(kind: &str, marker: &str, existing: Option<&str>) -> Value {
    let headings = if kind == "person" {
        chief_of_rust::research::PERSON_LONG_BRIEF_HEADINGS.as_slice()
    } else {
        chief_of_rust::research::LONG_BRIEF_HEADINGS.as_slice()
    };
    json!({"body":headings.iter().map(|h|format!("## {h}\n{marker}. Evidence [s0]; other facts unknown.\n")).collect::<String>(),"claims":[],"identity":{"outcome":"resolved","existing_id":existing,"explanation":"Attributable identity evidence","references":[{"source_id":"s0","quote":"Jane Smith leads Acme."}],"alternatives":[]},"candidates":[]})
}

#[tokio::test]
async fn person_submission_researches_without_manual_steps_and_keeps_all_inputs() {
    let f = Fixture::new().await;
    f.reply(dossier("person", "First dossier", None));
    f.server
        .post("/terminal/intake")
        .form(&[
            ("kind", "person"),
            ("name", "Jane Smith"),
            ("email", "jane@example.org"),
            ("company", "Acme"),
            ("role", "CEO"),
            ("linkedin", "https://www.linkedin.com/in/jane"),
            ("website", "https://jane.example.org"),
            ("phone", "+1 555 0100"),
        ])
        .await
        .assert_status_see_other();
    assert!(f.app.db.list::<Person>("person").await.unwrap().is_empty());
    f.run().await;
    let request = f.requests().await.pop().unwrap();
    assert_eq!(request.status, "complete");
    let person: Person = f
        .app
        .db
        .get("person", request.target_id.as_ref().unwrap())
        .await
        .unwrap()
        .unwrap();
    let saved: Dossier = f
        .app
        .db
        .get("terminal_dossier", &format!("person:{}", person.id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.identity.phone, "+1 555 0100");
    assert_eq!(saved.identity.linkedin, "https://www.linkedin.com/in/jane");
    assert_eq!(saved.identity.website, "https://jane.example.org/");
    assert!(saved.body.contains("First dossier"));
    assert_eq!(saved.sources[0].title, "Verified identity");
    let html = f
        .server
        .get(&format!("/terminal/people/{}", person.id))
        .await
        .text();
    assert!(html.contains("First dossier"));
    assert!(!html.contains("<input"));
    assert!(!html.contains("<textarea"));
    let directory = f.server.get("/terminal/people").await.text();
    assert!(!directory.contains("Add a person"));
    assert!(!directory.contains("name=\"email\""));
}

#[tokio::test]
async fn company_submission_generates_a_complete_read_only_dossier() {
    let f = Fixture::new().await;
    f.reply(dossier("company", "Company dossier", None));
    f.server
        .post("/terminal/intake")
        .form(&[
            ("kind", "company"),
            ("name", "Acme"),
            ("website", "https://acme.example.org"),
            ("jurisdiction", "Delaware"),
            ("phone", "+1 555 0200"),
        ])
        .await
        .assert_status_see_other();
    f.run().await;
    let company = f
        .app
        .db
        .list::<Company>("company")
        .await
        .unwrap()
        .pop()
        .unwrap();
    let saved: Dossier = f
        .app
        .db
        .get("terminal_dossier", &format!("company:{}", company.id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.identity.phone, "+1 555 0200");
    assert_eq!(saved.identity.jurisdiction, "Delaware");
    let html = f
        .server
        .get(&format!("/terminal/companies/{}", company.id))
        .await
        .text();
    assert!(html.contains("Financial and operating evidence"));
    assert!(!html.contains("<input"));
    assert!(!html.contains("<textarea"));
    let directory = f.server.get("/terminal/companies").await.text();
    assert!(!directory.contains("name=\"website\""));
    assert!(!directory.contains("Compare companies"));
}

#[tokio::test]
async fn updating_a_job_keeps_identity_archives_old_dossier_and_preserves_success_on_failure() {
    let f = Fixture::new().await;
    f.reply(dossier("person", "Original dossier", None));
    f.server
        .post("/terminal/intake")
        .form(&[
            ("kind", "person"),
            ("name", "Jane Smith"),
            ("company", "Acme"),
        ])
        .await
        .assert_status_see_other();
    f.run().await;
    let person = f
        .app
        .db
        .list::<Person>("person")
        .await
        .unwrap()
        .pop()
        .unwrap();
    let mut updated = dossier("person", "New job dossier", Some(&person.id));
    updated["employment"] = json!({"company":"NewCo","role":"CEO","effective_date":null,"references":[{"source_id":"s0","quote":"Jane Smith works at NewCo as CEO."}]});
    f.reply(updated);
    f.server
        .post("/terminal/intake")
        .form(&[
            ("kind", "person"),
            ("name", "Jane Smith"),
            ("target_id", &person.id),
            ("version", "1"),
            ("company", "NewCo"),
        ])
        .await
        .assert_status_see_other();
    f.run().await;
    let current: Person = f.app.db.get("person", &person.id).await.unwrap().unwrap();
    assert_eq!(current.company, "NewCo");
    assert_eq!(current.version, 2);
    let saved: Dossier = f
        .app
        .db
        .get("terminal_dossier", &format!("person:{}", person.id))
        .await
        .unwrap()
        .unwrap();
    assert!(saved.body.contains("New job dossier"));
    assert!(!saved.employment_history.is_empty());
    assert!(
        saved
            .employment_history
            .iter()
            .any(|v| v["company"] == "Acme")
    );
    let archive = f
        .dir
        .path()
        .join("terminal-archive/person")
        .join(&person.id);
    let entries = std::fs::read_dir(archive)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect::<Vec<_>>();
    assert_eq!(entries.len(), 2);
    let old = entries
        .iter()
        .find(|p| p.extension().unwrap() == "json")
        .unwrap();
    let archived: Dossier = serde_json::from_slice(&std::fs::read(old).unwrap()).unwrap();
    assert_eq!(archived.identity.company, "Acme");
    assert!(archived.body.contains("Original dossier"));
    assert!(!archived.sources.is_empty());
    f.server
        .post("/terminal/intake")
        .form(&[
            ("kind", "person"),
            ("name", "Changed Name"),
            ("target_id", &person.id),
            ("version", "2"),
        ])
        .await
        .assert_status_conflict();
    f.replies
        .lock()
        .unwrap()
        .push_back("invalid response".into());
    f.server
        .post(&format!("/terminal/profiles/person/{}/refresh", person.id))
        .await
        .assert_status_see_other();
    f.run().await;
    let after: Dossier = f
        .app
        .db
        .get("terminal_dossier", &format!("person:{}", person.id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after.id, saved.id);
    let html = f
        .server
        .get(&format!("/terminal/people/{}", person.id))
        .await
        .text();
    assert!(html.contains("New job dossier"));
    assert!(!html.contains("Original dossier"));
    assert!(html.contains("Retry research"));
}

#[tokio::test]
async fn ambiguous_identity_waits_on_homepage_and_namesakes_remain_separate() {
    let f = Fixture::new().await;
    f.reply(dossier("person", "Jane at Acme", None));
    f.server
        .post("/terminal/intake")
        .form(&[
            ("kind", "person"),
            ("name", "Jane Smith"),
            ("company", "Acme"),
        ])
        .await
        .assert_status_see_other();
    f.run().await;
    let mut ambiguous = dossier("person", "Unpublished", None);
    ambiguous["identity"] = json!({"outcome":"ambiguous","existing_id":null,"explanation":"Two namesakes have different employers","references":[],"alternatives":[{"identity":{"kind":"person","name":"Jane Smith","company":"Other"},"existing_id":null,"explanation":"The intended namesake works at Other","references":[{"source_id":"s0","quote":"Jane Smith previously worked at Other."}]}]});
    f.reply(ambiguous);
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "person"), ("name", "Jane Smith")])
        .await
        .assert_status_see_other();
    f.run().await;
    let waiting = f
        .requests()
        .await
        .into_iter()
        .find(|r| r.status == "needs-clarification")
        .unwrap();
    assert_eq!(f.app.db.list::<Person>("person").await.unwrap().len(), 1);
    f.server
        .get("/terminal")
        .await
        .assert_text_contains("Two namesakes")
        .assert_text_contains("Research this identity");
    f.reply(dossier("person", "Jane at Other", None));
    f.server
        .post(&format!("/terminal/resolve/{}", waiting.id))
        .form(&[("choice", "0")])
        .await
        .assert_status_see_other();
    f.run().await;
    let people = f.app.db.list::<Person>("person").await.unwrap();
    assert_eq!(people.len(), 2);
    assert!(people.iter().any(|p| p.company == "Acme"));
    assert!(people.iter().any(|p| p.company == "Other"));
    assert_eq!(
        f.app
            .db
            .list::<Dossier>("terminal_dossier")
            .await
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn candidates_need_a_click_and_dismissal_survives_rediscovery() {
    let f = Fixture::new().await;
    let mut response = dossier("company", "Company dossier", None);
    response["candidates"] = json!([{"identity":{"kind":"person","name":"Alex Jones","company":"Acme","role":"Executive"},"reason":"Executive of researched company","references":[{"source_id":"s0","quote":"Alex Jones is an Acme executive."}]}]);
    f.reply(response.clone());
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "company"), ("name", "Acme")])
        .await
        .assert_status_see_other();
    f.run().await;
    assert!(f.app.db.list::<Person>("person").await.unwrap().is_empty());
    let candidate: Candidate = f
        .app
        .db
        .list("terminal_candidate")
        .await
        .unwrap()
        .pop()
        .unwrap();
    f.server
        .get("/terminal")
        .await
        .assert_text_contains("Alex Jones")
        .assert_text_contains("Executive of researched company");
    f.server
        .post(&format!("/terminal/candidates/{}", candidate.id))
        .form(&[("action", "dismiss")])
        .await
        .assert_status_see_other();
    let company = f
        .app
        .db
        .list::<Company>("company")
        .await
        .unwrap()
        .pop()
        .unwrap();
    response["identity"]["existing_id"] = json!(company.id);
    f.reply(response);
    f.server
        .post(&format!(
            "/terminal/profiles/company/{}/refresh",
            company.id
        ))
        .await
        .assert_status_see_other();
    f.run().await;
    assert_eq!(
        f.app
            .db
            .list::<Candidate>("terminal_candidate")
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(
        f.app
            .db
            .get::<Candidate>("terminal_candidate", &candidate.id)
            .await
            .unwrap()
            .unwrap()
            .dismissed
    );
    let html = f.server.get("/terminal").await.text();
    assert!(!html.contains("Alex Jones"));
}

#[tokio::test]
async fn reports_use_dossiers_and_fresh_evidence_and_flag_newer_dossiers() {
    let f = Fixture::new().await;
    f.reply(dossier("company", "Acme complete dossier", None));
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "company"), ("name", "Acme")])
        .await
        .assert_status_see_other();
    f.run().await;
    let company = f
        .app
        .db
        .list::<Company>("company")
        .await
        .unwrap()
        .pop()
        .unwrap();
    f.reply(dossier("person", "Jane complete dossier", None));
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "person"), ("name", "Jane Smith")])
        .await
        .assert_status_see_other();
    f.run().await;
    let person = f
        .app
        .db
        .list::<Person>("person")
        .await
        .unwrap()
        .pop()
        .unwrap();
    let saved_before = f.app.db.list::<Dossier>("terminal_dossier").await.unwrap();
    f.reply(json!({"body":"## Findings\nJane Smith leads Acme. [r0]\n## Limits\nOnly public evidence was available."}));
    let subject1 = format!("company:{}", company.id);
    let subject2 = format!("person:{}", person.id);
    f.server
        .post("/terminal/reports")
        .form(&[
            ("subject_1", subject1.as_str()),
            ("subject_2", subject2.as_str()),
            ("question", "How is Jane associated with Acme?"),
        ])
        .await
        .assert_status_see_other();
    f.run().await;
    let report: Value = f
        .app
        .db
        .list("terminal_report")
        .await
        .unwrap()
        .pop()
        .unwrap();
    let report_id = report["id"].as_str().unwrap();
    assert!(
        report["body"]
            .as_str()
            .unwrap()
            .contains("Jane Smith leads Acme")
    );
    assert_eq!(report["subjects"].as_array().unwrap().len(), 2);
    assert!(report["sources"].as_array().unwrap().len() > 2);
    let saved_after = f.app.db.list::<Dossier>("terminal_dossier").await.unwrap();
    assert_eq!(
        saved_before.iter().map(|d| &d.id).collect::<Vec<_>>(),
        saved_after.iter().map(|d| &d.id).collect::<Vec<_>>()
    );
    let old_report = report["body"].clone();
    f.reply(dossier(
        "company",
        "Acme updated dossier",
        Some(&company.id),
    ));
    f.server
        .post(&format!(
            "/terminal/profiles/company/{}/refresh",
            company.id
        ))
        .await
        .assert_status_see_other();
    f.run().await;
    f.server
        .get(&format!("/terminal/reports/{report_id}"))
        .await
        .assert_text_contains("Newer dossier available")
        .assert_text_contains("Refresh report");
    let unchanged: Value = f
        .app
        .db
        .get("terminal_report", report_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unchanged["body"], old_report);
    f.reply(json!({"body":"## Findings\nNew comparison based on the current dossiers. [r0]"}));
    f.server
        .post(&format!("/terminal/reports/{report_id}/refresh"))
        .await
        .assert_status_see_other();
    f.run().await;
    let html = f
        .server
        .get(&format!("/terminal/reports/{report_id}"))
        .await
        .text();
    assert!(html.contains("New comparison"));
    assert!(!html.contains("Newer dossier available"));
}

#[tokio::test]
async fn archive_write_failure_never_replaces_the_dossier() {
    let f = Fixture::new().await;
    f.reply(dossier("company", "Original", None));
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "company"), ("name", "Acme")])
        .await
        .assert_status_see_other();
    f.run().await;
    let company = f
        .app
        .db
        .list::<Company>("company")
        .await
        .unwrap()
        .pop()
        .unwrap();
    let path = f.app.cfg.terminal_archive_dir.clone();
    std::fs::write(&path, "This path cannot be a directory").unwrap();
    f.reply(dossier("company", "Must not publish", Some(&company.id)));
    f.server
        .post(&format!(
            "/terminal/profiles/company/{}/refresh",
            company.id
        ))
        .await
        .assert_status_see_other();
    f.run().await;
    let current: Dossier = f
        .app
        .db
        .get("terminal_dossier", &format!("company:{}", company.id))
        .await
        .unwrap()
        .unwrap();
    assert!(current.body.contains("Original"));
    let company_now: Company = f.app.db.get("company", &company.id).await.unwrap().unwrap();
    assert_eq!(company_now.version, 1);
}

#[tokio::test]
async fn a_confident_repeat_submission_reuses_the_same_profile() {
    let f = Fixture::new().await;
    f.reply(dossier("person", "First", None));
    f.server
        .post("/terminal/intake")
        .form(&[
            ("kind", "person"),
            ("name", "Jane Smith"),
            ("email", "jane@example.org"),
            ("phone", "555-0100"),
        ])
        .await
        .assert_status_see_other();
    f.run().await;
    let person = f
        .app
        .db
        .list::<Person>("person")
        .await
        .unwrap()
        .pop()
        .unwrap();
    f.reply(dossier("person", "Matched repeat", Some(&person.id)));
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "person"), ("name", "Jane Smith")])
        .await
        .assert_status_see_other();
    f.run().await;
    let people = f.app.db.list::<Person>("person").await.unwrap();
    assert_eq!(people.len(), 1);
    assert_eq!(people[0].id, person.id);
    assert_eq!(people[0].email, "jane@example.org");
    let current: Dossier = f
        .app
        .db
        .get("terminal_dossier", &format!("person:{}", person.id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.identity.phone, "555-0100");
    assert!(current.body.contains("Matched repeat"));
}

#[tokio::test]
async fn failed_research_retry_tracks_the_new_attempt_and_publishes() {
    let f = Fixture::new().await;
    f.replies.lock().unwrap().push_back("malformed".into());
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "company"), ("name", "Acme")])
        .await
        .assert_status_see_other();
    f.run().await;
    let failed = f.requests().await.pop().unwrap();
    assert_eq!(failed.status, "failed");
    f.reply(dossier("company", "Recovered dossier", None));
    f.server
        .post(&format!("/runs/{}/retry", failed.run_id))
        .await
        .assert_status_see_other();
    let retried = f.requests().await.pop().unwrap();
    assert_ne!(retried.run_id, failed.run_id);
    assert_eq!(retried.status, "researching");
    f.run().await;
    let completed = f.requests().await.pop().unwrap();
    assert_eq!(completed.status, "complete");
    let original = chief_of_rust::work::find(&f.app.db, &failed.run_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(original.status, "failed");
    let recovery = chief_of_rust::work::find(&f.app.db, &completed.run_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(recovery.retry_of.as_deref(), Some(failed.run_id.as_str()));
    assert_eq!(recovery.status, "done");
}

#[tokio::test]
async fn researching_a_candidate_creates_only_that_candidate() {
    let f = Fixture::new().await;
    let mut response = dossier("company", "Company", None);
    response["candidates"] = json!([{"identity":{"kind":"person","name":"Alex Jones","company":"Acme"},"reason":"Executive","references":[{"source_id":"s0","quote":"Alex Jones is an Acme executive."}]}]);
    f.reply(response);
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "company"), ("name", "Acme")])
        .await
        .assert_status_see_other();
    f.run().await;
    let candidate: Candidate = f
        .app
        .db
        .list("terminal_candidate")
        .await
        .unwrap()
        .pop()
        .unwrap();
    let mut person = dossier("person", "Alex dossier", None);
    person["identity"]["references"] =
        json!([{"source_id":"s0","quote":"Alex Jones is an Acme executive."}]);
    f.reply(person);
    f.server
        .post(&format!("/terminal/candidates/{}", candidate.id))
        .form(&[("action", "research")])
        .await
        .assert_status_see_other();
    f.run().await;
    let people = f.app.db.list::<Person>("person").await.unwrap();
    assert_eq!(people.len(), 1);
    assert_eq!(people[0].name, "Alex Jones");
    assert_eq!(people[0].company, "Acme");
}
