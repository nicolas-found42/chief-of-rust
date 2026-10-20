//! Critical Council: Terminal HTTP seam and Council contract seam.
//!
//! Seam 1 (Terminal HTTP): every Terminal Run that produces or updates a
//! Dossier, Brief or report (including comparison reports) creates a Council
//! revision linked to the Run and the reviewed artifact revision; a later
//! Run adds a revision without rewriting the earlier one; a missing Jev
//! configuration fails the Run with setup guidance; a malformed fixture
//! judgment fails the Run; the Council never mutates report text or claim
//! status.
//!
//! Seam 3 (Council contract): an explicit judgment fixture and a known
//! artifact drive the Council directly. The saved revision contents are
//! asserted: reviewer set, per-claim probabilities, concerns, citation
//! checks, dissent, input hashes, provider and usage. The request is grouped
//! and bounded; an oversized input splits deterministically with every split
//! recorded. A partial, malformed or incoherent answer fails rather than
//! passing.

mod common;

static COLLECTOR_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

use chief_of_rust::{
    App, Config,
    council::{self, COUNCIL_KIND, CouncilRevision, REVIEWERS},
    db::Db,
    judgments::{Evaluation, Judge, Usage},
    llm::LlmProvider,
    terminal::{
        Company,
        automatic::{Dossier, Report},
        comparison::ComparisonReport,
        subject::{BRIEF_KIND, Brief},
    },
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{method, path},
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/// An explicit Council judgment fixture: answers every question it is asked
/// with a valid, coherent answer. Never evidence of the live model's accuracy.
struct CouncilFixture {
    /// Recorded (state, questions) pairs, for asserting grouping/boundedness.
    calls: Mutex<Vec<(Value, Value)>>,
}

impl CouncilFixture {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            calls: Mutex::new(Vec::new()),
        })
    }

    fn calls(&self) -> Vec<(Value, Value)> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl Judge for CouncilFixture {
    async fn evaluate(&self, state: Value, questions: Value) -> anyhow::Result<Evaluation> {
        self.calls
            .lock()
            .unwrap()
            .push((state.clone(), questions.clone()));
        let mut answers = BTreeMap::new();
        for (id, q) in questions.as_object().unwrap() {
            let answer = match q["type"].as_str().unwrap() {
                // Instruction screening asks "is this an injection?" — answer
                // no (0.0) so usable sources survive screening.
                "noul" if id == "injection" => json!({"type":"noul","noul":0.0}),
                "noul" => json!({"type":"noul","noul":0.9}),
                "choice" => {
                    // Pick the first criterion; a coherent distribution.
                    let selected = q["criteria"]
                        .as_object()
                        .unwrap()
                        .keys()
                        .next()
                        .unwrap()
                        .clone();
                    let p: serde_json::Map<String, Value> = q["criteria"]
                        .as_object()
                        .unwrap()
                        .keys()
                        .map(|k| (k.clone(), json!(if k == &selected { 1.0 } else { 0.0 })))
                        .collect();
                    json!({"type":"choice","choice":selected,"probabilities":p,"confidence":1.0})
                }
                _ => panic!("unexpected question type in council fixture"),
            };
            answers.insert(id.clone(), answer);
        }
        Ok(Evaluation {
            model: "council-test-fixture".into(),
            warnings: Vec::new(),
            answers,
            usage: Usage {
                input_tokens: 100,
                output_tokens: 50,
                cost_usd: Some(0.001),
                elapsed_ms: 10,
            },
        })
    }
}

/// A judge that omits one answer: a partial judgment must fail.
struct PartialJudge;

#[async_trait::async_trait]
impl Judge for PartialJudge {
    async fn evaluate(&self, _state: Value, questions: Value) -> anyhow::Result<Evaluation> {
        let mut answers = BTreeMap::new();
        let mut first = true;
        for (id, q) in questions.as_object().unwrap() {
            if !first {
                // Omit every answer after the first: a partial answer set.
                break;
            }
            first = false;
            let answer = match q["type"].as_str().unwrap() {
                "noul" => json!({"type":"noul","noul":0.5}),
                "choice" => {
                    let selected = q["criteria"]
                        .as_object()
                        .unwrap()
                        .keys()
                        .next()
                        .unwrap()
                        .clone();
                    let p: serde_json::Map<String, Value> = q["criteria"]
                        .as_object()
                        .unwrap()
                        .keys()
                        .map(|k| (k.clone(), json!(if k == &selected { 1.0 } else { 0.0 })))
                        .collect();
                    json!({"type":"choice","choice":selected,"probabilities":p,"confidence":1.0})
                }
                _ => panic!("unexpected"),
            };
            answers.insert(id.clone(), answer);
        }
        Ok(Evaluation {
            model: "partial-test-fixture".into(),
            warnings: Vec::new(),
            answers,
            usage: Usage::default(),
        })
    }
}

/// A judge that returns a non-finite probability: must fail.
struct NonFiniteJudge;

#[async_trait::async_trait]
impl Judge for NonFiniteJudge {
    async fn evaluate(&self, _state: Value, questions: Value) -> anyhow::Result<Evaluation> {
        let mut answers = BTreeMap::new();
        for (id, q) in questions.as_object().unwrap() {
            let answer = match q["type"].as_str().unwrap() {
                "noul" => json!({"type":"noul","noul":f64::NAN}),
                "choice" => {
                    let selected = q["criteria"]
                        .as_object()
                        .unwrap()
                        .keys()
                        .next()
                        .unwrap()
                        .clone();
                    let p: serde_json::Map<String, Value> = q["criteria"]
                        .as_object()
                        .unwrap()
                        .keys()
                        .map(|k| (k.clone(), json!(if k == &selected { 1.0 } else { 0.0 })))
                        .collect();
                    json!({"type":"choice","choice":selected,"probabilities":p,"confidence":1.0})
                }
                _ => panic!("unexpected"),
            };
            answers.insert(id.clone(), answer);
        }
        Ok(Evaluation {
            model: "nonfinite-test-fixture".into(),
            warnings: Vec::new(),
            answers,
            usage: Usage::default(),
        })
    }
}

/// Replies for the automatic workflow: one dossier synthesis.
struct Replies(Arc<Mutex<std::collections::VecDeque<String>>>);

#[async_trait::async_trait]
impl LlmProvider for Replies {
    fn name(&self) -> &'static str {
        "test"
    }
    async fn complete(&self, prompt: &str) -> anyhow::Result<String> {
        // TERMINAL_ANCHORS: echo the requested identity back unchanged with
        // no new fields, so no anchor enrichment or extra collection runs.
        if prompt.starts_with("TERMINAL_ANCHORS") {
            let input_start = prompt.find("Input: ").unwrap() + 7;
            let sources_start = prompt.rfind("Sources: ").unwrap();
            let identity: Value =
                serde_json::from_str(prompt[input_start..sources_start].trim_end_matches(", "))?;
            return Ok(json!({
                "identity": identity,
                "references": [],
                "identifiers": ""
            })
            .to_string());
        }
        // TERMINAL_REFERENCE_QUOTES: select the first offered quotation id.
        if prompt.starts_with("TERMINAL_REFERENCE_QUOTES") {
            return Ok(json!({"selection": ["q0"]}).to_string());
        }
        // TERMINAL_REPAIR_PART: return the part unchanged.
        if prompt.starts_with("TERMINAL_REPAIR_PART") {
            let marker = ". Rejected part: ";
            if let Some(pos) = prompt.find(marker) {
                let rest = &prompt[pos + marker.len()..];
                if let Some(end) = rest.find(". Retained evidence: ") {
                    let part: Value = serde_json::from_str(&rest[..end])?;
                    return Ok(json!({"replacement": part}).to_string());
                }
            }
            return Ok(json!({"replacement": Value::Null}).to_string());
        }
        // TERMINAL_DOSSIER_SECTIONS: not used by the synthesis path; fall
        // through to the queue.
        self.0.lock().unwrap().pop_front().ok_or_else(|| {
            anyhow::anyhow!(
                "Unexpected generation call: {}",
                &prompt[..prompt.len().min(80)]
            )
        })
    }
    async fn complete_json(&self, prompt: &str) -> anyhow::Result<String> {
        self.complete(prompt).await
    }
    async fn complete_schema(&self, prompt: &str, _schema: &Value) -> anyhow::Result<String> {
        self.complete(prompt).await
    }
}

struct Fixture {
    app: App,
    server: axum_test::TestServer,
    replies: Arc<Mutex<std::collections::VecDeque<String>>>,
    _search: MockServer,
    _dir: tempfile::TempDir,
}

impl Fixture {
    async fn new() -> Self {
        Self::with_judge(CouncilFixture::new()).await
    }

    async fn with_judge(judge: Arc<dyn Judge>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let search = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/search"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "results": [{
                    "title": "Acme identity",
                    "url": "https://example.org/acme",
                    "content": "Acme makes widgets. Jane Smith leads Acme."
                }],
                "unresponsive_engines": []
            })))
            .mount(&search)
            .await;
        let mut cfg = Config::for_workspace(dir.path().to_path_buf());
        cfg.searxng_base_url = Some(search.uri());
        // "test" is not a provider table row, so providers::resolve keeps the
        // fixture LLM instead of rebinding to an unavailable one.
        cfg.llm_provider = "test".into();
        let replies = Arc::new(Mutex::new(std::collections::VecDeque::new()));
        let app = chief_of_rust::Installation::with_connections(
            cfg.clone(),
            Db::open(&cfg.db_path()).unwrap(),
            Arc::new(Replies(replies.clone())),
            judge,
            Arc::new(chief_of_rust::collect::Pacer::system()),
        )
        .app();
        let server = axum_test::TestServer::new(chief_of_rust::routes::router(app.clone()));
        Self {
            app,
            server,
            replies,
            _search: search,
            _dir: dir,
        }
    }

    fn reply(&self, value: Value) {
        self.replies.lock().unwrap().push_back(value.to_string());
    }

    async fn run(&self) {
        assert!(chief_of_rust::work::run_once(&self.app).await.unwrap());
    }

    async fn council_revisions(&self) -> Vec<CouncilRevision> {
        self.app.db().list(COUNCIL_KIND).await.unwrap()
    }
}

fn dossier(kind: &str, marker: &str, existing: Option<&str>) -> Value {
    let headings = if kind == "person" {
        chief_of_rust::research::PERSON_LONG_BRIEF_HEADINGS.as_slice()
    } else {
        chief_of_rust::research::LONG_BRIEF_HEADINGS.as_slice()
    };
    json!({
        "body": headings.iter().map(|h| format!("## {h}\n{marker}. Evidence [s0]; other facts unknown.\n")).collect::<String>(),
        "claims": [],
        "identity": {"outcome":"resolved","existing_id":existing,"explanation":"Attributable identity evidence","references":[{"source_id":"s0","quote":"Acme makes widgets."}],"alternatives":[]},
        "candidates": []
    })
}

// ---------------------------------------------------------------------------
// Seam 3: Council contract — fixture + known artifact
// ---------------------------------------------------------------------------

#[tokio::test]
async fn council_contract_saves_grouped_bounded_revision_with_hashes_and_usage() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = Config::for_workspace(dir.path().to_path_buf());
    let judge = CouncilFixture::new();
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        Db::open(&cfg.db_path()).unwrap(),
        Arc::new(Replies(Arc::new(Mutex::new(
            std::collections::VecDeque::new(),
        )))),
        judge.clone(),
        Arc::new(chief_of_rust::collect::Pacer::system()),
    )
    .app();
    let input = council::ReviewInput {
        artifact_kind: "terminal_report".into(),
        artifact_id: "rep1".into(),
        body: "Acme makes widgets. [r0] Acme is old. [r1]".into(),
        claims: vec![
            council::CouncilClaim {
                id: "c1".into(),
                text: "Acme makes widgets".into(),
                status: "supported".into(),
                source_ids: vec!["r0".into()],
            },
            council::CouncilClaim {
                id: "c2".into(),
                text: "Acme is old".into(),
                status: "supported".into(),
                source_ids: vec!["r1".into()],
            },
        ],
        evidence_ids: vec!["r0".into(), "r1".into()],
        person_id: Some("p1".into()),
    };
    let sources = vec![json!({"id":"r0","title":"Acme page","excerpts":[]})];
    let revision = council::review_and_save(&app, "run-1", &input, &sources)
        .await
        .unwrap();

    // Revision links to the Run and the reviewed artifact revision.
    assert_eq!(revision.run_id, "run-1");
    assert_eq!(revision.id, "terminal_report:rep1:run-1");
    assert_eq!(revision.reviewed.kind, "terminal_report");
    assert_eq!(revision.reviewed.id, "rep1");
    assert_eq!(
        revision.reviewed.body_sha256,
        chief_of_rust::research::content_hash(input.body.as_bytes())
    );
    assert_eq!(revision.reviewed.evidence_sha256.len(), 64);
    assert_eq!(revision.person_id.as_deref(), Some("p1"));
    assert_eq!(revision.artifact_kind, "report");

    // Five fixed reviewers, in fixed order.
    assert_eq!(
        revision.reviewers,
        REVIEWERS.iter().map(|r| r.to_string()).collect::<Vec<_>>()
    );

    // Every claim judged by every reviewer: 5 reviewers x 2 claims = 10.
    assert_eq!(revision.judgments.len(), 10);
    for reviewer in REVIEWERS {
        for claim_id in ["c1", "c2"] {
            let j = revision
                .judgments
                .iter()
                .find(|j| j.reviewer == reviewer && j.claim_id == claim_id)
                .unwrap();
            assert!((j.probability - 0.9).abs() < 1e-9);
            assert!(!j.concern.is_empty());
            assert!(!j.citation_check.is_empty());
        }
    }

    // Provider, model and usage recorded.
    assert_eq!(revision.model, "council-test-fixture");
    assert_eq!(revision.usage.input_tokens, 100);
    assert_eq!(revision.usage.output_tokens, 50);
    assert_eq!(revision.usage.cost_usd, Some(0.001));

    // One bounded request for a small artifact; the split is recorded.
    assert_eq!(revision.request_count, 1);
    assert_eq!(revision.splits.len(), 1);
    assert_eq!(revision.splits[0].index, 0);
    assert_eq!(
        revision.splits[0].claim_ids,
        vec!["c1".to_string(), "c2".to_string()]
    );

    // The request was grouped by reviewer and claim: every question id
    // carries reviewer + claim + aspect.
    let calls = judge.calls();
    assert_eq!(calls.len(), 1);
    let questions = calls[0].1.as_object().unwrap();
    assert_eq!(questions.len(), REVIEWERS.len() * 2 * 3);
    assert!(questions.contains_key("skeptical_analyst_c1_probability"));
    assert!(questions.contains_key("evidence_clerk_c2_citation"));

    // The revision is durable.
    let saved: Option<CouncilRevision> = app.db().get(COUNCIL_KIND, &revision.id).await.unwrap();
    assert!(saved.is_some());
}

#[tokio::test]
async fn council_contract_oversized_input_splits_deterministically_with_every_split_recorded() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = Config::for_workspace(dir.path().to_path_buf());
    let judge = CouncilFixture::new();
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        Db::open(&cfg.db_path()).unwrap(),
        Arc::new(Replies(Arc::new(Mutex::new(
            std::collections::VecDeque::new(),
        )))),
        judge.clone(),
        Arc::new(chief_of_rust::collect::Pacer::system()),
    )
    .app();
    // Many claims with a large body force a deterministic split.
    let claims: Vec<council::CouncilClaim> = (0..40)
        .map(|n| council::CouncilClaim {
            id: format!("c{n}"),
            text: format!("Claim number {n} about Acme. "),
            status: "supported".into(),
            source_ids: vec!["r0".into()],
        })
        .collect();
    let body = "B".repeat(300_000);
    let input = council::ReviewInput {
        artifact_kind: "terminal_report".into(),
        artifact_id: "big".into(),
        body,
        claims,
        evidence_ids: vec!["r0".into()],
        person_id: None,
    };
    let revision = council::review_and_save(&app, "run-big", &input, &[])
        .await
        .unwrap();
    // Oversized: more than one bounded request.
    assert!(
        revision.request_count > 1,
        "oversized input must split: {:?}",
        revision.splits.len()
    );
    assert_eq!(revision.splits.len(), revision.request_count);
    // Every split recorded, indices ascending, claims partition the input.
    let all_claims: Vec<&String> = revision.splits.iter().flat_map(|s| &s.claim_ids).collect();
    assert_eq!(all_claims.len(), 40);
    for (i, split) in revision.splits.iter().enumerate() {
        assert_eq!(split.index, i);
        assert!(split.request_bytes > 0);
    }
    // Deterministic: same input, same splits.
    let revision2 = council::review_and_save(&app, "run-big-2", &input, &[])
        .await
        .unwrap();
    let split_claims_1: Vec<Vec<String>> = revision
        .splits
        .iter()
        .map(|s| s.claim_ids.clone())
        .collect();
    let split_claims_2: Vec<Vec<String>> = revision2
        .splits
        .iter()
        .map(|s| s.claim_ids.clone())
        .collect();
    assert_eq!(
        split_claims_1, split_claims_2,
        "split must be deterministic"
    );
    // Every claim judged by every reviewer across all splits.
    assert_eq!(revision.judgments.len(), REVIEWERS.len() * 40);
    // Each request stayed within the bound.
    let calls = judge.calls();
    for (_, questions) in &calls {
        assert!(
            questions.as_object().unwrap().len() <= 160,
            "bounded request"
        );
    }
}

#[tokio::test]
async fn council_contract_partial_judgment_fails() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = Config::for_workspace(dir.path().to_path_buf());
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        Db::open(&cfg.db_path()).unwrap(),
        Arc::new(Replies(Arc::new(Mutex::new(
            std::collections::VecDeque::new(),
        )))),
        chief_of_rust::judgments::validated(Arc::new(PartialJudge)),
        Arc::new(chief_of_rust::collect::Pacer::system()),
    )
    .app();
    let input = council::ReviewInput {
        artifact_kind: "terminal_report".into(),
        artifact_id: "rep1".into(),
        body: "Acme makes widgets.".into(),
        claims: vec![council::CouncilClaim {
            id: "c1".into(),
            text: "Acme makes widgets".into(),
            status: "supported".into(),
            source_ids: vec!["r0".into()],
        }],
        evidence_ids: vec!["r0".into()],
        person_id: None,
    };
    let result = council::review_and_save(&app, "run-partial", &input, &[]).await;
    assert!(result.is_err(), "a partial judgment must fail the Council");
    // No revision was saved.
    let revisions: Vec<CouncilRevision> = app.db().list(COUNCIL_KIND).await.unwrap();
    assert!(revisions.is_empty());
}

#[tokio::test]
async fn council_contract_non_finite_judgment_fails() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = Config::for_workspace(dir.path().to_path_buf());
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        Db::open(&cfg.db_path()).unwrap(),
        Arc::new(Replies(Arc::new(Mutex::new(
            std::collections::VecDeque::new(),
        )))),
        chief_of_rust::judgments::validated(Arc::new(NonFiniteJudge)),
        Arc::new(chief_of_rust::collect::Pacer::system()),
    )
    .app();
    let input = council::ReviewInput {
        artifact_kind: "terminal_report".into(),
        artifact_id: "rep1".into(),
        body: "Acme makes widgets.".into(),
        claims: vec![council::CouncilClaim {
            id: "c1".into(),
            text: "Acme makes widgets".into(),
            status: "supported".into(),
            source_ids: vec!["r0".into()],
        }],
        evidence_ids: vec!["r0".into()],
        person_id: None,
    };
    let result = council::review_and_save(&app, "run-nonfinite", &input, &[]).await;
    assert!(
        result.is_err(),
        "a non-finite judgment must fail the Council"
    );
}

#[tokio::test]
async fn council_contract_missing_jev_config_fails_with_setup_guidance() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = Config::for_workspace(dir.path().to_path_buf());
    // No Jev key: from_config produces an unavailable judge.
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        Db::open(&cfg.db_path()).unwrap(),
        Arc::new(Replies(Arc::new(Mutex::new(
            std::collections::VecDeque::new(),
        )))),
        chief_of_rust::judgments::from_config(&cfg),
        Arc::new(chief_of_rust::collect::Pacer::system()),
    )
    .app();
    let input = council::ReviewInput {
        artifact_kind: "terminal_report".into(),
        artifact_id: "rep1".into(),
        body: "Acme makes widgets.".into(),
        claims: vec![council::CouncilClaim {
            id: "c1".into(),
            text: "Acme makes widgets".into(),
            status: "supported".into(),
            source_ids: vec!["r0".into()],
        }],
        evidence_ids: vec!["r0".into()],
        person_id: None,
    };
    let result = council::review_and_save(&app, "run-nocfg", &input, &[]).await;
    let error = result.err().unwrap().to_string();
    assert!(
        error.contains("JEV_API_KEY") || error.contains("OPENROUTER_API_KEY"),
        "setup guidance: {error}"
    );
    assert!(
        error.contains("Critical Council"),
        "names the Council: {error}"
    );
}

#[tokio::test]
async fn council_contract_never_mutates_artifact_claims_or_report_text() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = Config::for_workspace(dir.path().to_path_buf());
    let judge = CouncilFixture::new();
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        Db::open(&cfg.db_path()).unwrap(),
        Arc::new(Replies(Arc::new(Mutex::new(
            std::collections::VecDeque::new(),
        )))),
        judge,
        Arc::new(chief_of_rust::collect::Pacer::system()),
    )
    .app();
    // Save a report; the Council reviews it.
    let report = Report {
        id: "rep1".into(),
        question: "What does Acme do?".into(),
        subjects: vec![],
        body: "Acme makes widgets. [r0]".into(),
        sources: vec![chief_of_rust::research::SourceRecord {
            id: "r0".into(),
            entity_id: None,
            title: "Acme page".into(),
            request_url: None,
            source_url: Some("https://example.org/acme".into()),
            retrieved_at: None,
            access_state: chief_of_rust::research::AccessState::Retrieved,
            source_type: chief_of_rust::research::SourceType::IndependentReporting,
            origin: "test".into(),
            transport_status: None,
            content_sha256: None,
            excerpts: vec![],
            inspection_scope: chief_of_rust::research::InspectionScope::FullReturned,
            inspection_details: None,
            notes: String::new(),
        }],
        dossier_snapshots: vec![],
        limitations: vec![],
        run_id: "run-1".into(),
        published_run_id: "run-1".into(),
        created_at: 0,
    };
    let body_before = report.body.clone();
    app.db()
        .put("terminal_report", &report.id, report.clone())
        .await
        .unwrap();
    let input = council::report_input(&report);
    let sources = council::source_state(&report.sources);
    council::review_and_save(&app, "run-1", &input, &sources)
        .await
        .unwrap();
    // The saved report is byte-identical: the Council never mutates it.
    let saved: Report = app
        .db()
        .get("terminal_report", &report.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.body, body_before);
    assert_eq!(saved.body, "Acme makes widgets. [r0]");
    // No claim status changed: the report carries no claim records, and the
    // Council wrote none back.
    assert!(saved.dossier_snapshots.is_empty());
}

#[tokio::test]
async fn council_contract_later_run_adds_revision_without_rewriting_earlier() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = Config::for_workspace(dir.path().to_path_buf());
    let judge = CouncilFixture::new();
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        Db::open(&cfg.db_path()).unwrap(),
        Arc::new(Replies(Arc::new(Mutex::new(
            std::collections::VecDeque::new(),
        )))),
        judge,
        Arc::new(chief_of_rust::collect::Pacer::system()),
    )
    .app();
    let input = council::ReviewInput {
        artifact_kind: "terminal_report".into(),
        artifact_id: "rep1".into(),
        body: "Acme makes widgets.".into(),
        claims: vec![council::CouncilClaim {
            id: "c1".into(),
            text: "Acme makes widgets".into(),
            status: "supported".into(),
            source_ids: vec!["r0".into()],
        }],
        evidence_ids: vec!["r0".into()],
        person_id: None,
    };
    let first = council::review_and_save(&app, "run-1", &input, &[])
        .await
        .unwrap();
    let second = council::review_and_save(&app, "run-2", &input, &[])
        .await
        .unwrap();
    // Two distinct revisions, one per Run.
    assert_ne!(first.id, second.id);
    assert_eq!(first.id, "terminal_report:rep1:run-1");
    assert_eq!(second.id, "terminal_report:rep1:run-2");
    // Both durable; the first was not rewritten.
    let all: Vec<CouncilRevision> = app.db().list(COUNCIL_KIND).await.unwrap();
    assert_eq!(all.len(), 2);
    let first_saved: CouncilRevision = app
        .db()
        .get(COUNCIL_KIND, &first.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first_saved.run_id, "run-1");
    assert_eq!(first_saved.created_at, first.created_at);
}

// ---------------------------------------------------------------------------
// Seam 1: Terminal HTTP — every Run creates a Council revision
// ---------------------------------------------------------------------------

#[tokio::test]
async fn terminal_dossier_run_creates_council_revision_linked_to_run_and_artifact() {
    let f = Fixture::new().await;
    f.reply(dossier("company", "Acme dossier", None));
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "company"), ("name", "Acme")])
        .await
        .assert_status_see_other();
    f.run().await;
    let requests: Vec<chief_of_rust::terminal::automatic::Request> =
        f.app.db().list("terminal_request").await.unwrap();
    let request = requests.last().unwrap();
    let job = chief_of_rust::work::find(f.app.db(), &request.run_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(request.status, "complete", "run error: {:?}", job.error);
    let dossier: Dossier = f
        .app
        .db()
        .list("terminal_dossier")
        .await
        .unwrap()
        .pop()
        .unwrap();
    let revisions = f.council_revisions().await;
    assert_eq!(revisions.len(), 1, "one Council revision per Run");
    let revision = &revisions[0];
    assert_eq!(revision.run_id, dossier.run_id);
    assert_eq!(revision.reviewed.kind, "terminal_dossier");
    assert_eq!(revision.reviewed.id, dossier.id);
    assert_eq!(
        revision.reviewed.body_sha256,
        chief_of_rust::research::content_hash(dossier.body.as_bytes())
    );
    assert_eq!(revision.reviewers.len(), 5);
    assert!(!revision.judgments.is_empty());
    assert_eq!(revision.model, "council-test-fixture");
    // Company dossier: no person link.
    assert_eq!(revision.person_id, None);
}

#[tokio::test]
async fn terminal_person_dossier_council_revision_links_person_for_privacy() {
    let f = Fixture::new().await;
    f.reply(dossier("person", "Jane dossier", None));
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "person"), ("name", "Jane Smith")])
        .await
        .assert_status_see_other();
    f.run().await;
    let dossier: Dossier = f
        .app
        .db()
        .list("terminal_dossier")
        .await
        .unwrap()
        .pop()
        .unwrap();
    let revisions = f.council_revisions().await;
    assert_eq!(revisions.len(), 1);
    // Person dossier: the Council revision links the person for future
    // privacy deletion.
    assert_eq!(
        revisions[0].person_id.as_deref(),
        Some(dossier.subject_id.as_str())
    );
}

#[tokio::test]
async fn terminal_report_run_creates_council_revision() {
    let f = Fixture::new().await;
    // Two subjects: a company and a person, each with a dossier.
    f.reply(dossier("company", "Acme dossier", None));
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "company"), ("name", "Acme")])
        .await
        .assert_status_see_other();
    f.run().await;
    let company = f
        .app
        .db()
        .list::<Company>("company")
        .await
        .unwrap()
        .pop()
        .unwrap();
    f.reply(dossier("person", "Jane dossier", None));
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "person"), ("name", "Jane Smith")])
        .await
        .assert_status_see_other();
    f.run().await;
    let person_id = f
        .app
        .db()
        .list::<chief_of_rust::people::Person>("person")
        .await
        .unwrap()
        .pop()
        .unwrap()
        .id;
    // Two dossier Council revisions so far.
    assert_eq!(f.council_revisions().await.len(), 2);
    // Now a report over both subjects.
    f.reply(json!({"body":"## Findings\nJane Smith leads Acme. [r0]\n## Limits\nOnly public evidence."}));
    let subject1 = format!("company:{}", company.id);
    let subject2 = format!("person:{}", person_id);
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
    let report: Report = f
        .app
        .db()
        .list("terminal_report")
        .await
        .unwrap()
        .pop()
        .unwrap();
    let revisions = f.council_revisions().await;
    assert_eq!(revisions.len(), 3, "report Run adds one Council revision");
    let report_revision = revisions
        .iter()
        .find(|r| r.reviewed.kind == "terminal_report" && r.reviewed.id == report.id)
        .expect("report has a Council revision");
    assert_eq!(report_revision.run_id, report.run_id);
    assert_eq!(
        report_revision.reviewed.body_sha256,
        chief_of_rust::research::content_hash(report.body.as_bytes())
    );
    // Report with a person subject links that person.
    assert_eq!(
        report_revision.person_id.as_deref(),
        Some(person_id.as_str())
    );
    // Report body has sentences reviewed as claims.
    assert!(!report_revision.judgments.is_empty());
}

#[tokio::test]
async fn terminal_missing_jev_config_fails_run_with_setup_guidance() {
    let dir = tempfile::tempdir().unwrap();
    let search = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/search"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "results": [{"title":"Acme","url":"https://example.org/acme","content":"Acme makes widgets."}],
            "unresponsive_engines": []
        })))
        .mount(&search)
        .await;
    let mut cfg = Config::for_workspace(dir.path().to_path_buf());
    cfg.searxng_base_url = Some(search.uri());
    cfg.llm_provider = "test".into();
    let replies = Arc::new(Mutex::new(std::collections::VecDeque::new()));
    // No Jev key configured: from_config produces an unavailable judge.
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        Db::open(&cfg.db_path()).unwrap(),
        Arc::new(Replies(replies.clone())),
        chief_of_rust::judgments::from_config(&cfg),
        Arc::new(chief_of_rust::collect::Pacer::system()),
    )
    .app();
    let server = axum_test::TestServer::new(chief_of_rust::routes::router(app.clone()));
    replies
        .lock()
        .unwrap()
        .push_back(dossier("company", "Acme dossier", None).to_string());
    server
        .post("/terminal/intake")
        .form(&[("kind", "company"), ("name", "Acme")])
        .await
        .assert_status_see_other();
    assert!(chief_of_rust::work::run_once(&app).await.unwrap());
    // The Run failed: the Council is mandatory and cannot run without Jev.
    let requests: Vec<chief_of_rust::terminal::automatic::Request> =
        app.db().list("terminal_request").await.unwrap();
    let request = requests.last().unwrap();
    assert_eq!(request.status, "failed");
    let job = chief_of_rust::work::find(app.db(), &request.run_id)
        .await
        .unwrap()
        .unwrap();
    let error = job.error.unwrap_or_default();
    assert!(
        error.contains("JEV_API_KEY") || error.contains("OPENROUTER_API_KEY"),
        "setup guidance: {error}"
    );
    // No dossier published: the Run failed before publication.
    let dossiers: Vec<Dossier> = app.db().list("terminal_dossier").await.unwrap();
    assert!(
        dossiers.is_empty(),
        "no dossier without its mandatory Council review"
    );
    // No Council revision saved.
    let revisions: Vec<CouncilRevision> = app.db().list(COUNCIL_KIND).await.unwrap();
    assert!(revisions.is_empty());
}

#[tokio::test]
async fn terminal_malformed_fixture_judgment_fails_run_and_prevents_publication() {
    let f = Fixture::with_judge(chief_of_rust::judgments::validated(Arc::new(PartialJudge))).await;
    f.reply(dossier("company", "Acme dossier", None));
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "company"), ("name", "Acme")])
        .await
        .assert_status_see_other();
    f.run().await;
    // The Run failed: a partial judgment is not a pass.
    let requests: Vec<chief_of_rust::terminal::automatic::Request> =
        f.app.db().list("terminal_request").await.unwrap();
    let request = requests.last().unwrap();
    assert_eq!(request.status, "failed");
    let job = chief_of_rust::work::find(f.app.db(), &request.run_id)
        .await
        .unwrap()
        .unwrap();
    let error = job.error.unwrap_or_default();
    assert!(
        error.contains("Critical Council"),
        "names the Council: {error}"
    );
    // No dossier published.
    let dossiers: Vec<Dossier> = f.app.db().list("terminal_dossier").await.unwrap();
    assert!(dossiers.is_empty());
}

#[tokio::test]
async fn terminal_later_run_adds_council_revision_without_rewriting_earlier() {
    let f = Fixture::new().await;
    f.reply(dossier("company", "First dossier", None));
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "company"), ("name", "Acme")])
        .await
        .assert_status_see_other();
    f.run().await;
    let first: Dossier = f
        .app
        .db()
        .list("terminal_dossier")
        .await
        .unwrap()
        .pop()
        .unwrap();
    let revisions = f.council_revisions().await;
    assert_eq!(revisions.len(), 1);
    let first_revision = revisions[0].clone();

    // Refresh: a second Run over the same subject produces a new dossier
    // revision and a new Council revision; the first is never rewritten.
    f.reply(dossier(
        "company",
        "Refreshed dossier",
        Some(&first.subject_id),
    ));
    f.server
        .post(&format!(
            "/terminal/profiles/company/{}/refresh",
            first.subject_id
        ))
        .await
        .assert_status_see_other();
    f.run().await;
    let revisions = f.council_revisions().await;
    assert_eq!(revisions.len(), 2, "a later Run adds a revision");
    // The first revision is unchanged.
    let still_first: CouncilRevision = f
        .app
        .db()
        .get(COUNCIL_KIND, &first_revision.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(still_first.id, first_revision.id);
    assert_eq!(still_first.run_id, first_revision.run_id);
    assert_eq!(still_first.created_at, first_revision.created_at);
    assert_eq!(still_first.judgments.len(), first_revision.judgments.len());
    // The two revisions review different artifact revisions (different run ids).
    assert_ne!(revisions[0].id, revisions[1].id);
}

#[tokio::test]
async fn terminal_council_never_mutates_report_text_or_claim_status() {
    let f = Fixture::new().await;
    f.reply(dossier("company", "Acme dossier", None));
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "company"), ("name", "Acme")])
        .await
        .assert_status_see_other();
    f.run().await;
    let dossier: Dossier = f
        .app
        .db()
        .list("terminal_dossier")
        .await
        .unwrap()
        .pop()
        .unwrap();
    let body_before = dossier.body.clone();
    let claims_before: Vec<(String, String)> = dossier
        .claims
        .iter()
        .map(|c| (c.id.clone(), c.status.as_str().into()))
        .collect();
    // The Council ran during the Run; the saved dossier is unchanged by it.
    assert_eq!(f.council_revisions().await.len(), 1);
    let saved: Dossier = f
        .app
        .db()
        .get(
            "terminal_dossier",
            &format!("company:{}", dossier.subject_id),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        saved.body, body_before,
        "Council never rewrites report text"
    );
    let claims_after: Vec<(String, String)> = saved
        .claims
        .iter()
        .map(|c| (c.id.clone(), c.status.as_str().into()))
        .collect();
    assert_eq!(
        claims_before, claims_after,
        "Council never changes claim status"
    );
}

#[tokio::test]
async fn terminal_comparison_run_creates_council_revision() {
    let f = Fixture::new().await;
    // Two companies with dossiers.
    f.reply(dossier("company", "Acme dossier", None));
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "company"), ("name", "Acme")])
        .await
        .assert_status_see_other();
    f.run().await;
    let first = f
        .app
        .db()
        .list::<Company>("company")
        .await
        .unwrap()
        .pop()
        .unwrap();
    f.reply(dossier("company", "Other dossier", None));
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "company"), ("name", "Other")])
        .await
        .assert_status_see_other();
    f.run().await;
    let companies = f.app.db().list::<Company>("company").await.unwrap();
    let second = companies.iter().find(|c| c.id != first.id).unwrap().clone();
    assert_eq!(f.council_revisions().await.len(), 2);

    // Comparison report body from the LLM.
    f.replies.lock().unwrap().push_back(
        json!({
            "brief": "Acme makes widgets. Other makes tools.",
            "scorecards": {"first": [2, 1, 0], "second": [1, 2, 3]},
            "scorecard_reasons": {"first": ["a", "b", "c"], "second": ["d", "e", "f"]}
        })
        .to_string(),
    );
    f.server
        .post("/terminal/comparisons")
        .form(&[
            ("first_id", first.id.as_str()),
            ("second_id", second.id.as_str()),
            ("workflows", "customer-fit"),
            ("offering", "widgets"),
            ("context", "choosing a vendor"),
        ])
        .await
        .assert_status_see_other();
    f.run().await;
    let revisions = f.council_revisions().await;
    assert_eq!(
        revisions.len(),
        3,
        "comparison Run adds one Council revision"
    );
    let comparison_revision = revisions
        .iter()
        .find(|r| r.reviewed.kind == "comparison_report")
        .expect("comparison report has a Council revision");
    assert_eq!(comparison_revision.artifact_kind, "comparison");
    assert!(!comparison_revision.judgments.is_empty());
    // The comparison report itself is saved.
    let reports: Vec<ComparisonReport> = f.app.db().list("comparison_report").await.unwrap();
    assert_eq!(reports.len(), 1);
    assert_eq!(
        comparison_revision.reviewed.body_sha256,
        chief_of_rust::research::content_hash(reports[0].brief.as_bytes())
    );
}

#[tokio::test]
async fn terminal_brief_run_creates_council_revision() {
    let _env = COLLECTOR_ENV_LOCK.lock().await;
    let providers = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": [{"attributes": {"name": "Acme makes widgets"}}],
            "meta": {"pagination": {"total": 1}}
        })))
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
    let mut cfg = chief_of_rust::Config::for_workspace(dir.path().to_path_buf());
    cfg.llm_provider = "test".into();
    let judge = CouncilFixture::new();
    struct BriefFixture;
    #[async_trait::async_trait]
    impl LlmProvider for BriefFixture {
        fn name(&self) -> &'static str {
            "test"
        }
        async fn complete(&self, _: &str) -> anyhow::Result<String> {
            Ok(json!({
                "brief": "Acme makes widgets. Evidence is limited to registry and news excerpts.",
                "claims": [
                    {"id": "c1", "text": "Acme makes widgets", "source_ids": ["0:gleif_search"], "status": "supported"}
                ]
            })
            .to_string())
        }
    }
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        Db::open(&cfg.db_path()).unwrap(),
        Arc::new(BriefFixture),
        judge,
        Arc::new(chief_of_rust::collect::Pacer::system()),
    )
    .app();
    let server = axum_test::TestServer::new(chief_of_rust::routes::router(app.clone()));
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
    let brief: Brief = app.db().list(BRIEF_KIND).await.unwrap().pop().unwrap();
    let revisions: Vec<CouncilRevision> = app.db().list(COUNCIL_KIND).await.unwrap();
    assert_eq!(revisions.len(), 1, "brief Run creates a Council revision");
    let revision = &revisions[0];
    assert_eq!(revision.run_id, brief.run_id);
    assert_eq!(revision.reviewed.kind, "subject_brief");
    assert_eq!(revision.reviewed.id, brief.id);
    assert_eq!(
        revision.reviewed.body_sha256,
        chief_of_rust::research::content_hash(brief.brief.as_bytes())
    );
    assert_eq!(revision.artifact_kind, "brief");
    // The brief's claim was reviewed by every reviewer.
    assert_eq!(revision.judgments.len(), REVIEWERS.len());
    for judgment in &revision.judgments {
        assert_eq!(judgment.claim_id, "c1");
    }
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
