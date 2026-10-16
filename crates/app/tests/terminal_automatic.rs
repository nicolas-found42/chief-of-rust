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
    async fn complete(&self, prompt: &str) -> anyhow::Result<String> {
        if prompt.starts_with("TERMINAL_DOSSIER_SECTIONS") {
            let titles = prompt
                .split_once("Required Markdown headings in this exact order: ")
                .unwrap()
                .1
                .split_once(". Give each applicable section")
                .unwrap()
                .0;
            let sections = serde_json::from_str::<Vec<String>>(titles)
                .unwrap()
                .into_iter()
                .map(|title| {
                    (
                        title,
                        json!("Jane Smith leads Acme. [s0] Other details are unknown."),
                    )
                })
                .collect::<serde_json::Map<_, _>>();
            return Ok(json!({"sections":sections}).to_string());
        }
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
    assert_eq!(
        request.status,
        "complete",
        "{:?}",
        chief_of_rust::work::find(&f.app.db, &request.run_id)
            .await
            .unwrap()
            .unwrap()
            .error
    );
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

#[tokio::test]
async fn same_named_subjects_with_distinct_inputs_can_queue_together() {
    let f = Fixture::new().await;
    for email in ["first@example.org", "second@example.org"] {
        f.server
            .post("/terminal/intake")
            .form(&[
                ("kind", "person"),
                ("name", "Jane Smith"),
                ("company", "Acme"),
                ("email", email),
            ])
            .await
            .assert_status_see_other();
    }
    let requests = f.requests().await;
    assert_eq!(requests.len(), 2);
    assert_ne!(requests[0].run_id, requests[1].run_id);
}

#[tokio::test]
async fn candidate_namesakes_stay_separate_and_linkedin_dismissal_survives_job_changes() {
    let f = Fixture::new().await;
    let mut response = dossier("company", "Acme", None);
    response["candidates"] = json!([
        {"identity":{"kind":"person","name":"Alex Jones","company":"Acme","role":"Engineer","email":"alex1@example.org"},"reason":"Engineer","references":[{"source_id":"s0","quote":"Alex Jones is an Acme executive."}]},
        {"identity":{"kind":"person","name":"Alex Jones","company":"Acme","role":"Director","email":"alex2@example.org"},"reason":"Director","references":[{"source_id":"s0","quote":"Alex Jones is an Acme executive."}]},
        {"identity":{"kind":"person","name":"Stable Person","company":"Acme","linkedin":"https://www.linkedin.com/in/stable-person"},"reason":"Executive","references":[{"source_id":"s0","quote":"Alex Jones is an Acme executive."}]}
    ]);
    f.reply(response.clone());
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "company"), ("name", "Acme")])
        .await
        .assert_status_see_other();
    f.run().await;
    let candidates = f
        .app
        .db
        .list::<Candidate>("terminal_candidate")
        .await
        .unwrap();
    assert_eq!(candidates.len(), 3);
    let stable = candidates
        .iter()
        .find(|c| c.identity.name == "Stable Person")
        .unwrap();
    f.server
        .post(&format!("/terminal/candidates/{}", stable.id))
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
    response["candidates"][2]["identity"]["company"] = json!("Other");
    response["candidates"][0]["identity"]["website"] = json!("https://alex.example.org");
    response["candidates"][0]["identity"]["linkedin"] =
        json!("https://www.linkedin.com/in/alex-jones");
    f.reply(response);
    f.server
        .post(&format!(
            "/terminal/profiles/company/{}/refresh",
            company.id
        ))
        .await
        .assert_status_see_other();
    f.run().await;
    let after = f
        .app
        .db
        .list::<Candidate>("terminal_candidate")
        .await
        .unwrap();
    assert_eq!(after.len(), 3);
    assert!(after.iter().find(|c| c.id == stable.id).unwrap().dismissed);
}

#[tokio::test]
async fn complete_dossier_sections_are_automatic_and_claim_distinctions_are_preserved() {
    let f = Fixture::new().await;
    let mut response = dossier("company", "", None);
    response["body"] = json!("");
    response["claims"] = json!([
        {"id":"c1","text":"Jane Smith leads Acme.","status":"supported","source_ids":["s0"]},
        {"id":"c2","text":"An attributed statement","status":"self_reported","source_ids":["s0"]},
        {"id":"c3","text":"A hypothesis","status":"inference","source_ids":["s0"]},
        {"id":"c4","text":"An operator hint","status":"user_context","source_ids":[]},
        {"id":"c5","text":"No evidence","status":"unsupported","source_ids":[]},
        {"id":"c6","text":"Conflicting claim","status":"contradicted","source_ids":[],"contrary_source_ids":["s0"]},
        {"id":"c7","text":"Identity unresolved","status":"unresolved","source_ids":[]}
    ]);
    f.reply(response);
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "company"), ("name", "Acme")])
        .await
        .assert_status_see_other();
    f.run().await;
    let request = f.requests().await.pop().unwrap();
    assert_eq!(
        request.status,
        "complete",
        "{:?}",
        chief_of_rust::work::find(&f.app.db, &request.run_id)
            .await
            .unwrap()
            .unwrap()
            .error
    );
    let saved: Dossier = f
        .app
        .db
        .list("terminal_dossier")
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(saved.claims.len(), 7);
    assert_eq!(saved.claims[5].contrary_source_ids, vec!["s0"]);
    assert_eq!(
        saved
            .claims
            .iter()
            .map(|c| c.status.as_str())
            .collect::<Vec<_>>(),
        vec![
            "supported",
            "self_reported",
            "inference",
            "user_context",
            "unsupported",
            "contradicted",
            "unresolved"
        ]
    );
    assert!(saved.body.contains("Financial and operating evidence"));
    assert!(saved.body.contains("Risks and evidence gaps"));
    let generated = f.app.db.list::<Value>("terminal_sections").await.unwrap();
    assert!(!generated.is_empty());
    for section in generated {
        let body = section["body"].as_str().unwrap();
        assert!(!body.contains("## Research context"));
        assert!(!body.contains("## Reference check"));
        assert!(!body.contains("## Evidence and coverage appendix"));
    }
    assert!(saved.body.contains("## Research context"));
    assert!(saved.body.contains("## Reference check"));
    assert!(saved.body.contains("## Evidence and coverage appendix"));
}

#[tokio::test]
async fn privacy_deletion_removes_automatic_checkpoints_reports_and_repo_archives() {
    let f = Fixture::new().await;
    f.reply(dossier("company", "First dossier", None));
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
    let mut updated = dossier("company", "", Some(&company.id));
    updated["body"] = json!("");
    f.reply(updated);
    f.server
        .post(&format!(
            "/terminal/profiles/company/{}/refresh",
            company.id
        ))
        .await
        .assert_status_see_other();
    f.run().await;
    let archive = f
        .app
        .cfg
        .terminal_archive_dir
        .join("company")
        .join(&company.id);
    assert!(archive.exists());
    f.reply(json!({"body":"## Findings\nAcme dossier comparison. [r0]"}));
    let subject = format!("company:{}", company.id);
    f.server
        .post("/terminal/reports")
        .form(&[
            ("subject_1", subject.as_str()),
            ("question", "What is known about Acme?"),
        ])
        .await
        .assert_status_see_other();
    f.run().await;
    f.server
        .post(&format!(
            "/terminal/companies/{}/privacy-delete",
            company.id
        ))
        .form(&[("version", "2"), ("acknowledgement", "DELETE")])
        .await
        .assert_status_see_other();
    for kind in [
        "terminal_identity",
        "terminal_dossier",
        "terminal_collection",
        "terminal_synthesis",
        "terminal_sections",
        "terminal_report",
        "terminal_request",
    ] {
        assert!(
            f.app.db.list::<Value>(kind).await.unwrap().is_empty(),
            "{kind} retained personal or company data"
        );
    }
    assert!(!archive.exists());
    assert!(
        chief_of_rust::work::list(&f.app.db)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn rejected_generation_is_repaired_and_retry_never_reuses_bad_citations() {
    let f = Fixture::new().await;
    let mut bad = dossier("company", "Bad generated citation", None);
    bad["body"] = json!(bad["body"].as_str().unwrap().replace("[s0]", "[s999]"));
    f.reply(bad.clone());
    f.reply(bad);
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "company"), ("name", "Acme")])
        .await
        .assert_status_see_other();
    f.run().await;
    let failed = f.requests().await.pop().unwrap();
    assert_eq!(failed.status, "failed");
    assert!(
        f.app
            .db
            .list::<Dossier>("terminal_dossier")
            .await
            .unwrap()
            .is_empty()
    );
    f.reply(dossier("company", "Repaired dossier", None));
    f.server
        .post(&format!("/runs/{}/retry", failed.run_id))
        .await
        .assert_status_see_other();
    f.run().await;
    let saved: Dossier = f
        .app
        .db
        .list("terminal_dossier")
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert!(saved.body.contains("Repaired dossier"));
    assert!(!saved.body.contains("s999"));
    let requests = f._search.received_requests().await.unwrap();
    assert_eq!(
        requests.len(),
        1,
        "Generation retries should reuse the collection checkpoint"
    );
}

#[tokio::test]
async fn malformed_model_references_are_repaired_automatically_before_publication() {
    let f = Fixture::new().await;
    let mut malformed = dossier("company", "Malformed output", None);
    malformed["identity"]["references"] = json!(["source_id: s0"]);
    f.reply(malformed);
    f.reply(dossier("company", "Corrected schema", None));
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "company"), ("name", "Acme")])
        .await
        .assert_status_see_other();
    f.run().await;
    assert_eq!(f.requests().await.pop().unwrap().status, "complete");
    let saved: Dossier = f
        .app
        .db
        .list("terminal_dossier")
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert!(saved.body.contains("Corrected schema"));
    assert!(!saved.body.contains("Malformed output"));
    assert_eq!(f._search.received_requests().await.unwrap().len(), 1);
}

#[tokio::test]
async fn flattened_identity_quotes_are_reselected_without_regenerating_the_dossier() {
    let f = Fixture::new().await;
    let mut response = dossier("company", "Original substantive dossier", None);
    response["identity"]["references"] =
        json!([{"source_id":"s0","quote":"name Jane Smith employer Acme"}]);
    f.reply(response);
    f.reply(json!({"references":[{"source_id":"s0","quote":"Jane Smith leads Acme."}]}));
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "company"), ("name", "Acme")])
        .await
        .assert_status_see_other();
    f.run().await;
    assert_eq!(f.requests().await.pop().unwrap().status, "complete");
    let saved: Dossier = f
        .app
        .db
        .list("terminal_dossier")
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert!(saved.body.contains("Original substantive dossier"));
    assert_eq!(f._search.received_requests().await.unwrap().len(), 1);
}

#[tokio::test]
async fn failed_quote_repair_is_a_retryable_error_not_empty_identity_clarification() {
    let f = Fixture::new().await;
    let mut response = dossier("company", "Unpublishable", None);
    response["identity"]["references"] =
        json!([{"source_id":"s0","quote":"invented identity quotation"}]);
    f.reply(response);
    f.reply(json!({"references":[{"source_id":"s0","quote":"still invented"}]}));
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "company"), ("name", "Acme")])
        .await
        .assert_status_see_other();
    f.run().await;
    let request = f.requests().await.pop().unwrap();
    assert_eq!(request.status, "failed");
    let run = chief_of_rust::work::find(&f.app.db, &request.run_id)
        .await
        .unwrap()
        .unwrap();
    assert!(run.error.as_ref().unwrap().contains("quotation repair"));
    assert!(
        f.app
            .db
            .list::<Dossier>("terminal_dossier")
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn automatic_repair_feedback_is_not_published_as_research_evidence() {
    let f = Fixture::new().await;
    let mut bad = dossier("company", "Rejected assertion", None);
    bad["body"] = json!(bad["body"].as_str().unwrap().replace("[s0]", "[s999]"));
    f.reply(bad);
    f.reply(dossier("company", "Verified replacement", None));
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "company"), ("name", "Acme")])
        .await
        .assert_status_see_other();
    f.run().await;
    assert_eq!(f.requests().await.pop().unwrap().status, "complete");
    let saved: Dossier = f
        .app
        .db
        .list("terminal_dossier")
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert!(saved.body.contains("Verified replacement"));
    for rejected in [
        "Rejected assertion",
        "s999",
        "Previous draft",
        "unknown source",
    ] {
        assert!(
            !saved.body.contains(rejected),
            "Repair details leaked into visible dossier: {rejected}"
        );
        assert!(
            !saved
                .limitations
                .iter()
                .any(|limit| limit.contains(rejected))
        );
    }
}

#[tokio::test]
async fn a_bad_extra_identity_quote_does_not_discard_valid_identification() {
    let f = Fixture::new().await;
    let mut response = dossier("company", "Valid identity", None);
    response["identity"]["references"]
        .as_array_mut()
        .unwrap()
        .push(
            json!({"source_id":"s0","quote":"A reconstructed quotation that is not in the source"}),
        );
    f.reply(response);
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "company"), ("name", "Acme")])
        .await
        .assert_status_see_other();
    f.run().await;
    let saved: Dossier = f
        .app
        .db
        .list("terminal_dossier")
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert!(
        saved
            .limitations
            .iter()
            .any(|l| l.contains("proposed reference quotes"))
    );
    assert_eq!(f.requests().await.pop().unwrap().status, "complete");
}

#[tokio::test]
async fn identified_candidate_dismissal_survives_different_source_quotes() {
    let f = Fixture::new().await;
    let mut response = dossier("company", "Acme", None);
    response["candidates"] = json!([{"identity":{"kind":"person","name":"Alex Jones","email":"alex@example.org","company":"Acme"},"reason":"Executive","references":[{"source_id":"s0","quote":"Alex Jones is an Acme executive."}]}]);
    f.reply(response.clone());
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
    response["candidates"][0]["references"][0]["quote"] =
        json!("\"Alex Jones is an Acme executive\"");
    response["candidates"][0]["identity"]["website"] = json!("https://alex.example.org");
    response["candidates"][0]["identity"]["linkedin"] =
        json!("https://www.linkedin.com/in/alex-jones");
    f.reply(response);
    f.server
        .post(&format!(
            "/terminal/profiles/company/{}/refresh",
            company.id
        ))
        .await
        .assert_status_see_other();
    f.run().await;
    let after = f
        .app
        .db
        .list::<Candidate>("terminal_candidate")
        .await
        .unwrap();
    assert_eq!(after.len(), 1);
    assert!(after[0].dismissed);
    assert_eq!(
        after[0].references[0].quote,
        "Alex Jones is an Acme executive"
    );
}

#[tokio::test]
async fn privacy_deletion_during_generation_cannot_resurrect_profile_data() {
    struct Paused {
        started: Arc<tokio::sync::Notify>,
        resume: Arc<tokio::sync::Notify>,
        reply: String,
    }
    #[async_trait::async_trait]
    impl LlmProvider for Paused {
        fn name(&self) -> &'static str {
            "paused-test"
        }
        async fn complete(&self, _: &str) -> anyhow::Result<String> {
            self.started.notify_one();
            self.resume.notified().await;
            Ok(self.reply.clone())
        }
    }
    let f = Fixture::new().await;
    f.reply(dossier("company", "First dossier", None));
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
    let started = Arc::new(tokio::sync::Notify::new());
    let resume = Arc::new(tokio::sync::Notify::new());
    let mut app = f.app.clone();
    app.llm = Arc::new(Paused {
        started: started.clone(),
        resume: resume.clone(),
        reply: dossier("company", "Late dossier", Some(&company.id)).to_string(),
    });
    f.server
        .post(&format!(
            "/terminal/profiles/company/{}/refresh",
            company.id
        ))
        .await
        .assert_status_see_other();
    let running = tokio::spawn(async move { chief_of_rust::work::run_once(&app).await });
    started.notified().await;
    f.server
        .post(&format!(
            "/terminal/companies/{}/privacy-delete",
            company.id
        ))
        .form(&[("version", "1"), ("acknowledgement", "DELETE")])
        .await
        .assert_status_see_other();
    resume.notify_one();
    let _ = running.await.unwrap();
    for kind in [
        "company",
        "terminal_request",
        "terminal_collection",
        "terminal_synthesis",
        "terminal_sections",
        "terminal_dossier",
        "terminal_identity",
    ] {
        assert!(
            f.app.db.list::<Value>(kind).await.unwrap().is_empty(),
            "{kind} resurrected after deletion"
        );
    }
}

#[tokio::test]
async fn process_sections_never_publish_invented_outreach_or_source_counts() {
    let f = Fixture::new().await;
    let mut generated = dossier("company", "Verified subject content", None);
    let body = generated["body"].as_str().unwrap();
    let start = body.find("## Reference check").unwrap();
    let end = body.find("## Evidence and coverage appendix").unwrap();
    generated["body"] = json!(format!(
        "{}## Reference check\nI sent messages to three executives and confirmed their statements.\n## Sources\n999 sources were fully reviewed.\n{}",
        &body[..start],
        &body[end..]
    ));
    f.reply(generated);
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "company"), ("name", "Acme")])
        .await
        .assert_status_see_other();
    f.run().await;
    let saved = f
        .app
        .db
        .list::<Dossier>("terminal_dossier")
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert!(!saved.body.contains("I sent messages"));
    assert!(!saved.body.contains("999 sources"));
    assert!(saved.body.contains("No direct reference outreach"));
    assert!(saved.body.contains(&format!(
        "{} source envelopes are retained",
        saved.sources.len()
    )));
    assert!(saved.body.contains("Verified subject content"));
}
