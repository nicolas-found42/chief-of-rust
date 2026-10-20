//! ticket #51). SearXNG and Firecrawl run as ordinary query Sources through
//! `integrations::search`: per-Source min 8 / max 12 honest short counts, 50
//! total max, deterministic round-robin interleave + dedupe, every attempted
//! Source keeps its measured diagnostic, Source labels + counts on Run and
//! Coverage records, and a deterministic retry boundary.
use chief_of_rust::{
    App, Config,
    db::Db,
    llm::LlmProvider,
    terminal::automatic::{Dossier, Request},
};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{header, method, path},
};

mod common;

/// The fixture judgment connection: the shared policy fixture for evidence
/// audits and the shared Critical Council fixture for Council requests.
struct FixtureJudge;
#[async_trait::async_trait]
impl chief_of_rust::judgments::Judge for FixtureJudge {
    async fn evaluate(
        &self,
        state: Value,
        questions: Value,
    ) -> anyhow::Result<chief_of_rust::judgments::Evaluation> {
        Ok(if common::is_council_request(&questions) {
            common::council_evaluation(&questions)
        } else {
            common::fixture_evaluation(&state, &questions)
        })
    }
}

struct Replies(Arc<Mutex<VecDeque<String>>>);
#[async_trait::async_trait]
impl LlmProvider for Replies {
    fn name(&self) -> &'static str {
        "fixture"
    }
    async fn complete(&self, prompt: &str) -> anyhow::Result<String> {
        if prompt.starts_with("TERMINAL_DISCOVERIES") {
            return Ok(json!({"candidates":[]}).to_string());
        }
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
                        json!("Acme is a corporation. [s0] Other details are unknown."),
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
    searx: MockServer,
    firecrawl: MockServer,
}

/// Both query Sources configured; callers mount rows per test.
impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let searx = MockServer::start().await;
        let firecrawl = MockServer::start().await;
        let mut cfg = Config::for_workspace(dir.path().to_path_buf());
        cfg.searxng_base_url = Some(searx.uri());
        cfg.firecrawl_api_key = Some("fixture-firecrawl-key".into());
        cfg.firecrawl_base_url = Some(firecrawl.uri());
        let replies = Arc::new(Mutex::new(VecDeque::new()));
        let app = chief_of_rust::Installation::with_connections(
            cfg.clone(),
            Db::open(&cfg.db_path()).unwrap(),
            Arc::new(Replies(replies.clone())),
            Arc::new(FixtureJudge),
            std::sync::Arc::new(chief_of_rust::collect::Pacer::system()),
        )
        .app();
        let server = axum_test::TestServer::new(chief_of_rust::routes::router(app.clone()));
        // Keep the TempDir alive for the fixture lifetime.
        Self {
            app,
            server,
            replies,
            searx,
            firecrawl,
        }
    }
    fn reply(&self, value: Value) {
        self.replies.lock().unwrap().push_back(value.to_string());
    }
    async fn run(&self) {
        assert!(chief_of_rust::work::run_once(&self.app).await.unwrap());
    }
    async fn requests(&self) -> Vec<Request> {
        self.app.db().list("terminal_request").await.unwrap()
    }
    fn mount_searx(&self, rows: Vec<Value>) -> Mock {
        Mock::given(method("GET"))
            .and(path("/search"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "results": rows,
                "unresponsive_engines": [],
            })))
    }
    fn mount_firecrawl(&self, web: Vec<Value>) -> Mock {
        Mock::given(method("POST"))
            .and(path("/search"))
            .and(header("authorization", "Bearer fixture-firecrawl-key"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"success": true, "data": {"web": web}})),
            )
    }
}

fn dossier(kind: &str, marker: &str, existing: Option<&str>) -> Value {
    let headings = if kind == "person" {
        chief_of_rust::research::PERSON_LONG_BRIEF_HEADINGS.as_slice()
    } else {
        chief_of_rust::research::LONG_BRIEF_HEADINGS.as_slice()
    };
    json!({"body":headings.iter().map(|h|format!("## {h}\n{marker}. Evidence [s0]; other facts unknown.\n")).collect::<String>(),"claims":[],"identity":{"outcome":"resolved","existing_id":existing,"explanation":"Attributable identity evidence","references":[{"source_id":"s0","quote":"IDENTITY_ANCHOR"}],"alternatives":[]},"candidates":[]})
}

fn searx_hit(n: usize) -> Value {
    json!({"url": format!("https://example.com/searx/{n}"),
        "title": format!("SearXNG {n}"),
        "content": format!("SearXNG snippet {n} with corporation detail."),})
}

fn firecrawl_hit(n: usize) -> Value {
    json!({"url": format!("https://example.com/firecrawl/{n}"),
        "title": format!("Firecrawl {n}"),
        "description": format!("Firecrawl snippet {n} with corporation detail."),})
}

/// A complete company intake over both query Sources: every configured Source
/// fires, and the saved Dossier carries Source labels + counts.
#[tokio::test]
async fn terminal_run_uses_both_query_sources_with_labels_and_counts() {
    let f = Fixture::new().await;
    f.mount_searx(vec![searx_hit(0)])
        .expect(1..)
        .mount(&f.searx)
        .await;
    f.mount_firecrawl(vec![firecrawl_hit(0)])
        .expect(1..)
        .mount(&f.firecrawl)
        .await;
    let mut response = dossier("company", "Dual source dossier", None);
    response["identity"]["references"] = json!([
        {"source_id": "s0", "quote": "SearXNG snippet 0 with corporation detail."},
        {"source_id": "s1", "quote": "Firecrawl snippet 0 with corporation detail."},
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
        chief_of_rust::work::find(f.app.db(), &request.run_id)
            .await
            .unwrap()
            .unwrap()
            .error
    );
    assert!(!f.searx.received_requests().await.unwrap().is_empty());
    assert!(!f.firecrawl.received_requests().await.unwrap().is_empty());
    let target = request.target_id.unwrap();
    let saved: Dossier = f
        .app
        .db()
        .get("terminal_dossier", &format!("company:{target}"))
        .await
        .unwrap()
        .unwrap();
    let origins: Vec<&str> = saved.sources.iter().map(|s| s.origin.as_str()).collect();
    assert!(
        origins.iter().any(|o| o.starts_with("searxng query;")),
        "searxng Source label on Run: {origins:?}"
    );
    assert!(
        origins.iter().any(|o| o.starts_with("firecrawl query;")),
        "firecrawl Source label on Run: {origins:?}"
    );
    let coverage_text = saved
        .coverage
        .iter()
        .map(|r| r.boundary.clone())
        .collect::<Vec<_>>();
    assert!(
        coverage_text.iter().any(|b| b.contains("searxng")),
        "searxng counts on Coverage: {coverage_text:?}"
    );
    assert!(
        coverage_text.iter().any(|b| b.contains("firecrawl")),
        "firecrawl counts on Coverage: {coverage_text:?}"
    );
}

/// 12-per-Source and 50-total caps: 15 rows per Source select 12 each (24
/// total, under the 50 cap), with the omitted remainder counted honestly.
#[tokio::test]
async fn terminal_run_applies_twelve_per_source_cap_with_honest_omitted() {
    let f = Fixture::new().await;
    f.mount_searx((0..15).map(searx_hit).collect())
        .expect(1..)
        .mount(&f.searx)
        .await;
    f.mount_firecrawl((0..15).map(firecrawl_hit).collect())
        .expect(1..)
        .mount(&f.firecrawl)
        .await;
    let mut response = dossier("company", "Capped dossier", None);
    response["identity"]["references"] =
        json!([{"source_id": "s0", "quote": "SearXNG snippet 0 with corporation detail."}]);
    f.reply(response);
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "company"), ("name", "Acme")])
        .await
        .assert_status_see_other();
    f.run().await;
    let request = f.requests().await.pop().unwrap();
    assert_eq!(request.status, "complete");
    let collection: Value = f
        .app
        .db()
        .get("terminal_collection", &request.id)
        .await
        .unwrap()
        .unwrap();
    let snippet_sources = collection["sources"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["origin"].as_str().is_some_and(|o| o.contains(" query;")))
        .count();
    // Round-robin interleave of 12+12 selected hits = 24 query snippets.
    assert_eq!(snippet_sources, 24, "{collection}");
    let boundaries: Vec<String> = collection["coverage"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|r| r["boundary"].as_str().map(str::to_owned))
        .collect();
    assert!(
        boundaries
            .iter()
            .any(|b| b.contains("searxng query:") && b.contains("omitted 3 selected 12")),
        "searxng per-source cap + omitted: {boundaries:?}"
    );
    assert!(
        boundaries
            .iter()
            .any(|b| b.contains("firecrawl query:") && b.contains("omitted 3 selected 12")),
        "firecrawl per-source cap + omitted: {boundaries:?}"
    );
}

/// Short counts stay honest: 3 rows from one Source record a gap with the
/// actual count, never padded to the 8 minimum.
#[tokio::test]
async fn terminal_run_records_honest_short_counts_with_gap() {
    let f = Fixture::new().await;
    f.mount_searx((0..3).map(searx_hit).collect())
        .expect(1..)
        .mount(&f.searx)
        .await;
    f.mount_firecrawl((0..8).map(firecrawl_hit).collect())
        .expect(1..)
        .mount(&f.firecrawl)
        .await;
    let mut response = dossier("company", "Short count dossier", None);
    response["identity"]["references"] =
        json!([{"source_id": "s0", "quote": "SearXNG snippet 0 with corporation detail."}]);
    f.reply(response);
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "company"), ("name", "Acme")])
        .await
        .assert_status_see_other();
    f.run().await;
    let request = f.requests().await.pop().unwrap();
    assert_eq!(request.status, "complete");
    let collection: Value = f
        .app
        .db()
        .get("terminal_collection", &request.id)
        .await
        .unwrap()
        .unwrap();
    let boundaries: Vec<String> = collection["coverage"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|r| r["boundary"].as_str().map(str::to_owned))
        .collect();
    assert!(
        boundaries
            .iter()
            .any(|b| b.contains("searxng query:") && b.contains("selected 3 of 8 minimum")),
        "honest sub-8 gap: {boundaries:?}"
    );
}

/// Duplicates collapse across Sources: the same canonical URL from both
/// Sources retains one snippet and counts the duplicate on its Source.
#[tokio::test]
async fn terminal_run_dedupes_across_sources() {
    let f = Fixture::new().await;
    f.mount_searx(vec![searx_hit(0)])
        .expect(1..)
        .mount(&f.searx)
        .await;
    f.mount_firecrawl(vec![
        json!({"url": "https://example.com/searx/0#duplicate",
            "title": "Same page via Firecrawl",
            "description": "Firecrawl wording of the same page."}),
        firecrawl_hit(1),
    ])
    .expect(1..)
    .mount(&f.firecrawl)
    .await;
    let mut response = dossier("company", "Dedupe dossier", None);
    response["identity"]["references"] =
        json!([{"source_id": "s0", "quote": "SearXNG snippet 0 with corporation detail."}]);
    f.reply(response);
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "company"), ("name", "Acme")])
        .await
        .assert_status_see_other();
    f.run().await;
    let request = f.requests().await.pop().unwrap();
    assert_eq!(request.status, "complete");
    let collection: Value = f
        .app
        .db()
        .get("terminal_collection", &request.id)
        .await
        .unwrap()
        .unwrap();
    let urls: Vec<String> = collection["sources"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|s| s["source_url"].as_str().map(str::to_owned))
        .collect();
    assert_eq!(
        urls.iter()
            .filter(|u| u.as_str() == "https://example.com/searx/0")
            .count(),
        1,
        "canonical URL retained once: {urls:?}"
    );
    let boundaries: Vec<String> = collection["coverage"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|r| r["boundary"].as_str().map(str::to_owned))
        .collect();
    assert!(
        boundaries
            .iter()
            .any(|b| b.contains("firecrawl") && b.contains("duplicates 1")),
        "duplicate counted on its Source: {boundaries:?}"
    );
}

/// A configured Source failure fails the Run but keeps every attempted
/// Source's measured diagnostic; retry re-runs and links to the failed Run.
#[tokio::test]
async fn terminal_run_fails_on_source_error_and_retry_links() {
    let f = Fixture::new().await;
    f.mount_searx(vec![searx_hit(0)]).mount(&f.searx).await;
    Mock::given(method("POST"))
        .and(path("/search"))
        .respond_with(ResponseTemplate::new(402).set_body_json(json!({"success": false})))
        .expect(1..)
        .mount(&f.firecrawl)
        .await;
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "company"), ("name", "Acme")])
        .await
        .assert_status_see_other();
    f.run().await;
    let failed = f.requests().await.pop().unwrap();
    assert_eq!(failed.status, "failed");
    let job = chief_of_rust::work::find(f.app.db(), &failed.run_id)
        .await
        .unwrap()
        .unwrap();
    let error = job.error.unwrap();
    assert!(error.contains("firecrawl"), "failed Source named: {error}");
    assert!(
        !error.contains("fixture-firecrawl-key"),
        "key redacted: {error}"
    );
    // The searxng diagnostic survives the firecrawl failure (no suppression).
    assert!(error.contains("searxng"), "attempted Source kept: {error}");
    // Retry re-runs collection against both Sources and links the new Run.
    // Reset clears the failure mocks so the retry observes fresh rows.
    f.searx.reset().await;
    f.firecrawl.reset().await;
    f.mount_searx(vec![searx_hit(0)])
        .expect(1..)
        .mount(&f.searx)
        .await;
    f.mount_firecrawl(vec![firecrawl_hit(0)])
        .expect(1..)
        .mount(&f.firecrawl)
        .await;
    let mut response = dossier("company", "Recovered dossier", None);
    response["identity"]["references"] = json!([
        {"source_id": "s0", "quote": "SearXNG snippet 0 with corporation detail."},
        {"source_id": "s1", "quote": "Firecrawl snippet 0 with corporation detail."},
    ]);
    f.reply(response);
    f.server
        .post(&format!("/runs/{}/retry", failed.run_id))
        .await
        .assert_status_see_other();
    f.run().await;
    let completed = f.requests().await.pop().unwrap();
    assert_eq!(completed.status, "complete");
    let original = chief_of_rust::work::find(f.app.db(), &failed.run_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(original.status, "failed", "original failed Run kept");
    let recovery = chief_of_rust::work::find(f.app.db(), &completed.run_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(recovery.retry_of.as_deref(), Some(failed.run_id.as_str()));
    assert_eq!(recovery.status, "done");
}

/// Installation overrides (issue #53): the effective query-Source limits
/// apply at the Terminal HTTP seam, and clamped deviations are recorded in
/// the Run's saved limits. Retention (80 envelopes) stays separate from
/// selection (per-source min/max, total max).
#[tokio::test]
async fn terminal_run_applies_overridden_source_limits_and_records_deviations() {
    let dir = tempfile::tempdir().unwrap();
    let searx = MockServer::start().await;
    let firecrawl = MockServer::start().await;
    let mut cfg = Config::for_workspace(dir.path().to_path_buf());
    cfg.searxng_base_url = Some(searx.uri());
    cfg.firecrawl_api_key = Some("fixture-firecrawl-key".into());
    cfg.firecrawl_base_url = Some(firecrawl.uri());
    cfg.source_limits = chief_of_rust::sources::SourceLimits::clamped(2, 4, 6);
    cfg.source_limit_notes = vec![
        "CHIEF_SOURCE_MAX_PER_SOURCE (per-source maximum) 500 clamped to 50".to_string(),
        "CHIEF_SOURCE_MAX_TOTAL (total maximum) unparseable, kept default 50".to_string(),
    ];
    let replies = Arc::new(Mutex::new(VecDeque::new()));
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        Db::open(&cfg.db_path()).unwrap(),
        Arc::new(Replies(replies.clone())),
        Arc::new(FixtureJudge),
        std::sync::Arc::new(chief_of_rust::collect::Pacer::system()),
    )
    .app();
    let server = axum_test::TestServer::new(chief_of_rust::routes::router(app.clone()));
    // Five rows per Source: Firecrawl's request asks for the effective
    // 4-per-source maximum, and the 6-total cap selects 3 + 3.
    Mock::given(method("GET"))
        .and(path("/search"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "results": (0..5).map(searx_hit).collect::<Vec<_>>(),
            "unresponsive_engines": [],
        })))
        .expect(1..)
        .mount(&searx)
        .await;
    Mock::given(method("POST"))
        .and(path("/search"))
        .and(header("authorization", "Bearer fixture-firecrawl-key"))
        .and(wiremock::matchers::body_partial_json(json!({"limit": 4})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "success": true,
            "data": {"web": (0..5).map(firecrawl_hit).collect::<Vec<_>>()},
        })))
        .expect(1..)
        .mount(&firecrawl)
        .await;
    let mut response = dossier("company", "Override dossier", None);
    response["identity"]["references"] =
        json!([{"source_id": "s0", "quote": "SearXNG snippet 0 with corporation detail."}]);
    replies.lock().unwrap().push_back(response.to_string());
    server
        .post("/terminal/intake")
        .form(&[("kind", "company"), ("name", "Acme")])
        .await
        .assert_status_see_other();
    assert!(chief_of_rust::work::run_once(&app).await.unwrap());
    let requests: Vec<Request> = app.db().list("terminal_request").await.unwrap();
    let request = requests.into_iter().next().unwrap();
    assert_eq!(
        request.status,
        "complete",
        "{:?}",
        chief_of_rust::work::find(app.db(), &request.run_id)
            .await
            .unwrap()
            .unwrap()
            .error
    );
    let collection: Value = app
        .db()
        .get("terminal_collection", &request.id)
        .await
        .unwrap()
        .unwrap();
    // The effective selection bounds are recorded on the Run.
    let limits = collection["limitations"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|l| l.as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    assert!(
        limits
            .iter()
            .any(|l| l.contains("at least 2 and at most 4 results each, 6 in total")),
        "effective limits on Run: {limits:?}"
    );
    assert!(
        limits.iter().any(|l| l
            .contains("Source limit override: CHIEF_SOURCE_MAX_PER_SOURCE (per-source maximum) 500 clamped to 50.")),
        "clamped deviation recorded: {limits:?}"
    );
    assert!(
        limits.iter().any(|l| l
            .contains("Source limit override: CHIEF_SOURCE_MAX_TOTAL (total maximum) unparseable, kept default 50.")),
        "unparseable deviation recorded: {limits:?}"
    );
    // Selection (6 total) is distinct from retention (80 envelopes): the
    // retention budget line still names the 80-envelope default.
    assert!(
        limits.iter().any(|l| l.contains("80 source envelopes")),
        "retention budget unchanged: {limits:?}"
    );
    // Six query snippets retained under the 6-total cap (3 per Source).
    let snippet_sources = collection["sources"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["origin"].as_str().is_some_and(|o| o.contains(" query;")))
        .count();
    assert_eq!(snippet_sources, 6, "{collection}");
    let boundaries: Vec<String> = collection["coverage"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|r| r["boundary"].as_str().map(str::to_owned))
        .collect();
    assert!(
        boundaries
            .iter()
            .any(|b| b.contains("searxng query:") && b.contains("omitted 2 selected 3")),
        "searxng effective caps + omitted: {boundaries:?}"
    );
    assert!(
        boundaries
            .iter()
            .any(|b| b.contains("firecrawl query:") && b.contains("omitted 2 selected 3")),
        "firecrawl effective caps + omitted: {boundaries:?}"
    );
    // The minimum is the effective 2, not the default 8: a Source at 3
    // selected records no honest-short-count gap.
    assert!(
        !boundaries.iter().any(|b| b.contains("honest short count")),
        "no sub-minimum gap at effective minimum: {boundaries:?}"
    );
}
