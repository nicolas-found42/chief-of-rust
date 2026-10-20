//! Bloomberg Terminal HTTP seam: landing, company lifecycle, cutover.
use chief_of_rust::{App, db::Db, llm::LlmProvider, terminal::Company};
use std::sync::Arc;

mod common;
use common::RecordingClock;

/// Explicit Council judgment fixture for the mock-posture Terminal Runs:
/// answers every question it is asked with a valid, coherent answer. Never
/// evidence of the live model's accuracy.
struct CouncilJudge;
#[async_trait::async_trait]
impl chief_of_rust::judgments::Judge for CouncilJudge {
    async fn evaluate(
        &self,
        state: serde_json::Value,
        questions: serde_json::Value,
    ) -> anyhow::Result<chief_of_rust::judgments::Evaluation> {
        // Council questions (probability/concern/citation) use criteria the
        // common fixture does not know; answer them by picking the first
        // criterion, like the Council test fixture does.
        let mut answers = std::collections::BTreeMap::new();
        for (id, q) in questions.as_object().unwrap() {
            let answer = match q["type"].as_str().unwrap() {
                "noul" => {
                    serde_json::json!({"type":"noul","noul":if id=="injection" || id.starts_with("counter_") || id.starts_with("answered_") || id.starts_with("fulfilled_") {0.0} else {1.0}})
                }
                "choice" => {
                    let criteria = q["criteria"].as_object().unwrap();
                    let selected = if id.starts_with("kind_") {
                        let n = id.trim_start_matches("kind_").parse::<usize>().unwrap();
                        state["items"][n]["kind"].as_str().unwrap_or("unclear")
                    } else if id.starts_with("support_") {
                        "supports"
                    } else {
                        // Council concern/citation questions: pick the
                        // first criterion so the distribution is coherent.
                        criteria.keys().next().unwrap()
                    };
                    let p: serde_json::Map<String, serde_json::Value> = criteria
                        .keys()
                        .map(|k| {
                            (
                                k.clone(),
                                serde_json::json!(if k == selected { 1.0 } else { 0.0 }),
                            )
                        })
                        .collect();
                    serde_json::json!({"type":"choice","choice":selected,"probabilities":p,"confidence":1.0})
                }
                "score" => {
                    let level = if id == "quality" {
                        2
                    } else if id == "tension" {
                        0
                    } else {
                        1
                    };
                    let p: serde_json::Map<String, serde_json::Value> = q["criteria"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .enumerate()
                        .map(|(i, _)| {
                            (
                                i.to_string(),
                                serde_json::json!(if i == level { 1.0 } else { 0.0 }),
                            )
                        })
                        .collect();
                    serde_json::json!({"type":"score","score":level,"probabilities":p,"confidence":1.0})
                }
                _ => panic!("unknown fixture question"),
            };
            answers.insert(id.clone(), answer);
        }
        Ok(chief_of_rust::judgments::Evaluation {
            model: "explicit-test-fixture".into(),
            warnings: Vec::new(),
            answers,
            usage: chief_of_rust::judgments::Usage::default(),
        })
    }
}

/// Collector provider bases resolve through process-global env, so the tests
/// that repoint providers at wiremock serialize on this lock. Without it their
/// `set_var`/`remove_var` windows race and collectors route to the wrong mock
/// server. The guard spans `.await`, so this is an async lock.
static COLLECTOR_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
async fn gdelt_rate_limits_retry_once_and_respect_a_long_provider_delay() {
    let _guard = COLLECTOR_ENV_LOCK.lock().await;
    for (delay, recovers, expected_calls) in [("0", true, 2), ("0", false, 2), ("60", false, 1)] {
        let provider = wiremock::MockServer::start().await;
        let clock = RecordingClock::new();
        let pacer = clock.pacer();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = calls.clone();
        wiremock::Mock::given(wiremock::matchers::path("/api/v2/doc/doc"))
            .and(wiremock::matchers::query_param("query", "\"Matthew Prince\""))
            .respond_with(move |_: &wiremock::Request| {
                let call = seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if call > 0 && recovers {
                    wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({"articles":[{"url":"https://example.com/news","title":"Fixture article"}]}))
                } else {
                    wiremock::ResponseTemplate::new(429).insert_header("Retry-After", delay).set_body_string("rate limited")
                }
            }).expect(expected_calls).mount(&provider).await;
        unsafe { std::env::set_var("CHIEF_COLLECT_GDELT_BASE", provider.uri()) };
        let result = chief_of_rust::collect::run_collector_with(
            &pacer,
            "gdelt_news",
            &serde_json::json!({"query":"\"Matthew Prince\"","limit":10,"timespan":"30d"}),
            None,
        )
        .await;
        unsafe { std::env::remove_var("CHIEF_COLLECT_GDELT_BASE") };
        let envelope = result.unwrap();
        assert_eq!(
            calls.load(std::sync::atomic::Ordering::SeqCst),
            expected_calls as usize
        );
        assert_eq!(
            envelope.status,
            if recovers {
                chief_of_rust::collect::CollectorStatus::Ok
            } else {
                chief_of_rust::collect::CollectorStatus::Blocked
            }
        );
        if expected_calls == 1 {
            assert!(
                envelope
                    .notes
                    .iter()
                    .any(|note| note.contains("exceeds the bounded"))
            );
            // A 60 s Retry-After exceeds the bounded retry window: it must be
            // refused with a note and must not sleep. The first request's
            // pacing wait is zero (no prior request), which `pace` skips.
            assert!(
                clock.waits().is_empty(),
                "refused retry must not sleep: {:?}",
                clock.waits()
            );
        } else {
            // A zero Retry-After is still an explicit retry instruction, and
            // the retried request must wait the full 5 s GDELT interval.
            assert_eq!(
                clock.waits(),
                vec![std::time::Duration::ZERO, std::time::Duration::from_secs(5),]
            );
        }
    }
}
#[tokio::test]
async fn sec_ticker_lookup_retains_matching_records_before_excerpt_slicing() {
    let pacer = RecordingClock::new().pacer();
    let _guard = COLLECTOR_ENV_LOCK.lock().await;
    let provider = wiremock::MockServer::start().await;
    let mut records = serde_json::Map::new();
    for i in 0..600 {
        records.insert(i.to_string(),serde_json::json!({"title":format!("Unrelated company {i}"),"cik_str":i+1,"ticker":"OTHER"}));
    }
    records.insert(
        "9999".into(),
        serde_json::json!({"title":"CLOUDFLARE, INC.","cik_str":1477333,"ticker":"NET"}),
    );
    wiremock::Mock::given(wiremock::matchers::path("/files/company_tickers.json"))
        .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(&records))
        .mount(&provider)
        .await;
    unsafe { std::env::set_var("CHIEF_COLLECT_SEC_WWW_BASE", provider.uri()) };
    let matched = chief_of_rust::collect::run_collector_with(
        &pacer,
        "sec_tickers",
        &serde_json::json!({"query":"Cloudflare"}),
        Some("research@example.org"),
    )
    .await;
    let unmatched = chief_of_rust::collect::run_collector_with(
        &pacer,
        "sec_tickers",
        &serde_json::json!({"query":"Cloudflare India"}),
        Some("research@example.org"),
    )
    .await;
    unsafe { std::env::remove_var("CHIEF_COLLECT_SEC_WWW_BASE") };
    let matched = matched.unwrap();
    assert_eq!(matched.result_count, Some(1));
    assert_eq!(matched.evidence["9999"]["cik_str"], 1477333);
    assert_eq!(matched.evidence.as_object().unwrap().len(), 1);
    assert_eq!(
        matched.content_sha256,
        chief_of_rust::research::content_hash(&serde_json::to_vec(&records).unwrap())
    );
    assert!(
        matched
            .notes
            .iter()
            .any(|note| note.contains("unrelated rows omitted"))
    );
    let unmatched = unmatched.unwrap();
    assert_eq!(
        unmatched.status,
        chief_of_rust::collect::CollectorStatus::Empty
    );
    assert_eq!(unmatched.result_count, Some(0));
}
#[tokio::test]
async fn sec_financial_priority_precedes_alphabetic_history_without_changing_default_pagination() {
    let pacer = RecordingClock::new().pacer();
    let _guard = COLLECTOR_ENV_LOCK.lock().await;
    let provider = wiremock::MockServer::start().await;
    let data = serde_json::json!({"cik":1517413,"entityName":"Fastly, Inc.","facts":{"dei":{"EntityCommonStockSharesOutstanding":{"units":{}}},"us-gaap":{"AccountsPayableCurrent":{"units":{}},"RevenueFromContractWithCustomerExcludingAssessedTax":{"units":{"USD":[{"end":"2025-12-31","val":624000000,"form":"10-K","filed":"2026-02-01"}]}}}}});
    wiremock::Mock::given(wiremock::matchers::path(
        "/api/xbrl/companyfacts/CIK0001517413.json",
    ))
    .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(&data))
    .mount(&provider)
    .await;
    unsafe { std::env::set_var("CHIEF_COLLECT_SEC_DATA_BASE", provider.uri()) };
    let regular = chief_of_rust::collect::run_collector_with(
        &pacer,
        "sec_companyfacts",
        &serde_json::json!({"cik":"1517413","limit":1}),
        Some("research@example.org"),
    )
    .await;
    let priority = chief_of_rust::collect::run_collector_with(
        &pacer,
        "sec_companyfacts",
        &serde_json::json!({"cik":"1517413","limit":1,"prioritize_financials":true}),
        Some("research@example.org"),
    )
    .await;
    unsafe { std::env::remove_var("CHIEF_COLLECT_SEC_DATA_BASE") };
    let regular = regular.unwrap();
    let priority = priority.unwrap();
    assert!(
        regular.evidence["facts"]["dei"]
            .get("EntityCommonStockSharesOutstanding")
            .is_some()
    );
    assert_eq!(
        priority.evidence["facts"]["us-gaap"]["RevenueFromContractWithCustomerExcludingAssessedTax"],
        data["facts"]["us-gaap"]["RevenueFromContractWithCustomerExcludingAssessedTax"]
    );
    assert_eq!(regular.next_cursor.as_deref(), Some("1"));
    assert_eq!(priority.next_cursor.as_deref(), Some("1"));
    assert_eq!(priority.content_sha256, regular.content_sha256);
}

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
    chief_of_rust::Installation::for_workspace(dir.path().to_path_buf())
        .app()
        .with_llm(Arc::new(Reply))
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
        .db()
        .list::<Company>("company")
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(c.domain, "acme.example.com");
    assert_eq!(c.version, 1);
    // Saving identity starts no Run.
    assert!(
        chief_of_rust::work::list(app.db())
            .await
            .unwrap()
            .is_empty()
    );
    server
        .get(&format!("/terminal/companies/{}", c.id))
        .await
        .assert_status_ok()
        .assert_text_contains("Acme Corp")
        .assert_text_contains("Refresh dossier");
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
    let current: Company = app.db().get("company", &c.id).await.unwrap().unwrap();
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
    assert!(
        app.db()
            .list::<Company>("company")
            .await
            .unwrap()
            .is_empty()
    );
}
struct BriefFixture;
#[async_trait::async_trait]
impl chief_of_rust::llm::LlmProvider for BriefFixture {
    fn name(&self) -> &'static str {
        "test"
    }
    async fn complete(&self, _: &str) -> anyhow::Result<String> {
        Ok(serde_json::json!({
            "brief": "Acme makes widgets. Evidence is limited to registry and news excerpts.",
            "claims": [
                {"id": "c1", "text": "Acme makes widgets", "source_ids": ["0:gleif_search"], "status": "supported"},
                {"id": "c2", "text": "Acme plans a moon base", "source_ids": ["0:gleif_search"], "status": "supported"}
            ]
        })
        .to_string())
    }
}

/// End-to-end company Run through wiremock collectors: admission persists
/// context, the worker executes applicable collectors, unsupported clauses
/// are demoted, and the brief renders with ledgers and frontier.
#[tokio::test]
async fn company_full_research_runs_collectors_and_corrects_brief() {
    let _env = COLLECTOR_ENV_LOCK.lock().await;
    let providers = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .respond_with(
            wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{"attributes": {"name": "Acme makes widgets"}}],
                "meta": {"pagination": {"total": 1}}
            })),
        )
        .mount(&providers)
        .await;
    for key in [
        "CHIEF_COLLECT_SEC_WWW_BASE",
        "CHIEF_COLLECT_SEC_DATA_BASE",
        "CHIEF_COLLECT_GLEIF_BASE",
        "CHIEF_COLLECT_GDELT_BASE",
        "CHIEF_COLLECT_GITHUB_BASE",
        "CHIEF_COLLECT_HN_BASE",
        "CHIEF_COLLECT_CROSSREF_BASE",
        "CHIEF_COLLECT_ROR_BASE",
        "CHIEF_COLLECT_USASPENDING_BASE",
        "CHIEF_COLLECT_WAYBACK_BASE",
    ] {
        unsafe { std::env::set_var(key, providers.uri()) };
    }
    let dir = tempfile::tempdir().unwrap();
    let cfg = chief_of_rust::Config::for_workspace(dir.path().to_path_buf());
    let clock = RecordingClock::new();
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        Db::open(&cfg.db_path()).unwrap(),
        std::sync::Arc::new(BriefFixture),
        std::sync::Arc::new(CouncilJudge),
        clock.pacer(),
    )
    .app();
    let server = server(&app);
    // No contact configured: contact-gated collectors report blocked,
    // everything else proceeds.
    server
        .post("/terminal/companies")
        .form(&[("name", "Acme Corp")])
        .await
        .assert_status_see_other();
    let company = app
        .db()
        .list::<Company>("company")
        .await
        .unwrap()
        .pop()
        .unwrap();
    server
        .post(&format!("/terminal/companies/{}/research", company.id))
        .form(&[("question", "What does Acme do?")])
        .await
        .assert_status_see_other();
    assert!(chief_of_rust::work::run_once(&app).await.unwrap());
    let brief = app
        .db()
        .list::<chief_of_rust::terminal::subject::Brief>(
            chief_of_rust::terminal::subject::BRIEF_KIND,
        )
        .await
        .unwrap()
        .pop()
        .unwrap();
    // Exact-quote demotion: c2's clause appears in no retained excerpt.
    let statuses: Vec<(String, String)> = brief
        .claims
        .iter()
        .map(|c| (c.id.clone(), c.status.as_str().into()))
        .collect();
    assert!(
        statuses
            .iter()
            .any(|(id, s)| id == "c1" && s == "supported")
    );
    assert!(
        statuses
            .iter()
            .any(|(id, s)| id == "c2" && s == "unresolved")
    );
    // Every collector action is accounted for in coverage.
    assert_eq!(brief.coverage.len(), 26);
    assert!(
        brief.coverage.iter().any(|c| c.family == "sec_tickers"
            && c.state == chief_of_rust::research::CoverageState::Blocked)
    );
    // Frontier holds the blocked contact work plus any cursors.
    assert!(
        brief
            .frontier
            .iter()
            .any(|f| f.next_action.contains("sec_tickers"))
    );
    server
        .get(&format!("/terminal/companies/{}", company.id))
        .await
        .assert_status_ok()
        .assert_text_contains("Acme makes widgets")
        .assert_text_contains("Unfinished work");
    for key in [
        "CHIEF_COLLECT_SEC_WWW_BASE",
        "CHIEF_COLLECT_SEC_DATA_BASE",
        "CHIEF_COLLECT_GLEIF_BASE",
        "CHIEF_COLLECT_GDELT_BASE",
        "CHIEF_COLLECT_GITHUB_BASE",
        "CHIEF_COLLECT_HN_BASE",
        "CHIEF_COLLECT_CROSSREF_BASE",
        "CHIEF_COLLECT_ROR_BASE",
        "CHIEF_COLLECT_USASPENDING_BASE",
        "CHIEF_COLLECT_WAYBACK_BASE",
    ] {
        unsafe { std::env::remove_var(key) };
    }
}
/// Diagnostics record test: a company Run leaves a timeline, measured
/// totals and transport timing in the durable records — not only in the
/// rendered brief. Reads the records themselves, per the coding standard.
#[tokio::test]
async fn company_run_leaves_timeline_usage_and_transport_timing() {
    let _env = COLLECTOR_ENV_LOCK.lock().await;
    let providers = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .respond_with(
            wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{"attributes": {"name": "Acme makes widgets"}}],
                "meta": {"pagination": {"total": 1}}
            })),
        )
        .mount(&providers)
        .await;
    for key in [
        "CHIEF_COLLECT_GLEIF_BASE",
        "CHIEF_COLLECT_GDELT_BASE",
        "CHIEF_COLLECT_GITHUB_BASE",
    ] {
        unsafe { std::env::set_var(key, providers.uri()) };
    }
    let dir = tempfile::tempdir().unwrap();
    let cfg = chief_of_rust::Config::for_workspace(dir.path().to_path_buf());
    let clock = RecordingClock::new();
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        Db::open(&cfg.db_path()).unwrap(),
        std::sync::Arc::new(BriefFixture),
        std::sync::Arc::new(CouncilJudge),
        clock.pacer(),
    )
    .app();
    let server = server(&app);
    server
        .post("/terminal/companies")
        .form(&[("name", "Acme Corp")])
        .await
        .assert_status_see_other();
    let company = app
        .db()
        .list::<Company>("company")
        .await
        .unwrap()
        .pop()
        .unwrap();
    server
        .post(&format!("/terminal/companies/{}/research", company.id))
        .form(&[("question", "What does Acme do?")])
        .await
        .assert_status_see_other();
    let job = chief_of_rust::work::list(app.db())
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert!(chief_of_rust::work::run_once(&app).await.unwrap());
    // Timeline: admitted, claimed, one row per executed collector, done.
    let events = chief_of_rust::work::events(app.db(), &job.id)
        .await
        .unwrap();
    let stages: Vec<&str> = events.iter().map(|e| e.stage.as_str()).collect();
    assert!(stages.contains(&"admitted"), "stages: {stages:?}");
    assert!(stages.contains(&"claimed"), "stages: {stages:?}");
    assert!(stages.contains(&"done"), "stages: {stages:?}");
    let collector_rows: Vec<_> = events.iter().filter(|e| e.stage == "collector").collect();
    assert!(
        !collector_rows.is_empty(),
        "no collector rows in {stages:?}"
    );
    // Run result carries the measured totals the scope decorators saw.
    let finished = chief_of_rust::work::find(app.db(), &job.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(finished.status, "done");
    let usage = finished
        .result
        .as_ref()
        .and_then(|r| r.get("usage"))
        .expect("result has no usage totals");
    assert!(
        usage.get("llm_calls").and_then(|v| v.as_u64()).unwrap_or(0) >= 1,
        "usage: {usage}"
    );
    // The brief carries the same totals, and at least one source records
    // measured transport time beside its HTTP status.
    let brief = app
        .db()
        .list::<chief_of_rust::terminal::subject::Brief>(
            chief_of_rust::terminal::subject::BRIEF_KIND,
        )
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert!(brief.usage.is_some(), "brief has no usage totals");
    assert!(
        brief
            .sources
            .iter()
            .filter_map(|s| s.transport_status.as_deref())
            .any(|t| t.contains("in ") && t.contains("ms")),
        "no measured transport time in {:?}",
        brief
            .sources
            .iter()
            .map(|s| s.transport_status.clone())
            .collect::<Vec<_>>()
    );
    for key in [
        "CHIEF_COLLECT_GLEIF_BASE",
        "CHIEF_COLLECT_GDELT_BASE",
        "CHIEF_COLLECT_GITHUB_BASE",
    ] {
        unsafe { std::env::remove_var(key) };
    }
}
struct ComparisonFixture;
#[async_trait::async_trait]
impl LlmProvider for ComparisonFixture {
    fn name(&self) -> &'static str {
        "test"
    }
    async fn complete(&self, _: &str) -> anyhow::Result<String> {
        Ok(serde_json::json!({
            "brief": "Acme suits cost-conscious buyers; Beta suits premium buyers.",
            "scorecards": {"first": [3, 2, "U"], "second": [1, 1, 1]},
            "scorecard_reasons": {"first": ["Strong retained evidence", "Stated need", "No offering evidence"], "second": ["Limited evidence", "Limited need", "Limited fit"]}
        })
        .to_string())
    }
}

/// Explicit two-company comparison: direction preserved, U stays unknown
/// with a possible range, and saving either company regenerates from saved
/// snapshots without external collection.
#[tokio::test]
async fn comparison_request_scores_direction_and_regenerates_on_save() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = chief_of_rust::Config::for_workspace(dir.path().to_path_buf());
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        Db::open(&cfg.db_path()).unwrap(),
        Arc::new(ComparisonFixture),
        std::sync::Arc::new(CouncilJudge),
        std::sync::Arc::new(chief_of_rust::collect::Pacer::system()),
    )
    .app();
    let server = server(&app);
    for name in ["Acme", "Beta"] {
        server
            .post("/terminal/companies")
            .form(&[("name", name)])
            .await
            .assert_status_see_other();
    }
    let mut companies = app.db().list::<Company>("company").await.unwrap();
    companies.sort_by(|a, b| a.name.cmp(&b.name));
    let (acme, beta) = (companies[0].clone(), companies[1].clone());
    // Same-company and unknown-workflow requests are rejected.
    server
        .post("/terminal/comparisons")
        .form(&[
            ("first_id", acme.id.as_str()),
            ("second_id", acme.id.as_str()),
            ("workflows", "customer-fit"),
        ])
        .await
        .assert_status_bad_request();
    server
        .post("/terminal/comparisons")
        .form(&[
            ("first_id", acme.id.as_str()),
            ("second_id", beta.id.as_str()),
            ("workflows", "customer-fit"),
            ("offering", "widgets for cost-conscious buyers"),
        ])
        .await
        .assert_status_see_other();
    let comparison = app
        .db()
        .list::<chief_of_rust::terminal::comparison::Comparison>("comparison")
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(comparison.first_id, acme.id);
    assert_eq!(comparison.second_id, beta.id);
    assert!(chief_of_rust::work::run_once(&app).await.unwrap());
    let reports = app
        .db()
        .list::<chief_of_rust::terminal::comparison::ComparisonReport>("comparison_report")
        .await
        .unwrap();
    assert_eq!(reports.len(), 1);
    let report = &reports[0];
    assert!(!report.superseded);
    // U is unknown, not zero: subtotal 5 of rated 2, range 5..8 of 9.
    let first = &report.scorecards["first"];
    assert_eq!(first["known_subtotal"], 5);
    assert_eq!(first["rated_criteria"], 2);
    assert_eq!(first["possible_range"], serde_json::json!([5, 8]));
    assert_eq!(first["reasons"][0], "Strong retained evidence");
    let html = server
        .get(&format!("/terminal/comparisons/{}", comparison.id))
        .await
        .text();
    assert!(html.contains("Inputs: Acme (v1) vs Beta (v1)"));
    assert!(html.contains("Strong retained evidence"));
    assert!(html.contains("possible range 5–8 of 9"));
    assert!(!html.contains(&format!(">{}</a>", report.run_id)));
    assert!(!html.contains("<pre>"));
    // Saving either company regenerates from snapshots; the old report is
    // marked superseded and the new one matches the new versions.
    server
        .post(&format!("/terminal/companies/{}", beta.id))
        .form(&[("name", "Beta Corp"), ("version", "1")])
        .await
        .assert_status_see_other();
    assert!(chief_of_rust::work::run_once(&app).await.unwrap());
    let reports = app
        .db()
        .list::<chief_of_rust::terminal::comparison::ComparisonReport>("comparison_report")
        .await
        .unwrap();
    // Two reports can share a millisecond, so position is not identity; the
    // current report is the one bound to the version that produced it.
    assert_eq!(reports.len(), 2);
    let current = reports
        .iter()
        .find(|r| !r.superseded)
        .expect("current report");
    assert_eq!(current.second_version, 2);
    assert!(
        reports
            .iter()
            .any(|r| r.superseded && r.second_version == 1)
    );
    server
        .get(&format!("/terminal/comparisons/{}", comparison.id))
        .await
        .assert_status_ok()
        .assert_text_contains("Customer fit")
        .assert_text_contains("superseded by a newer save");
}
/// Company privacy deletion purges the company, its briefs, comparisons
/// touching it and their reports, plus terminal Run snapshots. The other
/// company and unrelated history survive.
#[tokio::test]
async fn company_privacy_delete_purges_briefs_comparisons_and_runs() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = chief_of_rust::Config::for_workspace(dir.path().to_path_buf());
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        Db::open(&cfg.db_path()).unwrap(),
        Arc::new(ComparisonFixture),
        std::sync::Arc::new(CouncilJudge),
        std::sync::Arc::new(chief_of_rust::collect::Pacer::system()),
    )
    .app();
    let server = server(&app);
    for name in ["Acme", "Beta"] {
        server
            .post("/terminal/companies")
            .form(&[("name", name)])
            .await
            .assert_status_see_other();
    }
    let mut companies = app.db().list::<Company>("company").await.unwrap();
    companies.sort_by(|a, b| a.name.cmp(&b.name));
    let (acme, beta) = (companies[0].clone(), companies[1].clone());
    server
        .post("/terminal/comparisons")
        .form(&[
            ("first_id", acme.id.as_str()),
            ("second_id", beta.id.as_str()),
            ("workflows", "customer-fit"),
        ])
        .await
        .assert_status_see_other();
    assert!(chief_of_rust::work::run_once(&app).await.unwrap());
    // Seed retained briefs with excerpts for Acme, in the unified kind and in
    // the legacy kind a pre-merge workspace holds: deletion must purge brief
    // records of every kind and their revision bodies, not just the company
    // row.
    let brief = chief_of_rust::terminal::subject::Brief {
        id: "brief-acme".into(),
        subject_kind: chief_of_rust::terminal::subject::SubjectKind::Company,
        subject_id: acme.id.clone(),
        subject_version: 1,
        question: "What does Acme do?".into(),
        brief: "Acme makes widgets.".into(),
        claims: Vec::new(),
        affiliation_context: Vec::new(),
        sources: Vec::new(),
        coverage: Vec::new(),
        frontier: Vec::new(),
        source_diagnostics: Vec::new(),
        ledger_check: chief_of_rust::research::LedgerCheck {
            valid: true,
            errors: Vec::new(),
            warnings: Vec::new(),
        },
        created_at: 1,
        run_id: "run-acme".into(),
        supersedes: None,
        unproductive_expansions: 0,
        saturated: false,
        context: None,
        usage: None,
    };
    app.db()
        .put(
            chief_of_rust::terminal::subject::BRIEF_KIND,
            "brief-acme",
            brief,
        )
        .await
        .unwrap();
    let legacy_brief = serde_json::json!({
        "id": "legacy-brief-acme",
        "company_id": acme.id,
        "company_version": 1,
        "question": "What did Acme do?",
        "brief": "Acme made widgets.",
        "claims": [],
        "sources": [],
        "coverage": [],
        "frontier": [],
        "ledger_check": {"valid": true, "errors": [], "warnings": []},
        "created_at": 1,
        "run_id": "run-legacy-acme",
    });
    app.db()
        .put("company_brief", "legacy-brief-acme", legacy_brief)
        .await
        .unwrap();
    assert_eq!(
        app.db()
            .list::<chief_of_rust::terminal::comparison::ComparisonReport>("comparison_report")
            .await
            .unwrap()
            .len(),
        1
    );
    // Wrong acknowledgement is rejected; nothing is purged.
    server
        .post(&format!("/terminal/companies/{}/privacy-delete", acme.id))
        .form(&[("version", "1"), ("acknowledgement", "delete")])
        .await
        .assert_status_bad_request();
    // Stale version is fenced.
    server
        .post(&format!("/terminal/companies/{}/privacy-delete", acme.id))
        .form(&[("version", "999"), ("acknowledgement", "DELETE")])
        .await
        .assert_status_conflict();
    server
        .post(&format!("/terminal/companies/{}/privacy-delete", acme.id))
        .form(&[("version", "1"), ("acknowledgement", "DELETE")])
        .await
        .assert_status_see_other();
    assert!(
        app.db()
            .get::<Company>("company", &acme.id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        app.db()
            .list::<chief_of_rust::terminal::comparison::Comparison>("comparison")
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        app.db()
            .list::<chief_of_rust::terminal::subject::Brief>(
                chief_of_rust::terminal::subject::BRIEF_KIND,
            )
            .await
            .unwrap()
            .is_empty()
    );
    // The legacy-kind brief is purged with the same power as the unified one.
    assert!(
        app.db()
            .list::<chief_of_rust::terminal::subject::Brief>("company_brief")
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        chief_of_rust::work::list(app.db())
            .await
            .unwrap()
            .is_empty()
    );
    // Beta survives with its identity intact.
    assert_eq!(
        app.db()
            .get::<Company>("company", &beta.id)
            .await
            .unwrap()
            .unwrap()
            .name,
        "Beta"
    );
}

/// A Run admitted against a stale company version fails fenced instead of
/// publishing output from an outdated identity snapshot.
#[tokio::test]
async fn stale_company_research_run_fails_fenced() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = chief_of_rust::Config::for_workspace(dir.path().to_path_buf());
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        Db::open(&cfg.db_path()).unwrap(),
        Arc::new(BriefFixture),
        std::sync::Arc::new(CouncilJudge),
        std::sync::Arc::new(chief_of_rust::collect::Pacer::system()),
    )
    .app();
    let server = server(&app);
    server
        .post("/terminal/companies")
        .form(&[("name", "Acme")])
        .await
        .assert_status_see_other();
    let company = app
        .db()
        .list::<Company>("company")
        .await
        .unwrap()
        .pop()
        .unwrap();
    server
        .post(&format!("/terminal/companies/{}/research", company.id))
        .form(&[("question", "What does Acme do?")])
        .await
        .assert_status_see_other();
    // Identity changes before the worker runs.
    server
        .post(&format!("/terminal/companies/{}", company.id))
        .form(&[("name", "Acme Corp"), ("version", "1")])
        .await
        .assert_status_see_other();
    assert!(chief_of_rust::work::run_once(&app).await.unwrap());
    let jobs = chief_of_rust::work::list(app.db()).await.unwrap();
    assert_eq!(jobs[0].status, "failed");
    assert!(jobs[0].error.as_ref().unwrap().contains("fresh Run"));
    assert!(
        app.db()
            .list::<chief_of_rust::terminal::subject::Brief>(
                chief_of_rust::terminal::subject::BRIEF_KIND,
            )
            .await
            .unwrap()
            .is_empty()
    );
}
struct PersonBriefFixture;
#[async_trait::async_trait]
impl chief_of_rust::llm::LlmProvider for PersonBriefFixture {
    fn name(&self) -> &'static str {
        "test"
    }
    async fn complete(&self, _: &str) -> anyhow::Result<String> {
        Ok(serde_json::json!({
            "brief": "## Research context\nResearching Ada for a profile.\n## Professional profile\nAda is an engineer. Evidence is limited to public excerpts.\n## Professional timeline\nAda joined Example Corp in 2020.\n## Public work and statements\nAda maintains example repositories.\n## Affiliations and roles\nAda works at Example Corp.\n## Industry context\nExample Corp operates in developer tooling.\n## Assessment and open questions\nAttribution remains to verify.\n## Next steps\nVerify identity against primary sources.\n## Reference check\nClaims trace to retained excerpts.\n## Sources and evidence appendix\nSee source ledger.",
            "claims": [
                {"id": "c1", "text": "Ada is an engineer", "source_ids": ["1:github_search"], "status": "supported"},
                {"id": "c2", "text": "Ada owns Example Corp revenue", "source_ids": ["1:github_search"], "status": "supported"}
            ]
        })
        .to_string())
    }
}

/// Person full research runs the attributable collector subset, excludes
/// organization-scoped actions, labels affiliation context, and applies
/// person brief headings with exact-quote demotion.
#[tokio::test]
async fn person_full_research_runs_attributable_subset_with_affiliation_context() {
    let _env = COLLECTOR_ENV_LOCK.lock().await;
    let providers = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .respond_with(
            wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": [{"name": "Ada is an engineer"}],
                "total_count": 1
            })),
        )
        .mount(&providers)
        .await;
    for key in [
        "CHIEF_COLLECT_GITHUB_BASE",
        "CHIEF_COLLECT_HACKERNEWS_BASE",
        "CHIEF_COLLECT_CROSSREF_BASE",
        "CHIEF_COLLECT_GDELT_BASE",
        "CHIEF_COLLECT_WIKIDATA_BASE",
        "CHIEF_COLLECT_STACKEXCHANGE_BASE",
        "CHIEF_COLLECT_EUROPEPMC_BASE",
        "CHIEF_COLLECT_CLINICALTRIALS_BASE",
        "CHIEF_COLLECT_ROR_BASE",
    ] {
        unsafe { std::env::set_var(key, providers.uri()) };
    }
    let dir = tempfile::tempdir().unwrap();
    let cfg = chief_of_rust::Config::for_workspace(dir.path().to_path_buf());
    let clock = RecordingClock::new();
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        Db::open(&cfg.db_path()).unwrap(),
        Arc::new(PersonBriefFixture),
        std::sync::Arc::new(CouncilJudge),
        clock.pacer(),
    )
    .app();
    let server = server(&app);
    server
        .post("/terminal/people")
        .form(&[
            ("name", "Ada Example"),
            ("role", "Engineer"),
            ("company", "Example Corp"),
        ])
        .await
        .assert_status_see_other();
    let person = app
        .db()
        .list::<chief_of_rust::people::Person>("person")
        .await
        .unwrap()
        .pop()
        .unwrap();
    // Admission surfaces the full-research action on the person page.
    server
        .get(&format!("/terminal/people/{}", person.id))
        .await
        .assert_status_ok()
        .assert_text_contains("Refresh dossier");
    server
        .post(&format!("/terminal/people/{}/full-research", person.id))
        .form(&[("question", "What is Ada known for?")])
        .await
        .assert_status_see_other();
    assert!(chief_of_rust::work::run_once(&app).await.unwrap());
    let brief = app
        .db()
        .list::<chief_of_rust::terminal::subject::Brief>(
            chief_of_rust::terminal::subject::BRIEF_KIND,
        )
        .await
        .unwrap()
        .pop()
        .unwrap();
    // Exact-quote demotion: c2's clause appears in no retained excerpt.
    let statuses: Vec<(String, String)> = brief
        .claims
        .iter()
        .map(|c| (c.id.clone(), c.status.as_str().into()))
        .collect();
    assert!(
        statuses
            .iter()
            .any(|(id, s)| id == "c1" && s == "supported")
    );
    assert!(
        statuses
            .iter()
            .any(|(id, s)| id == "c2" && s == "unresolved")
    );
    // Organization-scoped collectors are accounted for as not-applicable,
    // never executed as personal evidence.
    assert_eq!(brief.coverage.len(), 26);
    assert!(brief.coverage.iter().any(|c| c.family == "sec_submissions"
        && c.state == chief_of_rust::research::CoverageState::NotApplicable));
    assert!(!brief.sources.iter().any(|s| s.title.contains("sec_")
        || s.title.contains("gleif")
        || s.title.contains("usaspending")));
    // Affiliation context is labeled and separate from personal claims.
    assert_eq!(brief.affiliation_context.len(), 1);
    assert!(
        brief
            .claims
            .iter()
            .all(|c| !c.source_ids.iter().any(|id| id.starts_with("affiliation:")))
    );
    server
        .get(&format!("/terminal/people/{}", person.id))
        .await
        .assert_status_ok()
        .assert_text_contains("Affiliation context")
        .assert_text_contains("Unfinished work");
    for key in [
        "CHIEF_COLLECT_GITHUB_BASE",
        "CHIEF_COLLECT_HACKERNEWS_BASE",
        "CHIEF_COLLECT_CROSSREF_BASE",
        "CHIEF_COLLECT_GDELT_BASE",
        "CHIEF_COLLECT_WIKIDATA_BASE",
        "CHIEF_COLLECT_STACKEXCHANGE_BASE",
        "CHIEF_COLLECT_EUROPEPMC_BASE",
        "CHIEF_COLLECT_CLINICALTRIALS_BASE",
        "CHIEF_COLLECT_ROR_BASE",
    ] {
        unsafe { std::env::remove_var(key) };
    }
}

/// Robots-gated discovery crawls allowed same-host pages, skips disallowed
/// paths, follows sitemap seeds, and reports the remaining queue as
/// unfinished work rather than completion.
#[tokio::test]
async fn discover_site_crawl_honors_robots_and_reports_remaining_work() {
    let pacer = RecordingClock::new().pacer();
    let _env = COLLECTOR_ENV_LOCK.lock().await;
    let site = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::path("/robots.txt"))
        .respond_with(
            wiremock::ResponseTemplate::new(200).set_body_string(
                "User-agent: *\nDisallow: /admin\nSitemap: REPLACEME/sitemap.xml\n"
                    .replace("REPLACEME", &site.uri()),
            ),
        )
        .mount(&site)
        .await;
    wiremock::Mock::given(wiremock::matchers::path("/sitemap.xml"))
        .respond_with(
            wiremock::ResponseTemplate::new(200).set_body_string(format!(
                "<urlset><url><loc>{}/pricing</loc></url></urlset>",
                site.uri()
            )),
        )
        .mount(&site)
        .await;
    wiremock::Mock::given(wiremock::matchers::path("/"))
        .respond_with(wiremock::ResponseTemplate::new(200).set_body_string(
            "<html><body>Acme home <a href=\"/about\">About</a> <a href=\"/admin/panel\">Admin</a></body></html>",
        ))
        .mount(&site)
        .await;
    wiremock::Mock::given(wiremock::matchers::path("/about"))
        .respond_with(
            wiremock::ResponseTemplate::new(200)
                .set_body_string("<html><body>About Acme</body></html>"),
        )
        .mount(&site)
        .await;
    wiremock::Mock::given(wiremock::matchers::path("/pricing"))
        .respond_with(
            wiremock::ResponseTemplate::new(200)
                .set_body_string("<html><body>Acme pricing</body></html>"),
        )
        .mount(&site)
        .await;
    unsafe { std::env::set_var("CHIEF_COLLECT_DISCOVER_TEST_BASE", site.uri()) };
    let envelope = chief_of_rust::collect::run_collector_with(
        &pacer,
        "discover_site",
        &serde_json::json!({"url": site.uri(), "max_pages": 2}),
        None,
    )
    .await
    .unwrap();
    unsafe { std::env::remove_var("CHIEF_COLLECT_DISCOVER_TEST_BASE") };
    let evidence = &envelope.evidence;
    let pages = evidence["pages"].as_array().unwrap();
    assert_eq!(pages.len(), 2);
    assert!(
        pages
            .iter()
            .any(|p| p["text_excerpt"].as_str().unwrap().contains("Acme home"))
    );
    // The robots-disallowed admin path is never retrieved as a page.
    assert!(
        !pages
            .iter()
            .any(|p| p["url"].as_str().unwrap().contains("/admin"))
    );
    assert!(
        envelope
            .notes
            .iter()
            .any(|n| n.contains("unexecuted frontier"))
    );
    assert!(
        !evidence["remaining_queue_urls"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

/// An unreachable robots.txt withholds the crawl instead of crawling blind.
#[tokio::test]
async fn discover_site_withholds_crawl_without_robots() {
    let pacer = RecordingClock::new().pacer();
    let _env = COLLECTOR_ENV_LOCK.lock().await;
    let site = wiremock::MockServer::start().await;
    // No robots.txt mount: wiremock 404s, which means no restrictions.
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .respond_with(
            wiremock::ResponseTemplate::new(200)
                .set_body_string("<html><body>Lone page</body></html>"),
        )
        .mount(&site)
        .await;
    unsafe { std::env::set_var("CHIEF_COLLECT_DISCOVER_TEST_BASE", site.uri()) };
    let envelope = chief_of_rust::collect::run_collector_with(
        &pacer,
        "discover_site",
        &serde_json::json!({"url": site.uri(), "max_pages": 5}),
        None,
    )
    .await
    .unwrap();
    unsafe { std::env::remove_var("CHIEF_COLLECT_DISCOVER_TEST_BASE") };
    assert_eq!(envelope.status, chief_of_rust::collect::CollectorStatus::Ok);
    assert!(
        envelope.evidence["pages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["text_excerpt"].as_str().unwrap().contains("Lone page"))
    );
}

/// Frontier continuation: a wikidata provider cursor from the first Run
/// resumes in a follow-up Run, new evidence merges over the retained ledger,
/// and the new brief supersedes the prior one. A second continue with no
/// remaining cursor is refused.
#[tokio::test]
async fn company_continue_resumes_cursor_and_supersedes_brief() {
    let _env = COLLECTOR_ENV_LOCK.lock().await;
    let providers = wiremock::MockServer::start().await;
    // wiremock matches in mount order: the continued-request mock goes
    // first (path + cursor query), then the first-page mock (path only),
    // then the catch-all for every other provider.
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .and(wiremock::matchers::path("/w/api.php"))
        .and(wiremock::matchers::query_param("search-continue", "10"))
        .respond_with(
            wiremock::ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"search": [{"label": "Acme page two excerpt"}]})),
        )
        .mount(&providers)
        .await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .and(wiremock::matchers::path("/w/api.php"))
        .respond_with(
            wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "search": [{"label": "Acme page one excerpt"}],
                "search-continue": 10
            })),
        )
        .mount(&providers)
        .await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .respond_with(
            wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{"attributes": {"name": "Acme makes widgets"}}],
                "meta": {"pagination": {"total": 1}}
            })),
        )
        .mount(&providers)
        .await;
    for key in [
        "CHIEF_COLLECT_SEC_WWW_BASE",
        "CHIEF_COLLECT_SEC_DATA_BASE",
        "CHIEF_COLLECT_GLEIF_BASE",
        "CHIEF_COLLECT_WIKIDATA_BASE",
        "CHIEF_COLLECT_GDELT_BASE",
        "CHIEF_COLLECT_GITHUB_BASE",
        "CHIEF_COLLECT_HN_BASE",
        "CHIEF_COLLECT_CROSSREF_BASE",
        "CHIEF_COLLECT_ROR_BASE",
        "CHIEF_COLLECT_USASPENDING_BASE",
        "CHIEF_COLLECT_WAYBACK_BASE",
    ] {
        unsafe { std::env::set_var(key, providers.uri()) };
    }
    let dir = tempfile::tempdir().unwrap();
    let cfg = chief_of_rust::Config::for_workspace(dir.path().to_path_buf());
    let clock = RecordingClock::new();
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        Db::open(&cfg.db_path()).unwrap(),
        std::sync::Arc::new(BriefFixture),
        std::sync::Arc::new(CouncilJudge),
        clock.pacer(),
    )
    .app();
    let server = server(&app);
    // Contact-gated providers (Wikidata here) need the operator contact.
    let mut settings = chief_of_rust::settings::load(app.db()).await.unwrap();
    settings.research_contact = Some("researcher@example.com".into());
    app.db()
        .put("settings", "workspace", settings)
        .await
        .unwrap();
    server
        .post("/terminal/companies")
        .form(&[("name", "Acme Corp")])
        .await
        .assert_status_see_other();
    let company = app
        .db()
        .list::<Company>("company")
        .await
        .unwrap()
        .pop()
        .unwrap();
    server
        .post(&format!("/terminal/companies/{}/research", company.id))
        .form(&[("question", "What does Acme do?")])
        .await
        .assert_status_see_other();
    assert!(chief_of_rust::work::run_once(&app).await.unwrap());
    let first = app
        .db()
        .list::<chief_of_rust::terminal::subject::Brief>(
            chief_of_rust::terminal::subject::BRIEF_KIND,
        )
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert!(!first.saturated);
    assert_eq!(first.unproductive_expansions, 0);
    let wiki = first
        .coverage
        .iter()
        .find(|c| c.family == "wikidata_search")
        .expect("wikidata coverage");
    assert_eq!(wiki.state, chief_of_rust::research::CoverageState::Partial);
    assert!(wiki.remaining.iter().any(|r| r == "cursor: 10"));
    assert!(
        first
            .frontier
            .iter()
            .any(|f| f.next_action == "resume wikidata_search from cursor 10")
    );
    let first_sources = first.sources.len();
    // Continue admits with a resumable cursor and renders the action.
    server
        .get(&format!("/terminal/companies/{}", company.id))
        .await
        .assert_status_ok()
        .assert_text_contains("Refresh dossier");
    server
        .post(&format!(
            "/terminal/companies/{}/briefs/{}/continue",
            company.id, first.id
        ))
        .await
        .assert_status_see_other();
    assert!(chief_of_rust::work::run_once(&app).await.unwrap());
    let mut briefs = app
        .db()
        .list::<chief_of_rust::terminal::subject::Brief>(
            chief_of_rust::terminal::subject::BRIEF_KIND,
        )
        .await
        .unwrap();
    assert_eq!(briefs.len(), 2);
    briefs.sort_by_key(|b| b.created_at);
    let second = briefs.pop().unwrap();
    assert_eq!(second.supersedes.as_deref(), Some(first.id.as_str()));
    assert_eq!(second.unproductive_expansions, 0);
    assert!(!second.saturated);
    assert!(
        second.sources.len() > first_sources,
        "continued page merges new sources"
    );
    assert!(second.sources.iter().any(|s| {
        s.request_url
            .as_deref()
            .is_some_and(|u| u.contains("search-continue=10"))
    }));
    let wiki2 = second
        .coverage
        .iter()
        .find(|c| c.family == "wikidata_search")
        .expect("wikidata coverage after continue");
    assert_eq!(wiki2.state, chief_of_rust::research::CoverageState::Covered);
    // No cursor remains: a further continue is refused with conflict.
    server
        .post(&format!(
            "/terminal/companies/{}/briefs/{}/continue",
            company.id, second.id
        ))
        .await
        .assert_status_conflict();
    for key in [
        "CHIEF_COLLECT_SEC_WWW_BASE",
        "CHIEF_COLLECT_SEC_DATA_BASE",
        "CHIEF_COLLECT_GLEIF_BASE",
        "CHIEF_COLLECT_WIKIDATA_BASE",
        "CHIEF_COLLECT_GDELT_BASE",
        "CHIEF_COLLECT_GITHUB_BASE",
        "CHIEF_COLLECT_HN_BASE",
        "CHIEF_COLLECT_CROSSREF_BASE",
        "CHIEF_COLLECT_ROR_BASE",
        "CHIEF_COLLECT_USASPENDING_BASE",
        "CHIEF_COLLECT_WAYBACK_BASE",
    ] {
        unsafe { std::env::remove_var(key) };
    }
}

/// Person frontier continuation: a Europe PMC cursor from the first Run
/// resumes in a follow-up Run, new evidence merges over the retained
/// ledger, affiliation context stays labeled, and the new brief supersedes
/// the prior one. A second continue with no remaining cursor is refused.
#[tokio::test]
async fn person_continue_resumes_cursor_and_supersedes_brief() {
    let _env = COLLECTOR_ENV_LOCK.lock().await;
    let providers = wiremock::MockServer::start().await;
    // wiremock matches in mount order: the continued-request mock goes
    // first (path + cursor query), then the first-page mock (path only),
    // then the catch-all for every other provider.
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .and(wiremock::matchers::path(
            "/europepmc/webservices/rest/search",
        ))
        .and(wiremock::matchers::query_param("cursorMark", "AoII"))
        .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(
            serde_json::json!({"resultList": {"result": [{"title": "Ada page two excerpt"}]}}),
        ))
        .mount(&providers)
        .await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .and(wiremock::matchers::path(
            "/europepmc/webservices/rest/search",
        ))
        .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(
            serde_json::json!({"resultList": {
                "result": [{"title": "Ada page one excerpt"}],
                "nextCursorMark": "AoII"
            }}),
        ))
        .mount(&providers)
        .await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .respond_with(
            wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": [{"name": "Ada is an engineer"}],
                "total_count": 1
            })),
        )
        .mount(&providers)
        .await;
    for key in [
        "CHIEF_COLLECT_GITHUB_BASE",
        "CHIEF_COLLECT_HACKERNEWS_BASE",
        "CHIEF_COLLECT_CROSSREF_BASE",
        "CHIEF_COLLECT_GDELT_BASE",
        "CHIEF_COLLECT_WIKIDATA_BASE",
        "CHIEF_COLLECT_STACKEXCHANGE_BASE",
        "CHIEF_COLLECT_EUROPEPMC_BASE",
        "CHIEF_COLLECT_CLINICALTRIALS_BASE",
        "CHIEF_COLLECT_ROR_BASE",
    ] {
        unsafe { std::env::set_var(key, providers.uri()) };
    }
    let dir = tempfile::tempdir().unwrap();
    let cfg = chief_of_rust::Config::for_workspace(dir.path().to_path_buf());
    let clock = RecordingClock::new();
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        Db::open(&cfg.db_path()).unwrap(),
        Arc::new(PersonBriefFixture),
        std::sync::Arc::new(CouncilJudge),
        clock.pacer(),
    )
    .app();
    let server = server(&app);
    server
        .post("/terminal/people")
        .form(&[
            ("name", "Ada Example"),
            ("role", "Engineer"),
            ("company", "Example Corp"),
        ])
        .await
        .assert_status_see_other();
    let person = app
        .db()
        .list::<chief_of_rust::people::Person>("person")
        .await
        .unwrap()
        .pop()
        .unwrap();
    server
        .post(&format!("/terminal/people/{}/full-research", person.id))
        .form(&[("question", "What is Ada known for?")])
        .await
        .assert_status_see_other();
    assert!(chief_of_rust::work::run_once(&app).await.unwrap());
    let first = app
        .db()
        .list::<chief_of_rust::terminal::subject::Brief>(
            chief_of_rust::terminal::subject::BRIEF_KIND,
        )
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert!(!first.saturated);
    let pmc = first
        .coverage
        .iter()
        .find(|c| c.family == "europepmc_search")
        .expect("europepmc coverage");
    assert_eq!(pmc.state, chief_of_rust::research::CoverageState::Partial);
    assert!(pmc.remaining.iter().any(|r| r == "cursor: AoII"));
    assert!(
        first
            .frontier
            .iter()
            .any(|f| f.next_action == "resume europepmc_search from cursor AoII")
    );
    let first_sources = first.sources.len();
    server
        .get(&format!("/terminal/people/{}", person.id))
        .await
        .assert_status_ok()
        .assert_text_contains("Refresh dossier");
    server
        .post(&format!(
            "/terminal/people/{}/briefs/{}/continue",
            person.id, first.id
        ))
        .await
        .assert_status_see_other();
    assert!(chief_of_rust::work::run_once(&app).await.unwrap());
    let mut briefs = app
        .db()
        .list::<chief_of_rust::terminal::subject::Brief>(
            chief_of_rust::terminal::subject::BRIEF_KIND,
        )
        .await
        .unwrap();
    assert_eq!(briefs.len(), 2);
    briefs.sort_by_key(|b| b.created_at);
    let second = briefs.pop().unwrap();
    assert_eq!(second.supersedes.as_deref(), Some(first.id.as_str()));
    assert_eq!(second.unproductive_expansions, 0);
    assert!(!second.saturated);
    assert!(
        second.sources.len() > first_sources,
        "continued page merges new sources"
    );
    assert!(second.sources.iter().any(|s| {
        s.request_url
            .as_deref()
            .is_some_and(|u| u.contains("cursorMark=AoII"))
    }));
    let pmc2 = second
        .coverage
        .iter()
        .find(|c| c.family == "europepmc_search")
        .expect("europepmc coverage after continue");
    assert_eq!(pmc2.state, chief_of_rust::research::CoverageState::Covered);
    // Affiliation context carries over labeled, never personal evidence.
    assert_eq!(second.affiliation_context.len(), 1);
    assert!(
        second
            .claims
            .iter()
            .all(|c| !c.source_ids.iter().any(|id| id.starts_with("affiliation:")))
    );
    // No cursor remains: a further continue is refused with conflict.
    server
        .post(&format!(
            "/terminal/people/{}/briefs/{}/continue",
            person.id, second.id
        ))
        .await
        .assert_status_conflict();
    for key in [
        "CHIEF_COLLECT_GITHUB_BASE",
        "CHIEF_COLLECT_HACKERNEWS_BASE",
        "CHIEF_COLLECT_CROSSREF_BASE",
        "CHIEF_COLLECT_GDELT_BASE",
        "CHIEF_COLLECT_WIKIDATA_BASE",
        "CHIEF_COLLECT_STACKEXCHANGE_BASE",
        "CHIEF_COLLECT_EUROPEPMC_BASE",
        "CHIEF_COLLECT_CLINICALTRIALS_BASE",
        "CHIEF_COLLECT_ROR_BASE",
    ] {
        unsafe { std::env::remove_var(key) };
    }
}

/// Ticket #52: a configured collector failure fails the Run through the
/// Registry, retaining stage evidence and the retry link. The SEC base
/// points at a reserved-unresolvable host: validation passes (the base is
/// operator-configured) and DNS fails in transport, which is a mandatory
/// Source failure, not an Error envelope. Contact is set so the
/// contact-declaring SEC collector attempts instead of blocking.
#[tokio::test]
async fn configured_collector_failure_fails_run_with_evidence_and_retry_link() {
    let _env = COLLECTOR_ENV_LOCK.lock().await;
    let providers = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .respond_with(
            wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{"attributes": {"name": "Acme makes widgets"}}],
                "meta": {"pagination": {"total": 1}}
            })),
        )
        .mount(&providers)
        .await;
    for key in [
        "CHIEF_COLLECT_SEC_WWW_BASE",
        "CHIEF_COLLECT_SEC_DATA_BASE",
        "CHIEF_COLLECT_GLEIF_BASE",
        "CHIEF_COLLECT_GDELT_BASE",
        "CHIEF_COLLECT_GITHUB_BASE",
        "CHIEF_COLLECT_HN_BASE",
        "CHIEF_COLLECT_CROSSREF_BASE",
        "CHIEF_COLLECT_ROR_BASE",
        "CHIEF_COLLECT_USASPENDING_BASE",
        "CHIEF_COLLECT_WAYBACK_BASE",
    ] {
        unsafe { std::env::set_var(key, providers.uri()) };
    }
    unsafe { std::env::set_var("CHIEF_COLLECT_SEC_WWW_BASE", "https://unreachable.invalid") };
    let dir = tempfile::tempdir().unwrap();
    let cfg = chief_of_rust::Config::for_workspace(dir.path().to_path_buf());
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        Db::open(&cfg.db_path()).unwrap(),
        std::sync::Arc::new(BriefFixture),
        std::sync::Arc::new(CouncilJudge),
        RecordingClock::new().pacer(),
    )
    .app();
    let mut settings = chief_of_rust::settings::load(app.db()).await.unwrap();
    settings.research_contact = Some("researcher@example.com".into());
    app.db()
        .put("settings", "workspace", settings)
        .await
        .unwrap();
    let server = server(&app);
    server
        .post("/terminal/companies")
        .form(&[("name", "Acme Corp")])
        .await
        .assert_status_see_other();
    let company = app
        .db()
        .list::<Company>("company")
        .await
        .unwrap()
        .pop()
        .unwrap();
    server
        .post(&format!("/terminal/companies/{}/research", company.id))
        .form(&[("question", "What does Acme do?")])
        .await
        .assert_status_see_other();
    let job = chief_of_rust::work::list(app.db())
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert!(chief_of_rust::work::run_once(&app).await.unwrap());
    let failed = chief_of_rust::work::find(app.db(), &job.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        failed.status, "failed",
        "a configured collector failure fails the Run"
    );
    let message = failed.error.clone().unwrap_or_default();
    assert!(
        message.contains("sec_tickers"),
        "the Run error must name the failed Source: {message}"
    );
    // The retry control and the failed collector's error detail survive on
    // the Run page: stage evidence is retained, not discarded.
    server
        .get(&format!("/runs/{}", job.id))
        .await
        .assert_status_ok()
        .assert_text_contains("Retry with the original input")
        .assert_text_contains("sec_tickers");
    server
        .post(&format!("/runs/{}/retry", job.id))
        .await
        .assert_status_see_other();
    let retried = chief_of_rust::work::list(app.db()).await.unwrap();
    let retry = retried
        .iter()
        .find(|j| j.retry_of.as_deref() == Some(job.id.as_str()))
        .expect("a retry Run linked to the original failed Run");
    server
        .get(&format!("/runs/{}", retry.id))
        .await
        .assert_status_ok()
        .assert_text_contains("the original failed Run");
    for key in [
        "CHIEF_COLLECT_SEC_WWW_BASE",
        "CHIEF_COLLECT_SEC_DATA_BASE",
        "CHIEF_COLLECT_GLEIF_BASE",
        "CHIEF_COLLECT_GDELT_BASE",
        "CHIEF_COLLECT_GITHUB_BASE",
        "CHIEF_COLLECT_HN_BASE",
        "CHIEF_COLLECT_CROSSREF_BASE",
        "CHIEF_COLLECT_ROR_BASE",
        "CHIEF_COLLECT_USASPENDING_BASE",
        "CHIEF_COLLECT_WAYBACK_BASE",
    ] {
        unsafe { std::env::remove_var(key) };
    }
}

/// Ticket #52: a missing operator contact blocks only contact-declaring
/// collectors; the Run still succeeds and other Sources proceed. Every
/// diagnostic row keeps its Source label and blocked rows stay visible.
#[tokio::test]
async fn missing_contact_blocks_only_contact_collectors_at_http() {
    let _env = COLLECTOR_ENV_LOCK.lock().await;
    let providers = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .respond_with(
            wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{"attributes": {"name": "Acme makes widgets"}}],
                "meta": {"pagination": {"total": 1}}
            })),
        )
        .mount(&providers)
        .await;
    for key in [
        "CHIEF_COLLECT_SEC_WWW_BASE",
        "CHIEF_COLLECT_SEC_DATA_BASE",
        "CHIEF_COLLECT_GLEIF_BASE",
        "CHIEF_COLLECT_GDELT_BASE",
        "CHIEF_COLLECT_GITHUB_BASE",
        "CHIEF_COLLECT_HN_BASE",
        "CHIEF_COLLECT_CROSSREF_BASE",
        "CHIEF_COLLECT_ROR_BASE",
        "CHIEF_COLLECT_USASPENDING_BASE",
        "CHIEF_COLLECT_WAYBACK_BASE",
    ] {
        unsafe { std::env::set_var(key, providers.uri()) };
    }
    let dir = tempfile::tempdir().unwrap();
    let cfg = chief_of_rust::Config::for_workspace(dir.path().to_path_buf());
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        Db::open(&cfg.db_path()).unwrap(),
        std::sync::Arc::new(BriefFixture),
        std::sync::Arc::new(CouncilJudge),
        RecordingClock::new().pacer(),
    )
    .app();
    let server = server(&app);
    server
        .post("/terminal/companies")
        .form(&[("name", "Acme Corp")])
        .await
        .assert_status_see_other();
    let company = app
        .db()
        .list::<Company>("company")
        .await
        .unwrap()
        .pop()
        .unwrap();
    server
        .post(&format!("/terminal/companies/{}/research", company.id))
        .form(&[("question", "What does Acme do?")])
        .await
        .assert_status_see_other();
    assert!(chief_of_rust::work::run_once(&app).await.unwrap());
    let jobs = chief_of_rust::work::list(app.db()).await.unwrap();
    let done = jobs.last().expect("research enqueued a Run");
    assert_eq!(
        done.status, "done",
        "blocked contact collectors must not fail the Run"
    );
    let brief = app
        .db()
        .list::<chief_of_rust::terminal::subject::Brief>(
            chief_of_rust::terminal::subject::BRIEF_KIND,
        )
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert!(
        brief.coverage.iter().any(|c| c.family == "sec_tickers"
            && c.state == chief_of_rust::research::CoverageState::Blocked),
        "contact-declaring collectors stay blocked without a contact"
    );
    assert!(
        brief.coverage.iter().any(|c| c.family == "gleif_search"
            && c.state == chief_of_rust::research::CoverageState::Covered),
        "unrelated Sources proceed while contact collectors are blocked"
    );
    // Every diagnostic row keeps its Source label beside its counts: one
    // row per planned action, each matching a coverage family.
    assert!(
        !brief.source_diagnostics.is_empty(),
        "the brief carries per-Source diagnostics"
    );
    for diagnostic in &brief.source_diagnostics {
        assert!(
            brief.coverage.iter().any(|c| c.family == diagnostic.label),
            "diagnostic label {} has no coverage row",
            diagnostic.label
        );
    }
    assert!(brief.source_diagnostics.iter().any(|d| d.status
        == chief_of_rust::sources::SourceStatus::Blocked
        && d.label == "sec_tickers"));
    for key in [
        "CHIEF_COLLECT_SEC_WWW_BASE",
        "CHIEF_COLLECT_SEC_DATA_BASE",
        "CHIEF_COLLECT_GLEIF_BASE",
        "CHIEF_COLLECT_GDELT_BASE",
        "CHIEF_COLLECT_GITHUB_BASE",
        "CHIEF_COLLECT_HN_BASE",
        "CHIEF_COLLECT_CROSSREF_BASE",
        "CHIEF_COLLECT_ROR_BASE",
        "CHIEF_COLLECT_USASPENDING_BASE",
        "CHIEF_COLLECT_WAYBACK_BASE",
    ] {
        unsafe { std::env::remove_var(key) };
    }
}

/// Ticket #52: an explicitly blanked provider base marks the Source not
/// configured; the Run still succeeds and the row records the fact.
#[tokio::test]
async fn unconfigured_collector_records_not_configured_without_failing() {
    let _env = COLLECTOR_ENV_LOCK.lock().await;
    let providers = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .respond_with(
            wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{"attributes": {"name": "Acme makes widgets"}}],
                "meta": {"pagination": {"total": 1}}
            })),
        )
        .mount(&providers)
        .await;
    for key in [
        "CHIEF_COLLECT_SEC_WWW_BASE",
        "CHIEF_COLLECT_SEC_DATA_BASE",
        "CHIEF_COLLECT_GLEIF_BASE",
        "CHIEF_COLLECT_GDELT_BASE",
        "CHIEF_COLLECT_GITHUB_BASE",
        "CHIEF_COLLECT_HN_BASE",
        "CHIEF_COLLECT_CROSSREF_BASE",
        "CHIEF_COLLECT_ROR_BASE",
        "CHIEF_COLLECT_USASPENDING_BASE",
        "CHIEF_COLLECT_WAYBACK_BASE",
    ] {
        unsafe { std::env::set_var(key, providers.uri()) };
    }
    unsafe { std::env::set_var("CHIEF_COLLECT_GITHUB_BASE", "") };
    let dir = tempfile::tempdir().unwrap();
    let cfg = chief_of_rust::Config::for_workspace(dir.path().to_path_buf());
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        Db::open(&cfg.db_path()).unwrap(),
        std::sync::Arc::new(BriefFixture),
        std::sync::Arc::new(CouncilJudge),
        RecordingClock::new().pacer(),
    )
    .app();
    let server = server(&app);
    server
        .post("/terminal/companies")
        .form(&[("name", "Acme Corp")])
        .await
        .assert_status_see_other();
    let company = app
        .db()
        .list::<Company>("company")
        .await
        .unwrap()
        .pop()
        .unwrap();
    server
        .post(&format!("/terminal/companies/{}/research", company.id))
        .form(&[("question", "What does Acme do?")])
        .await
        .assert_status_see_other();
    assert!(chief_of_rust::work::run_once(&app).await.unwrap());
    let jobs = chief_of_rust::work::list(app.db()).await.unwrap();
    let done = jobs.last().expect("research enqueued a Run");
    assert_eq!(
        done.status, "done",
        "an unconfigured Source must not fail the Run"
    );
    let brief = app
        .db()
        .list::<chief_of_rust::terminal::subject::Brief>(
            chief_of_rust::terminal::subject::BRIEF_KIND,
        )
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert!(
        brief
            .source_diagnostics
            .iter()
            .any(|d| d.label == "github_search"
                && d.status == chief_of_rust::sources::SourceStatus::NotConfigured),
        "the blanked Source records not-configured"
    );
    assert!(
        brief.coverage.iter().any(|c| c.family == "github_search"
            && c.stop_reason
                .as_deref()
                .is_some_and(|reason| reason.contains("not configured"))),
        "the coverage row records the unconfigured Source"
    );
    for key in [
        "CHIEF_COLLECT_SEC_WWW_BASE",
        "CHIEF_COLLECT_SEC_DATA_BASE",
        "CHIEF_COLLECT_GLEIF_BASE",
        "CHIEF_COLLECT_GDELT_BASE",
        "CHIEF_COLLECT_GITHUB_BASE",
        "CHIEF_COLLECT_HN_BASE",
        "CHIEF_COLLECT_CROSSREF_BASE",
        "CHIEF_COLLECT_ROR_BASE",
        "CHIEF_COLLECT_USASPENDING_BASE",
        "CHIEF_COLLECT_WAYBACK_BASE",
    ] {
        unsafe { std::env::remove_var(key) };
    }
}

/// Ticket #52: per-Source counts land on the brief diagnostics beside the
/// Evidence they account for. GLEIF returns one empty page, so its row
/// records received 1 / empty 1 / selected 0 while a covered Source
/// records received 1 / selected 1.
#[tokio::test]
async fn registry_counts_land_per_source_on_the_brief() {
    let _env = COLLECTOR_ENV_LOCK.lock().await;
    let ok = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .respond_with(
            wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{"attributes": {"name": "Acme makes widgets"}}],
                "meta": {"pagination": {"total": 1}}
            })),
        )
        .mount(&ok)
        .await;
    let empty = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .respond_with(
            wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [],
                "meta": {"pagination": {"total": 0}}
            })),
        )
        .mount(&empty)
        .await;
    for key in [
        "CHIEF_COLLECT_SEC_WWW_BASE",
        "CHIEF_COLLECT_SEC_DATA_BASE",
        "CHIEF_COLLECT_GDELT_BASE",
        "CHIEF_COLLECT_GITHUB_BASE",
        "CHIEF_COLLECT_HN_BASE",
        "CHIEF_COLLECT_CROSSREF_BASE",
        "CHIEF_COLLECT_ROR_BASE",
        "CHIEF_COLLECT_USASPENDING_BASE",
        "CHIEF_COLLECT_WAYBACK_BASE",
    ] {
        unsafe { std::env::set_var(key, ok.uri()) };
    }
    unsafe { std::env::set_var("CHIEF_COLLECT_GLEIF_BASE", empty.uri()) };
    let dir = tempfile::tempdir().unwrap();
    let cfg = chief_of_rust::Config::for_workspace(dir.path().to_path_buf());
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        Db::open(&cfg.db_path()).unwrap(),
        std::sync::Arc::new(BriefFixture),
        std::sync::Arc::new(CouncilJudge),
        RecordingClock::new().pacer(),
    )
    .app();
    let server = server(&app);
    server
        .post("/terminal/companies")
        .form(&[("name", "Acme Corp")])
        .await
        .assert_status_see_other();
    let company = app
        .db()
        .list::<Company>("company")
        .await
        .unwrap()
        .pop()
        .unwrap();
    server
        .post(&format!("/terminal/companies/{}/research", company.id))
        .form(&[("question", "What does Acme do?")])
        .await
        .assert_status_see_other();
    assert!(chief_of_rust::work::run_once(&app).await.unwrap());
    let brief = app
        .db()
        .list::<chief_of_rust::terminal::subject::Brief>(
            chief_of_rust::terminal::subject::BRIEF_KIND,
        )
        .await
        .unwrap()
        .pop()
        .unwrap();
    let gleif = brief
        .source_diagnostics
        .iter()
        .find(|d| d.label == "gleif_search")
        .expect("gleif diagnostic row");
    assert_eq!(gleif.received, 1);
    assert_eq!(gleif.empty, 1);
    assert_eq!(gleif.selected, 0);
    assert_eq!(
        gleif.status,
        chief_of_rust::sources::SourceStatus::Succeeded
    );
    let covered = brief
        .source_diagnostics
        .iter()
        .find(|d| d.status == chief_of_rust::sources::SourceStatus::Succeeded && d.selected == 1)
        .expect("a covered Source records received 1 and selected 1");
    assert_eq!(covered.received, 1);
    for key in [
        "CHIEF_COLLECT_SEC_WWW_BASE",
        "CHIEF_COLLECT_SEC_DATA_BASE",
        "CHIEF_COLLECT_GLEIF_BASE",
        "CHIEF_COLLECT_GDELT_BASE",
        "CHIEF_COLLECT_GITHUB_BASE",
        "CHIEF_COLLECT_HN_BASE",
        "CHIEF_COLLECT_CROSSREF_BASE",
        "CHIEF_COLLECT_ROR_BASE",
        "CHIEF_COLLECT_USASPENDING_BASE",
        "CHIEF_COLLECT_WAYBACK_BASE",
    ] {
        unsafe { std::env::remove_var(key) };
    }
}
