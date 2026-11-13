use chief_of_rust::{Installation, people};

#[tokio::test]
async fn person_without_meetings_has_a_workspace_and_a_read_only_context() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = chief_of_rust::Config::for_workspace(dir.path().into());
    config.people_terminal = true;
    let app = Installation::for_config(config).unwrap().app();
    let server = axum_test::TestServer::new(people::router().with_state(app));
    let created = server
        .post("/terminal/people")
        .form(&[("name", "Avery Fixture"), ("company", "North Labs")])
        .await;
    created.assert_status_see_other();
    let profile = created.header("location").to_str().unwrap().to_owned();
    let page = server.get(&profile).await;
    page.assert_text_contains("No dossier yet");
    page.assert_text_contains("Last documented affiliation");
    page.assert_text_contains("Timeline");
    let context = server.get(&format!("{profile}/context")).await;
    context.assert_status_ok();
    let body: serde_json::Value = context.json();
    assert_eq!(body["name"], "Avery Fixture");
    assert_eq!(body["claims"], serde_json::json!([]));
    assert!(body.get("meeting_id").is_none());
    server
        .post(&format!("{profile}/context"))
        .await
        .assert_status(axum::http::StatusCode::METHOD_NOT_ALLOWED);
}

use chief_of_rust::{App, work};
use serde_json::{Value, json};

fn setup() -> (tempfile::TempDir, App, axum_test::TestServer) {
    let dir = tempfile::tempdir().unwrap();
    let mut config = chief_of_rust::Config::for_workspace(dir.path().into());
    config.people_terminal = true;
    let app = Installation::for_config(config).unwrap().app();
    let server = axum_test::TestServer::new(
        people::router()
            .merge(chief_of_rust::terminal::router())
            .with_state(app.clone()),
    );
    (dir, app, server)
}

async fn create(server: &axum_test::TestServer, name: &str, profile_url: &str) -> String {
    let response = server
        .post("/terminal/people")
        .form(&[("name", name), ("profile_url", profile_url)])
        .await;
    response.assert_status_see_other();
    response.header("location").to_str().unwrap().to_owned()
}
fn id(path: &str) -> &str {
    path.rsplit('/').next().unwrap()
}

#[tokio::test]
async fn namesakes_remain_separate_until_a_reviewed_merge_and_can_be_split() {
    let (_dir, _, server) = setup();
    let a = create(&server, "Sam Fixture", "https://example.com/sam").await;
    let b = create(&server, "Sam Fixture", "https://example.com/sam").await;
    assert_ne!(a, b);
    let unrelated = create(&server, "Sam Fixture", "https://example.com/another-sam").await;
    let review = format!("{a}/identity");
    server
        .post(&review)
        .form(&[
            ("duplicate", id(&unrelated)),
            ("version", "1"),
            ("action", "merge"),
            ("reason", "profile"),
        ])
        .await
        .assert_status(axum::http::StatusCode::CONFLICT);
    server
        .post(&review)
        .form(&[
            ("duplicate", id(&b)),
            ("version", "1"),
            ("action", "merge"),
            ("reason", "profile"),
        ])
        .await
        .assert_status_see_other();
    server
        .get(&format!("{b}/context"))
        .await
        .assert_status_not_found();
    server
        .get(&b)
        .await
        .assert_text_contains("Open canonical person");
    server
        .post(&review)
        .form(&[
            ("duplicate", id(&b)),
            ("version", "2"),
            ("action", "split"),
            ("reason", "unclear"),
        ])
        .await
        .assert_status_see_other();
    server.get(&format!("{b}/context")).await.assert_status_ok();
    let history = server.get(&format!("{a}?view=history")).await;
    history.assert_text_contains("Reviewed matching official profile identifier");
    history.assert_text_contains("Distinguishing evidence is not settled");
}

#[tokio::test]
async fn person_admission_refuses_pasted_meeting_context_and_comparison_keeps_unknowns() {
    let (_dir, _, server) = setup();
    server
        .post("/terminal/people")
        .form(&[
            ("name", "Meeting contact"),
            (
                "notes",
                "In our private meeting Sam said he was joining Signal Lab",
            ),
        ])
        .await
        .assert_status_bad_request();
    let a = create(&server, "Sam Fixture", "").await;
    let b = create(&server, "Chris Fixture", "").await;
    for kind in ["transcript", "manual", "public"] {
        server
            .post(&format!("{a}/evidence"))
            .form(&[
                ("title", "Internal recap"),
                ("text", "Sam said he was joining Signal Lab"),
                ("kind", kind),
            ])
            .await
            .assert_status_bad_request();
    }
    let comparison = server
        .get(&format!(
            "/terminal/people/compare?person={}&second={}&fields=role",
            id(&a),
            id(&b)
        ))
        .await;
    comparison.assert_status_ok();
    comparison.assert_text_contains("Comparison matrix");
    comparison.assert_text_contains("Unknown");
    assert!(!comparison.text().contains("Signal Lab"));
    let search = server
        .get("/terminal/people/research?q=Signal+Lab&unknown=exclude")
        .await;
    search.assert_status_ok();
    search.assert_text_contains("No matches for this query");
}

#[tokio::test]
async fn retained_brief_can_finish_without_meetings_and_deletion_fences_pending_generation() {
    let (_dir, app, server) = setup();
    let person = create(&server, "Sam Fixture", "").await;
    let brief = || {
        server.post("/terminal/people/outputs").form(&[
            ("kind", "brief"),
            ("question", ""),
            ("person", id(&person)),
            ("second", ""),
            ("third", ""),
        ])
    };
    let response = brief().await;
    response.assert_status_see_other();
    let artifact = response.header("location").to_str().unwrap().to_owned();
    assert!(work::run_once(&app).await.unwrap());
    let markdown = server.get(&format!("{artifact}?format=markdown")).await;
    markdown.assert_status_ok();
    markdown.assert_text_contains("Unknown: this scope does not contain a supported answer");
    let response = brief().await;
    response.assert_status_see_other();
    let pending = response.header("location").to_str().unwrap().to_owned();
    server
        .post(&format!("{person}/privacy-delete"))
        .form(&[("acknowledgement", "DELETE"), ("version", "1")])
        .await
        .assert_status_see_other();
    server
        .get(&format!("{person}/context"))
        .await
        .assert_status_not_found();
    server.get(&artifact).await.assert_status_not_found();
    server.get(&pending).await.assert_status_not_found();
    assert!(!work::run_once(&app).await.unwrap());
}

async fn seed_snapshot(app: &App, person: &str, snapshot: &str, recorded: i64, facts: Vec<Value>) {
    app.db().put("people_terminal_snapshot",snapshot,json!({
        "id":snapshot,"person_id":id(person),"profile_version":1,"recorded":recorded,"facts":facts
    })).await.unwrap();
}
fn fact() -> Value {
    json!({
        "id":"role-foundry","predicate":"role","value":"Board director",
        "statement":"Sam Fixture served as a board director at Foundry Lab.",
        "effective":{"start":"2024-02-01","end":"2024-05-31"},
        "review":"unreviewed",
        "supports":[{
            "id":"anchor","version":"source-v1","source_id":"s0","url":"https://example.com/filing",
            "title":"Foundry Lab May filing","origin_family":"https://example.com/filing",
            "observed":"2024-09-01T12:00:00Z","published":"2024-06-01",
            "anchor":"Page 2, lines 3–6","text":"Sam Fixture served as a board director February through May.",
            "inspection":"Retained excerpt only","asserting_party":"Self-reported"
        }],
        "contradicts":[]
    })
}

#[tokio::test]
async fn retrospective_research_and_known_by_use_different_dates_and_revocation_wins() {
    let (_dir, app, server) = setup();
    let p = create(&server, "Sam Fixture", "").await;
    let recorded = chrono::DateTime::parse_from_rfc3339("2024-09-01T12:00:00Z")
        .unwrap()
        .timestamp_millis();
    seed_snapshot(&app, &p, "sept", recorded, vec![fact()]).await;
    let effective: Value = server
        .get(&format!("{p}/context?mode=effective&date=2024-04-15"))
        .await
        .json();
    assert_eq!(
        effective["claims"][0]["supports"][0]["version"],
        "source-v1"
    );
    let known: Value = server
        .get(&format!("{p}/context?mode=known&date=2024-07-01"))
        .await
        .json();
    assert_eq!(known["claims"], json!([]));
    let published: Value = server
        .get(&format!("{p}/context?mode=published&date=2024-07-01"))
        .await
        .json();
    assert_eq!(
        published["claims"][0]["supports"][0]["published"],
        "2024-06-01"
    );
    server
        .post(&format!("{p}/review"))
        .form(&[
            ("claim", "role-foundry"),
            ("snapshot", "sept"),
            ("version", "1"),
            ("decision", "accept"),
            ("reason", "checked"),
            ("view", "evidence"),
        ])
        .await
        .assert_status_see_other();
    let reviewed: Value = server
        .get(&format!("{p}/context?snapshot=sept"))
        .await
        .json();
    assert_eq!(reviewed["claims"][0]["review"], "accepted");
    assert_eq!(
        reviewed["claims"][0]["supports"][0]["asserting_party"],
        "Self-reported"
    );
    server
        .post(&format!("{p}/revoke"))
        .form(&[("source", "source-v1"), ("version", "1")])
        .await
        .assert_status_see_other();
    let after: Value = server
        .get(&format!("{p}/export?format=json&snapshot=sept"))
        .await
        .json();
    assert_eq!(after["claims"], json!([]));
    let historical = server
        .get(&format!("{p}?view=evidence&snapshot=sept"))
        .await;
    assert!(!historical.text().contains("Foundry Lab May filing"));
}

#[tokio::test]
async fn nominal_http_success_is_not_evidence_and_github_candidates_keep_partiality() {
    let provider = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::path("/news"))
        .respond_with(
            wiremock::ResponseTemplate::new(200).set_body_string("Please limit requests."),
        )
        .mount(&provider)
        .await;
    wiremock::Mock::given(wiremock::matchers::path("/code"))
        .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(json!({
            "incomplete_results":true,
            "items":[{"full_name":"project/fixture","html_url":"https://github.com/project/fixture"}]
        }))).mount(&provider).await;
    // This test binary is the sole caller that configures this loopback
    // base; remove it before making any assertions that could panic.
    unsafe {
        std::env::set_var("CHIEF_COLLECT_GDELT_BASE", provider.uri());
    }
    let news = chief_of_rust::collect::json_action(
        "gdelt_news",
        "GDELT DOC",
        &format!("{}/news", provider.uri()),
        None,
        Some("articles"),
        std::time::Duration::ZERO,
    )
    .await;
    let code = chief_of_rust::collect::json_action(
        "github_search",
        "GitHub",
        &format!("{}/code", provider.uri()),
        None,
        Some("items"),
        std::time::Duration::ZERO,
    )
    .await;
    unsafe {
        std::env::remove_var("CHIEF_COLLECT_GDELT_BASE");
    }
    let news = news.unwrap();
    assert_eq!(news.http_status, Some(200));
    assert_eq!(news.status, chief_of_rust::collect::CollectorStatus::Error);
    let code = code.unwrap();
    assert_eq!(
        code.status,
        chief_of_rust::collect::CollectorStatus::Truncated
    );
    assert_eq!(code.evidence["items"][0]["full_name"], "project/fixture");
}

struct FactExtractor;
#[async_trait::async_trait]
impl chief_of_rust::llm::LlmProvider for FactExtractor {
    fn name(&self) -> &'static str {
        "fixture"
    }
    async fn complete(&self, prompt: &str) -> anyhow::Result<String> {
        anyhow::ensure!(
            prompt.contains("PEOPLE_TERMINAL_FACTS") && prompt.contains("Foundry Lab bulletin"),
            "expected retained source"
        );
        anyhow::ensure!(
            !prompt.contains("privileged instruction"),
            "instruction reached extraction"
        );
        Ok(json!({"claims":[
            {"predicate":"founding","value":"Foundry Lab","statement":"Sam Fixture founded Foundry Lab in 2010.","effective":{"start":"2010"},"source_id":"0:fetch_url","quote":"Sam Fixture founded Foundry Lab in 2010."},
            {"predicate":"role","value":"Chief Executive","statement":"Sam Fixture became Chief Executive in 2010.","effective":{"start":"2010"},"source_id":"0:fetch_url","quote":"Sam Fixture founded Foundry Lab in 2010."},
            {"predicate":"role","value":"Fabricated","statement":"A sentence outside the inspected extent.","source_id":"0:fetch_url","quote":"Outside the inspected extent."}
        ]}).to_string())
    }
}

#[derive(Default)]
struct ChainedJudge(std::sync::Mutex<Vec<&'static str>>);
#[async_trait::async_trait]
impl chief_of_rust::judgments::Judge for ChainedJudge {
    async fn evaluate(
        &self,
        state: Value,
        questions: Value,
    ) -> anyhow::Result<chief_of_rust::judgments::Evaluation> {
        let mut answers = std::collections::BTreeMap::new();
        let q = questions.as_object().unwrap();
        let stage = if q.contains_key("origin_0") {
            "screen"
        } else if q.contains_key("identity_0") {
            "attribution"
        } else {
            "support"
        };
        self.0.lock().unwrap().push(stage);
        for id in q.keys() {
            let value = if id.starts_with("origin_") || id.starts_with("injection_") {
                json!({"type":"noul","noul":0.02})
            } else if id.starts_with("identity_") || id.starts_with("self_") {
                anyhow::ensure!(
                    state["subject"]["name"] == "Sam Fixture",
                    "missing subject distinguisher"
                );
                json!({"type":"noul","noul":0.97})
            } else {
                let yes = state["claim"]["predicate"] == "founding";
                json!({"type":"choice","choice":if yes{"supports"}else{"silent"},"probabilities":{"supports":if yes{1.0}else{0.0},"silent":if yes{0.0}else{1.0},"contradicts":0.0},"confidence":1.0})
            };
            answers.insert(id.clone(), value);
        }
        Ok(chief_of_rust::judgments::Evaluation {
            model: "fixture".into(),
            answers,
            warnings: Vec::new(),
            usage: Default::default(),
        })
    }
}

#[tokio::test]
async fn inspection_chains_origin_attribution_and_support_then_anchors_only_the_supported_predicate()
 {
    let (_dir, app, _server) = setup();
    let endpoint = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::path("/foundry"))
        .respond_with(wiremock::ResponseTemplate::new(200).set_body_raw(
            "<html><head><title>Foundry Lab bulletin</title><meta property='article:published_time' content='2024-06-01'></head><main>Sam Fixture founded Foundry Lab in 2010.</main></html>","text/html"
        )).mount(&endpoint).await;
    let mut config = app.cfg().clone();
    config.llm_provider = "opencode".into();
    let judge = std::sync::Arc::new(ChainedJudge::default());
    let app = app
        .with_cfg(config)
        .with_llm(std::sync::Arc::new(FactExtractor))
        .with_judge(judge.clone());
    let server = axum_test::TestServer::new(people::router().with_state(app.clone()));
    let profile = create(&server, "Sam Fixture", "").await;
    let url = format!("{}/foundry", endpoint.uri());
    // The fixtures in this binary use separate keys for their loopback bases.
    unsafe {
        std::env::set_var("CHIEF_COLLECT_FOUNDRY_BASE", endpoint.uri());
    }
    let result = server
        .post(&format!("{profile}/collection"))
        .form(&[("action", "inspect"), ("target", &url), ("version", "1")])
        .await;
    let ran = work::run_once(&app).await;
    unsafe {
        std::env::remove_var("CHIEF_COLLECT_FOUNDRY_BASE");
    }
    result.assert_status_see_other();
    assert!(ran.unwrap());
    let run = work::list(app.db()).await.unwrap().pop().unwrap();
    assert_eq!(run.status, "done", "{:?}", run.error);
    assert_eq!(
        *judge.0.lock().unwrap(),
        ["screen", "attribution", "support", "support"]
    );
    let context: Value = server.get(&format!("{profile}/context")).await.json();
    let claims = context["claims"].as_array().unwrap();
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0]["predicate"], "founding");
    assert_eq!(claims[0]["effective"]["start"], "2010");
    assert_eq!(claims[0]["effective"]["end"], Value::Null);
    let evidence = &claims[0]["supports"][0];
    assert_eq!(evidence["title"], "Foundry Lab bulletin");
    assert_eq!(evidence["published"], "2024-06-01");
    assert_eq!(evidence["text"], "Sam Fixture founded Foundry Lab in 2010.");
}

#[tokio::test]
async fn watchlist_and_comparison_persist_the_selected_scope() {
    let (_dir, app, server) = setup();
    let a = create(&server, "Sam Fixture", "").await;
    let b = create(&server, "Chris Fixture", "").await;
    seed_snapshot(&app, &a, "first", 1000, vec![fact()]).await;
    let response = server
        .post("/terminal/people/watchlists")
        .form(&[
            ("name", "Research list"),
            ("kind", "static"),
            ("person", id(&a)),
            ("second", id(&b)),
        ])
        .await;
    response.assert_status_see_other();
    let watch = response.header("location").to_str().unwrap().to_owned();
    server
        .post(&watch)
        .form(&[("action", "review"), ("version", "1")])
        .await
        .assert_status_see_other();
    let saved: Value = app
        .db()
        .get("people_terminal_watch", id(&watch))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved["cadence"], 7);
    assert_eq!(saved["paused"], true);
    assert_eq!(saved["reviewed"][id(&a)], "first");
    assert_eq!(saved["previous_members"].as_array().unwrap().len(), 2);
    assert!(saved["reviewed_at"].is_number());
    let selection = json!({"person":id(&a),"second":id(&b),"fields":"role"}).to_string();
    let response = server
        .post("/terminal/people/compare")
        .form(&[("selection", selection)])
        .await;
    response.assert_status_see_other();
    let comparison = response.header("location").to_str().unwrap().to_owned();
    let saved: Value = app
        .db()
        .get("people_terminal_comparison", id(&comparison))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        saved["snapshots"],
        json!([[id(&a), "first"], [id(&b), null]])
    );
    seed_snapshot(&app, &a, "second", 2000, vec![]).await;
    server
        .get(&comparison)
        .await
        .assert_text_contains("Sam Fixture served as a board director");
}
