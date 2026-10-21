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
                // Every other probability question is an error flag except the
                // identity corroboration question (support) and the Council's
                // per-reviewer claim probability.
                "noul" if id == "injection" => json!({"type":"noul","noul":0.0}),
                "noul" if id.ends_with("_probability") => {
                    json!({"type":"noul","noul":0.9})
                }
                "noul" if id.ends_with("_identity") => json!({"type":"noul","noul":1.0}),
                "noul" => json!({"type":"noul","noul":0.0}),
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

/// A judge that omits one answer from the Critical Council request: a
/// partial Council judgment must fail. Earlier evidence-audit requests are
/// answered in full so the Run reaches the Council rather than failing in
/// evidence screening.
struct PartialJudge;

#[async_trait::async_trait]
impl Judge for PartialJudge {
    async fn evaluate(&self, _state: Value, questions: Value) -> anyhow::Result<Evaluation> {
        let mut answers = BTreeMap::new();
        for (id, q) in questions.as_object().unwrap() {
            let answer = match q["type"].as_str().unwrap() {
                "noul" if id == "injection" => json!({"type":"noul","noul":0.0}),
                "noul" if id.ends_with("_probability") => json!({"type":"noul","noul":0.9}),
                "noul" if id.ends_with("_identity") => json!({"type":"noul","noul":1.0}),
                "noul" => json!({"type":"noul","noul":0.0}),
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
        // The Council request carries one `<reviewer>_<claim>_probability`
        // question per reviewer and claim; drop one answer there so the
        // Council sees a partial judgment.
        if answers.keys().any(|id| id.ends_with("_probability"))
            && let Some(last) = answers.keys().next_back().cloned()
        {
            answers.remove(&last);
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

/// A judge where one reviewer materially departs from the others: the
/// dissent must be retained with the full distributions, never averaged.
struct DissentFixture {
    calls: Mutex<Vec<(Value, Value)>>,
}

impl DissentFixture {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            calls: Mutex::new(Vec::new()),
        })
    }
}

#[async_trait::async_trait]
impl Judge for DissentFixture {
    async fn evaluate(&self, state: Value, questions: Value) -> anyhow::Result<Evaluation> {
        self.calls.lock().unwrap().push((state, questions.clone()));
        let mut answers = BTreeMap::new();
        for (id, q) in questions.as_object().unwrap() {
            let answer = match q["type"].as_str().unwrap() {
                "noul" if id == "injection" => json!({"type":"noul","noul":0.0}),
                "noul" if id.ends_with("_probability") => json!({
                    "type":"noul",
                    "noul": if id.starts_with("skeptical_analyst_") { 0.1 } else { 0.9 }
                }),
                "noul" if id.ends_with("_identity") => json!({"type":"noul","noul":1.0}),
                "noul" => json!({"type":"noul","noul":0.0}),
                "choice" => {
                    // A coherent, non-degenerate distribution over every
                    // declared criterion: 0.6 for the selected label, the
                    // remainder spread evenly.
                    let criteria: Vec<&String> =
                        q["criteria"].as_object().unwrap().keys().collect();
                    let selected =
                        if id.starts_with("skeptical_analyst_") && id.ends_with("_concern") {
                            "contradiction"
                        } else {
                            criteria[0].as_str()
                        };
                    let rest = (1.0 - 0.6) / (criteria.len() as f64 - 1.0);
                    let p: serde_json::Map<String, Value> = criteria
                        .iter()
                        .map(|k| {
                            (
                                (*k).clone(),
                                json!(if k.as_str() == selected { 0.6 } else { rest }),
                            )
                        })
                        .collect();
                    let n = criteria.len() as f64;
                    let confidence = (0.6 - 1.0 / n) / (1.0 - 1.0 / n);
                    json!({"type":"choice","choice":selected,"probabilities":p,"confidence":confidence})
                }
                _ => panic!("unexpected question type in dissent fixture"),
            };
            answers.insert(id.clone(), answer);
        }
        Ok(Evaluation {
            model: "dissent-test-fixture".into(),
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
            // The prompt ends `... Input: <identity JSON>. Sources: <sources
            // JSON>`; the identity is terminated by a sentence period, not a
            // comma, so strip that before parsing.
            let input_start = prompt.find("Input: ").unwrap() + 7;
            let sources_start = prompt.rfind("Sources: ").unwrap();
            let input = prompt[input_start..sources_start].trim_end();
            let input = input.strip_suffix('.').unwrap_or(input);
            let identity: Value = serde_json::from_str(input)?;
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
        // TERMINAL_DISCOVERIES: no additional relationship candidates; the
        // fixture dossiers already carry the relationships under test.
        if prompt.starts_with("TERMINAL_DISCOVERIES") {
            return Ok(json!({"candidates":[]}).to_string());
        }
        // TERMINAL_DOSSIER_SECTIONS: write the requested headings with a
        // cited statement each. Only reached when a fixture body is empty.
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
                        json!("Acme makes widgets. [s0] Other details are unknown."),
                    )
                })
                .collect::<serde_json::Map<_, _>>();
            return Ok(json!({"sections":sections}).to_string());
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
        // This suite exercises the Terminal HTTP seam and the Council hook, not
        // collection. Every pending Run is given the same retained evidence
        // snapshot so no public collector is contacted and the fixture
        // dossier's `s0` citations stay valid.
        for request in self
            .app
            .db()
            .list::<chief_of_rust::terminal::automatic::Request>("terminal_request")
            .await
            .unwrap()
            .into_iter()
            .filter(|r| r.status == "researching")
        {
            if self
                .app
                .db()
                .get::<Value>("terminal_collection", &request.id)
                .await
                .unwrap()
                .is_none()
            {
                self.app
                    .db()
                    .put(
                        "terminal_collection",
                        &request.id,
                        json!({
                            "identity": request.identity,
                            "sources": [{
                                "id": "s0",
                                "title": "Acme identity",
                                "source_url": "https://example.org/acme",
                                "access_state": "retrieved",
                                "source_type": "official_record",
                                "origin": "SearXNG",
                                "excerpts": [{"text": "Acme makes widgets. Jane Smith leads Acme."}],
                                "notes": ""
                            }],
                            "coverage": [],
                            "frontier": [],
                            "limitations": [],
                            "created_at": chief_of_rust::now_ms()
                        }),
                    )
                    .await
                    .unwrap();
            }
        }
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
        // One supported claim per dossier: the Council reviews claims, so a
        // fixture body with a citation but no claim record would give it
        // nothing to judge.
        "claims": [{"id":"c1","text":format!("{marker} is supported by the retained source."),"status":"supported","source_ids":["s0"],"contrary_source_ids":[],"topic":"identity","explanation":"Retained evidence"}],
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
        person_ids: vec!["p1".into()],
        subjects: Vec::new(),
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
async fn council_contract_retains_dissent_full_distributions_and_provider() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = Config::for_workspace(dir.path().to_path_buf());
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        Db::open(&cfg.db_path()).unwrap(),
        Arc::new(Replies(Arc::new(Mutex::new(
            std::collections::VecDeque::new(),
        )))),
        DissentFixture::new(),
        Arc::new(chief_of_rust::collect::Pacer::system()),
    )
    .app();
    let input = council::ReviewInput {
        artifact_kind: "terminal_report".into(),
        artifact_id: "rep1".into(),
        body: "Acme makes widgets. [r0]".into(),
        claims: vec![council::CouncilClaim {
            id: "c1".into(),
            text: "Acme makes widgets".into(),
            status: "supported".into(),
            source_ids: vec!["r0".into()],
        }],
        evidence_ids: vec!["r0".into()],
        person_id: None,
        person_ids: Vec::new(),
        subjects: Vec::new(),
    };
    let revision = council::review_and_save(&app, "run-1", &input, &[])
        .await
        .unwrap();

    // Provider, model and usage are stored with the review.
    assert_eq!(revision.provider, "TypeSafe/Jev");
    assert_eq!(revision.model, "dissent-test-fixture");
    assert_eq!(revision.usage.input_tokens, 100);
    assert_eq!(revision.usage.cost_usd, Some(0.001));

    // The exact claims reviewed are snapshotted into the revision, so the
    // result renders without reading a possibly newer artifact.
    assert_eq!(revision.claims.len(), 1);
    assert_eq!(revision.claims[0].id, "c1");
    assert_eq!(revision.claims[0].text, "Acme makes widgets");
    assert_eq!(revision.claims[0].source_ids, vec!["r0".to_string()]);

    // One reviewer departs from the others: that dissent is retained, not
    // averaged away, and every judgment keeps the full distributions its
    // concern and citation labels were chosen from.
    let skeptic = revision
        .judgments
        .iter()
        .find(|j| j.reviewer == "skeptical_analyst")
        .unwrap();
    assert!(
        skeptic.dissent,
        "material departure must be marked as dissent"
    );
    assert!((skeptic.probability - 0.1).abs() < 1e-9);
    assert_eq!(skeptic.concern, "contradiction");
    assert_eq!(skeptic.concern_distribution.len(), 5);
    assert!(
        (skeptic.concern_distribution["contradiction"] - 0.6).abs() < 1e-9,
        "full concern distribution: {:?}",
        skeptic.concern_distribution
    );
    assert!(
        skeptic
            .concern_distribution
            .values()
            .all(|p| *p < skeptic.concern_distribution["contradiction"] + 1e-9)
    );
    assert_eq!(skeptic.citation_distribution.len(), 4);
    for reviewer in REVIEWERS.iter().filter(|r| **r != "skeptical_analyst") {
        let j = revision
            .judgments
            .iter()
            .find(|j| j.reviewer == *reviewer)
            .unwrap();
        assert!(!j.dissent, "{reviewer} agrees with the majority");
        assert!((j.probability - 0.9).abs() < 1e-9);
        assert_eq!(j.concern_distribution.len(), 5);
        assert_eq!(j.citation_distribution.len(), 4);
    }

    // The saved revision round-trips every one of those facts.
    let saved: CouncilRevision = app
        .db()
        .get(COUNCIL_KIND, &revision.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.provider, "TypeSafe/Jev");
    assert_eq!(saved.claims.len(), 1);
    assert_eq!(saved.judgments.len(), REVIEWERS.len());
    assert_eq!(
        saved
            .judgments
            .iter()
            .filter(|j| j.dissent)
            .map(|j| j.reviewer.as_str())
            .collect::<Vec<_>>(),
        vec!["skeptical_analyst"]
    );

    // The rendered result shows the reviewer set, the per-claim judgment,
    // the distributions, retained dissent and the provider/cost boundary.
    let html = council::render(&saved);
    assert!(html.contains("id=\"council\""));
    for label in council::REVIEWER_LABELS {
        assert!(html.contains(label), "missing reviewer {label}");
    }
    assert!(html.contains("0.10"));
    assert!(html.contains("Contradiction"));
    assert!(html.contains("Full distributions and retained dissent"));
    assert!(html.contains("Retained dissent"));
    assert!(html.contains("Skeptical analyst departed from the other reviewers"));
    assert!(html.contains("TypeSafe/Jev"));
    assert!(html.contains("dissent-test-fixture"));
    assert!(html.contains("provider-reported cost $0.001000"));
    assert!(html.contains(council::COST_BOUNDARY));
    assert!(html.contains(&saved.reviewed.body_sha256));
    assert!(html.contains(&saved.reviewed.evidence_sha256));

    // Diagnostics report totals only, never claim text.
    let diagnostic = council::diagnostic(&saved);
    assert_eq!(diagnostic["provider"], "TypeSafe/Jev");
    assert_eq!(diagnostic["cost_text"], "provider-reported cost $0.001000");
    assert!(!diagnostic.to_string().contains("Acme makes widgets"));
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
        person_ids: Vec::new(),
        subjects: Vec::new(),
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
        person_ids: Vec::new(),
        subjects: Vec::new(),
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
        person_ids: Vec::new(),
        subjects: Vec::new(),
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
        person_ids: Vec::new(),
        subjects: Vec::new(),
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
        person_ids: Vec::new(),
        subjects: Vec::new(),
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
async fn terminal_report_page_renders_council_result_and_run_diagnostics_disclose_cost() {
    let f = Fixture::new().await;
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
    f.reply(
        json!({"body":"## Findings\nAcme makes widgets. [r0]\n## Limits\nOnly public evidence."}),
    );
    f.server
        .post("/terminal/reports")
        .form(&[
            ("subject_1", format!("company:{}", company.id).as_str()),
            ("question", "What does Acme do?"),
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
    // The report page shows the Council result beside the report it reviewed.
    let page = f
        .server
        .get(&format!("/terminal/reports/{}", report.id))
        .await
        .assert_status_ok()
        .text();
    assert!(
        page.contains("id=\"council\""),
        "report page shows the Council"
    );
    assert!(page.contains("Critical Council"));
    for label in council::REVIEWER_LABELS {
        assert!(page.contains(label), "reviewer {label} rendered");
    }
    assert!(page.contains("Skeptical analyst"));
    assert!(page.contains("Evidence clerk"));
    assert!(page.contains("Acme makes widgets"));
    // Provider, model, usage, the reviewed hashes and the cost boundary.
    assert!(page.contains("TypeSafe/Jev"));
    assert!(page.contains("council-test-fixture"));
    assert!(page.contains("provider-reported cost $0.001000"));
    assert!(page.contains(council::COST_BOUNDARY));
    assert!(page.contains(&report_council(&f, &report).await.reviewed.body_sha256));
    // The Council is advisory: the report body is unchanged by it.
    assert!(page.contains("Acme makes widgets. [r0]"));
    // Run diagnostics (HTML) disclose the same provider/model/usage/cost.
    let run_page = f
        .server
        .get(&format!("/runs/{}", report.run_id))
        .await
        .assert_status_ok()
        .text();
    assert!(run_page.contains("Critical Council review"));
    assert!(run_page.contains("TypeSafe/Jev"));
    assert!(run_page.contains("provider-reported cost $0.001000"));
    assert!(run_page.contains(council::COST_BOUNDARY));
    // Run diagnostics (JSON) carry the Council totals, not the claim text.
    let diagnostics: Value = f
        .server
        .get(&format!("/runs/{}/diagnostics", report.run_id))
        .await
        .assert_status_ok()
        .json();
    let council = diagnostics["council"].as_array().unwrap();
    assert_eq!(council.len(), 1);
    assert_eq!(council[0]["provider"], "TypeSafe/Jev");
    assert_eq!(council[0]["reviewed"]["kind"], "terminal_report");
    assert_eq!(council[0]["reviewed"]["id"], report.id);
    assert_eq!(council[0]["usage"]["input_tokens"], 100);
    assert_eq!(council[0]["cost_text"], "provider-reported cost $0.001000");
    assert!(!diagnostics.to_string().contains("Acme makes widgets"));
}

async fn report_council(f: &Fixture, report: &Report) -> CouncilRevision {
    f.app
        .db()
        .get(
            COUNCIL_KIND,
            &format!("terminal_report:{}:{}", report.id, report.published_run_id),
        )
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn terminal_person_privacy_deletion_removes_only_that_persons_council_revisions() {
    let f = Fixture::new().await;
    // A company dossier and a person dossier, each with its Council revision.
    f.reply(dossier("company", "Acme dossier", None));
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "company"), ("name", "Acme")])
        .await
        .assert_status_see_other();
    f.run().await;
    f.reply(dossier("person", "Jane dossier", None));
    f.server
        .post("/terminal/intake")
        .form(&[("kind", "person"), ("name", "Jane Smith")])
        .await
        .assert_status_see_other();
    f.run().await;
    let person: chief_of_rust::people::Person =
        f.app.db().list("person").await.unwrap().pop().unwrap();
    // A report over both subjects reviews the person through its subject list.
    f.reply(json!({"body":"## Findings\nJane Smith leads Acme. [r0]"}));
    f.server
        .post("/terminal/reports")
        .form(&[
            ("subject_1", format!("person:{}", person.id).as_str()),
            ("question", "Who is Jane Smith?"),
        ])
        .await
        .assert_status_see_other();
    f.run().await;
    let revisions = f.council_revisions().await;
    assert_eq!(revisions.len(), 3, "two dossiers and one report");
    let person_revisions: Vec<String> = revisions
        .iter()
        .filter(|r| r.person_id.as_deref() == Some(person.id.as_str()))
        .map(|r| r.id.clone())
        .collect();
    assert_eq!(
        person_revisions.len(),
        2,
        "person dossier and person report"
    );
    let company_revisions: Vec<String> = revisions
        .iter()
        .filter(|r| r.person_id.is_none())
        .map(|r| r.id.clone())
        .collect();
    assert_eq!(company_revisions.len(), 1, "company dossier stays");

    f.server
        .post(&format!("/terminal/people/{}/privacy-delete", person.id))
        .form(&[
            ("version", person.version.to_string().as_str()),
            ("acknowledgement", "DELETE"),
        ])
        .await
        .assert_status_see_other();

    // The person's Council revisions are gone; unrelated revisions remain.
    let remaining = f.council_revisions().await;
    assert_eq!(
        remaining.len(),
        1,
        "only the unrelated Council revision remains: {:?}",
        remaining.iter().map(|r| &r.id).collect::<Vec<_>>()
    );
    assert_eq!(remaining[0].id, company_revisions[0]);
    for id in &person_revisions {
        let saved: Option<CouncilRevision> = f.app.db().get(COUNCIL_KIND, id).await.unwrap();
        assert!(
            saved.is_none(),
            "person's Council revision {id} was removed"
        );
    }
    // The revision ledger held no copy either: deletion is not a display filter.
    let ledger: i64 = f
        .app
        .db()
        .transaction(move |tx| {
            Ok(tx.query_row(
                "SELECT COUNT(*) FROM revision WHERE kind='terminal_council'",
                [],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(
        ledger, 1,
        "only the unrelated revision's ledger row remains"
    );
}

#[tokio::test]
async fn company_privacy_deletion_removes_only_that_companys_council_revisions() {
    let f = Fixture::new().await;
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
    let revisions = f.council_revisions().await;
    assert_eq!(revisions.len(), 2);
    let removed = revisions
        .iter()
        .find(|r| r.subjects == vec![format!("company:{}", first.id)])
        .expect("the first company's review names its subject")
        .id
        .clone();
    let kept = revisions
        .iter()
        .find(|r| r.id != removed)
        .expect("the other company's review stays")
        .id
        .clone();

    f.server
        .post(&format!("/terminal/companies/{}/privacy-delete", first.id))
        .form(&[
            ("version", first.version.to_string().as_str()),
            ("acknowledgement", "DELETE"),
        ])
        .await
        .assert_status_see_other();

    // The deleted company's review is gone; the unrelated review and its
    // revision-ledger row remain.
    let remaining = f.council_revisions().await;
    assert_eq!(
        remaining.iter().map(|r| &r.id).collect::<Vec<_>>(),
        vec![&kept]
    );
    let ledger: i64 = f
        .app
        .db()
        .transaction(move |tx| {
            Ok(tx.query_row(
                "SELECT COUNT(*) FROM revision WHERE kind='terminal_council'",
                [],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(ledger, 1);
}

#[tokio::test]
async fn terminal_missing_jev_config_fails_run_with_setup_guidance() {
    // The brief test repoints collector bases through process-global env;
    // hold the same lock so this Run sees the real installation bases.
    let _env = COLLECTOR_ENV_LOCK.lock().await;
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
    // The comparison page renders the same Council result beside the report,
    // so comparison output has one review rule and one place to inspect it.
    let comparison = f
        .app
        .db()
        .list::<chief_of_rust::terminal::comparison::Comparison>("comparison")
        .await
        .unwrap()
        .pop()
        .unwrap();
    let page = f
        .server
        .get(&format!("/terminal/comparisons/{}", comparison.id))
        .await
        .assert_status_ok()
        .text();
    assert!(
        page.contains("id=\"council\""),
        "comparison shows the Council"
    );
    assert!(page.contains("TypeSafe/Jev"));
    assert!(page.contains("provider-reported cost $0.001000"));
    assert!(page.contains(council::COST_BOUNDARY));
    assert!(page.contains(&comparison_revision.reviewed.body_sha256));
}

/// The brief-synthesis LLM fixture: one cited brief for any prompt, so a brief
/// Run reaches its mandatory Council review without a provider.
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

// ---------------------------------------------------------------------------
// Seam 1 (Terminal HTTP): lease redelivery of a persisted Run restores the
// missing mandatory Council review. The durable queue re-queues an
// interrupted attempt under its own id; a worker that died between the
// artifact's publication transaction and the Council's save therefore
// redelivers with the artifact present and the review absent. The early
// returns must not complete such a Run unreviewed.
// ---------------------------------------------------------------------------

/// Simulate the durable queue recovering an interrupted attempt: the Run
/// keeps its id and its lease expires, so the next `run_once` claims it again.
async fn expire_lease(app: &App, run_id: &str) {
    let run_id = run_id.to_owned();
    app.db()
        .transaction(move |tx| {
            tx.execute(
                "UPDATE job SET status='running',lease_until=?2 WHERE id=?1",
                rusqlite::params![run_id, chief_of_rust::now_ms() - 1000],
            )?;
            Ok(())
        })
        .await
        .unwrap();
}

/// A company brief Run against local collector mocks: one cited brief, one
/// Council revision. Returns the app, its HTTP server, the published brief
/// and the live job record for that Run.
async fn brief_run(app: &App, server: &axum_test::TestServer) -> (Brief, chief_of_rust::work::Job) {
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
    assert!(chief_of_rust::work::run_once(app).await.unwrap());
    let brief: Brief = app.db().list(BRIEF_KIND).await.unwrap().pop().unwrap();
    let job = chief_of_rust::work::find(app.db(), &brief.run_id)
        .await
        .unwrap()
        .unwrap();
    (brief, job)
}

#[tokio::test]
async fn redelivered_brief_run_restores_its_missing_council_revision() {
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
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        Db::open(&cfg.db_path()).unwrap(),
        Arc::new(BriefFixture),
        CouncilFixture::new(),
        Arc::new(chief_of_rust::collect::Pacer::system()),
    )
    .app();
    let server = axum_test::TestServer::new(chief_of_rust::routes::router(app.clone()));
    let (brief, job) = brief_run(&app, &server).await;
    assert_eq!(job.status, "done");
    let revisions: Vec<CouncilRevision> = app.db().list(COUNCIL_KIND).await.unwrap();
    assert_eq!(revisions.len(), 1, "the first attempt saved one review");
    assert_eq!(revisions[0].reviewed.kind, "subject_brief");
    assert_eq!(revisions[0].reviewed.id, brief.id);

    // The interruption: the brief is published, the Council revision is not
    // (the worker died between the two writes), and the lease expired.
    app.db()
        .delete(COUNCIL_KIND, &revisions[0].id)
        .await
        .unwrap();
    expire_lease(&app, &job.id).await;

    // The durable queue redelivers the same job id.
    assert!(chief_of_rust::work::run_once(&app).await.unwrap());
    let redelivered = chief_of_rust::work::find(app.db(), &job.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(redelivered.status, "done");
    assert_eq!(redelivered.attempt, 2, "the claim recovered attempt 1");
    let restored: Vec<CouncilRevision> = app.db().list(COUNCIL_KIND).await.unwrap();
    assert_eq!(
        restored.len(),
        1,
        "the redelivered Run restores its mandatory Council revision"
    );
    assert_eq!(restored[0].run_id, brief.run_id);
    assert_eq!(restored[0].reviewed.kind, "subject_brief");
    assert_eq!(restored[0].reviewed.id, brief.id);
    assert_eq!(
        restored[0].reviewed.body_sha256,
        chief_of_rust::research::content_hash(brief.brief.as_bytes())
    );
    // No second brief: the redelivery took the already-published no-op path.
    let briefs: Vec<Brief> = app.db().list(BRIEF_KIND).await.unwrap();
    assert_eq!(briefs.len(), 1);

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

#[tokio::test]
async fn redelivered_report_run_restores_its_missing_council_revision() {
    let f = Fixture::new().await;
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
    f.reply(
        json!({"body":"## Findings\nAcme makes widgets. [r0]\n## Limits\nOnly public evidence."}),
    );
    let subject = format!("company:{}", company.id);
    f.server
        .post("/terminal/reports")
        .form(&[
            ("subject_1", subject.as_str()),
            ("question", "What does Acme do?"),
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
    let before = report_council(&f, &report).await;
    assert_eq!(before.reviewed.kind, "terminal_report");

    // The interruption: the report is published (published_run_id == job.id),
    // the Council revision is not, and the lease expired.
    f.app.db().delete(COUNCIL_KIND, &before.id).await.unwrap();
    expire_lease(&f.app, &report.published_run_id).await;

    // The durable queue redelivers the same job id.
    f.run().await;
    let redelivered = chief_of_rust::work::find(f.app.db(), &report.run_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(redelivered.status, "done");
    assert_eq!(redelivered.attempt, 2, "the claim recovered attempt 1");
    let restored = report_council(&f, &report).await;
    assert_eq!(restored.id, before.id, "the revision is keyed, not new");
    assert_eq!(restored.run_id, report.run_id);
    assert_eq!(restored.reviewed.kind, "terminal_report");
    assert_eq!(restored.reviewed.id, report.id);
    assert_eq!(
        restored.reviewed.body_sha256,
        chief_of_rust::research::content_hash(report.body.as_bytes())
    );
    // The report was not regenerated: still exactly one report record.
    let reports: Vec<Report> = f.app.db().list("terminal_report").await.unwrap();
    assert_eq!(reports.len(), 1);
}
