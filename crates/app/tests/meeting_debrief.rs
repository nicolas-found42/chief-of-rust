//! Real router, durable worker and HTTP provider contracts with labeled fixtures.
mod common;
use chief_of_rust::{
    App, Config,
    db::Db,
    llm,
    meetings::{self, Artifact, MeetingInput},
    tasks::ActionItem,
    work,
};
use serde_json::{Value, json};
use std::sync::Arc;
use wiremock::{
    Mock, MockServer, Request, Respond, ResponseTemplate,
    matchers::{method, path},
};

#[derive(Clone)]
struct JudgmentResponse {
    mode: &'static str,
}
impl Respond for JudgmentResponse {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let body: Value = serde_json::from_slice(&request.body).unwrap();
        let mut e = common::fixture_evaluation(&body["state"], &body["questions"]);
        if self.mode == "screen"
            && let Some(a) = e.answers.get_mut("injection")
        {
            a["noul"] = json!(0.8);
        }
        if matches!(self.mode, "ambiguous" | "overlap")
            && let Some(a) = e.answers.get_mut("support_0")
        {
            *a = json!({"type":"choice","choice":"supports","confidence":0.4,"probabilities":{"supports":0.6,"contradicts":0.2,"unaddressed":0.2}});
        }
        if self.mode == "retraction"
            && let Some(a) = e.answers.get_mut("counter_0")
        {
            a["noul"] = json!(1.0);
        }
        if self.mode == "missing" {
            e.answers.remove("injection");
        }
        if self.mode == "warning" {
            e.warnings.push(json!("fixture context truncated"));
        }
        if self.mode == "outage" {
            return ResponseTemplate::new(429).set_body_string("SECRET_PROVIDER_BODY");
        }
        ResponseTemplate::new(200).set_body_json(json!({"model":e.model,"answers":e.answers,"warnings":e.warnings,"usage":{"input_tokens":30,"output_tokens":20,"cost":0.000001}}))
    }
}
async fn run_case(
    mode: &'static str,
    kind: &str,
    quote: &str,
    text: &str,
) -> (tempfile::TempDir, App, Artifact) {
    let (dir, app, job) = execute_case(mode, kind, quote, text).await;
    let saved = work::find(&app.db, &job).await.unwrap().unwrap();
    assert_eq!(saved.status, "done", "{}", saved.error.unwrap_or_default());
    let artifact = app
        .db
        .get::<Artifact>("meeting_artifact", &job)
        .await
        .unwrap()
        .unwrap();
    (dir, app, artifact)
}
async fn execute_case(
    mode: &'static str,
    kind: &str,
    quote: &str,
    text: &str,
) -> (tempfile::TempDir, App, String) {
    let mock = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = Config::for_workspace(dir.path().into());
    cfg.mistral_api_key = Some("fixture-mistral-key".into());
    cfg.mistral_base_url = Some(mock.uri());
    cfg.openrouter_api_key = Some("fixture-jev-key".into());
    cfg.typesafe_base_url = Some(mock.uri());
    cfg.llm_provider = "mistral".into();
    let app = App {
        db: Db::open(&cfg.db_path()).unwrap(),
        llm: llm::from_config(&cfg),
        judge: chief_of_rust::judgments::from_config(&cfg),
        cfg,
    };
    let m = meetings::create_record(
        &app.db,
        MeetingInput {
            title: "Fixture meeting".into(),
            starts_at: "2026-10-13T14:00:00-04:00".into(),
            attendees: String::new(),
            purpose: String::new(),
            notes: String::new(),
            revision: None,
        },
    )
    .await
    .unwrap();
    let t = meetings::upload_record(&app.db, "Fixture source", text, Some(m.id.clone()))
        .await
        .unwrap();
    let mut draft = json!({"items":[{"kind":kind,"text":"Send the launch checklist","owner":null,"due":null,"due_phrase":null,"evidence":[{"transcript_id":t.id,"start_line":1,"end_line":1,"quote":quote}]}]});
    if matches!(mode, "metadata" | "attribution") {
        draft["items"][0]["owner"] = json!("Alex");
        draft["items"][0]["due"] = json!("2026-10-20");
    }
    if matches!(mode, "overlap" | "attribution" | "duplicate") {
        let mut second = draft["items"][0].clone();
        if mode == "attribution" {
            second["owner"] = json!("Sam");
            second["due"] = json!("2026-10-21");
        }
        draft["items"].as_array_mut().unwrap().push(second);
    }
    Mock::given(method("POST")).and(path("/chat/completions")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"choices":[{"finish_reason":"stop","message":{"content":draft.to_string()}}],"usage":{"prompt_tokens":100,"completion_tokens":50}}))).mount(&mock).await;
    Mock::given(method("POST"))
        .and(path("/v1/systemone"))
        .respond_with(JudgmentResponse { mode })
        .mount(&mock)
        .await;
    let job = work::enqueue(
        &app.db,
        "meetings.debrief",
        "fixture",
        json!({"meeting":m,"transcripts":[t]}),
    )
    .await
    .unwrap();
    work::run_once(&app).await.unwrap();
    // The response and saved records below prove both wire contracts were consumed.
    let requests = mock.received_requests().await.unwrap();
    let judgment_requests = requests
        .iter()
        .filter(|r| r.url.path() == "/v1/systemone")
        .count();
    assert!(judgment_requests >= 1);
    for r in requests.iter().filter(|r| r.url.path() == "/v1/systemone") {
        assert_eq!(
            r.headers.get("authorization").unwrap(),
            "Bearer fixture-jev-key"
        );
        let b: Value = serde_json::from_slice(&r.body).unwrap();
        assert_eq!(b["model"], "typesafe/jev-1.13");
        for item in b["state"]["items"].as_array().into_iter().flatten() {
            assert!(
                item.get("judgments").is_none(),
                "Prior model judgments are not source evidence"
            );
        }
    }
    (dir, app, job.id)
}

#[tokio::test]
async fn cited_debrief_survives_reopen_and_capture_is_reviewed_and_idempotent() {
    let (_dir, app, a) = run_case(
        "metadata",
        "action",
        "Alex: I will send the launch checklist by 2026-10-20.",
        "Alex: I will send the launch checklist by 2026-10-20.",
    )
    .await;
    let d = a.debrief.as_ref().unwrap();
    assert_eq!(d.items.len(), 1);
    assert_eq!(d.items[0].status, "supported");
    assert_eq!(
        d.items[0].evidence[0].quote,
        "Alex: I will send the launch checklist by 2026-10-20."
    );
    assert_eq!(d.generation_usage.input_tokens, 100);
    assert_eq!(d.generation_usage.output_tokens, 50);
    assert_eq!(d.reconciliation.len(), 1);
    assert!(d.judgment_usage.input_tokens > 0);
    assert_eq!(
        a.actions[0].evidence_item_id.as_deref(),
        Some(d.items[0].id.as_str())
    );
    let reopened = Db::open(&app.cfg.db_path())
        .unwrap()
        .get::<Artifact>("meeting_artifact", &a.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        reopened.debrief.unwrap().items[0].evidence[0].quote,
        d.items[0].evidence[0].quote
    );
    assert!(
        app.db
            .list::<ActionItem>("action")
            .await
            .unwrap()
            .is_empty()
    );
    let server = axum_test::TestServer::new(meetings::router().with_state(app.clone()));
    for _ in 0..2 {
        server
            .post(&format!(
                "/meetings/{}/artifacts/{}/review",
                a.meeting_id, a.id
            ))
            .form(&[("selected", a.actions[0].id.as_str())])
            .await
            .assert_status_see_other();
    }
    let proposals = app.db.list::<ActionItem>("action").await.unwrap();
    assert_eq!(proposals.len(), 1);
    assert_eq!(proposals[0].state, "pending");
    assert_eq!(proposals[0].title, "Send the launch checklist");
    assert_eq!(proposals[0].owner.as_deref(), Some("Alex"));
    assert_eq!(proposals[0].due.as_deref(), Some("2026-10-20"));
    assert_eq!(proposals[0].meeting_id, a.meeting_id);
    assert_eq!(
        proposals[0].source_id,
        format!("{}:{}", a.id, a.actions[0].id)
    );
    assert!(proposals[0].context.contains("launch checklist"));
    assert!(
        app.db
            .list::<chief_of_rust::tasks::Task>("task")
            .await
            .unwrap()
            .is_empty()
    );
}
#[tokio::test]
async fn overlap_retains_uncertain_and_supported_records_and_distinct_attribution() {
    let source = "Alex: I will send the launch checklist by 2026-10-20; Sam: I will send the launch checklist by 2026-10-21.";
    for mode in ["overlap", "attribution", "duplicate"] {
        let (_dir, app, a) = run_case(mode, "action", source, source).await;
        let d = a.debrief.as_ref().unwrap();
        assert_eq!(
            d.items.len(),
            2,
            "Every candidate record must survive: {mode}"
        );
        match mode {
            "overlap" => {
                assert_eq!(a.actions.len(), 1);
                assert!(d.items.iter().any(|i| i.status == "needs_review"));
                assert!(d.items.iter().any(|i| i.status == "supported"));
            }
            "attribution" => {
                assert_eq!(d.duplicate_items, 0);
                assert!(d.items.iter().any(|i| i.owner.as_deref() == Some("Alex")
                    && i.due.as_deref() == Some("2026-10-20")));
                assert!(
                    d.items.iter().any(|i| i.owner.as_deref() == Some("Sam")
                        && i.due.as_deref() == Some("2026-10-21"))
                );
                let server = axum_test::TestServer::new(meetings::router().with_state(app.clone()));
                for action in &a.actions {
                    for _ in 0..2 {
                        server
                            .post(&format!(
                                "/meetings/{}/artifacts/{}/review",
                                a.meeting_id, a.id
                            ))
                            .form(&[("selected", action.id.as_str())])
                            .await
                            .assert_status_see_other();
                    }
                }
                let proposals = app.db.list::<ActionItem>("action").await.unwrap();
                assert_eq!(
                    proposals.len(),
                    2,
                    "Distinct supported attributions must remain distinct after capture"
                );
                assert!(proposals.iter().any(|p| p.owner.as_deref() == Some("Alex")
                    && p.due.as_deref() == Some("2026-10-20")));
                assert!(
                    proposals.iter().any(|p| p.owner.as_deref() == Some("Sam")
                        && p.due.as_deref() == Some("2026-10-21"))
                );
            }
            _ => {
                assert_eq!(a.actions.len(), 1);
                assert_eq!(d.duplicate_items, 1);
                let excluded = d.items.iter().find(|i| i.status == "duplicate").unwrap();
                assert!(excluded.judgments["duplicate"]["retained_item_id"].is_string());
                assert_eq!(excluded.evidence[0].quote, source);
            }
        }
    }
}
#[tokio::test]
async fn false_quote_is_retained_as_excluded_and_never_captureable() {
    let (_dir, app, a) = run_case(
        "good",
        "action",
        "I will invent a task.",
        "Alex: We did not agree any task.",
    )
    .await;
    assert_eq!(
        a.debrief.as_ref().unwrap().items[0].status,
        "invalid_citation"
    );
    assert!(a.actions.is_empty());
    let server = axum_test::TestServer::new(meetings::router().with_state(app));
    let page = server
        .get(&format!("/meetings/{}/artifacts/{}", a.meeting_id, a.id))
        .await
        .text();
    assert!(page.contains("invalid_citation"));
    assert!(!page.contains("Capture this action item"));
}
#[tokio::test]
async fn uncertain_or_later_withdrawn_commitments_are_never_actions() {
    for mode in ["ambiguous", "retraction"] {
        let (_dir,_,a)=run_case(mode,"action","Alex: I will send the launch checklist.","Alex: I will send the launch checklist.\nAlex: Actually I cannot commit; wait for approval.").await;
        assert!(a.actions.is_empty());
        let i = &a.debrief.unwrap().items[0];
        assert_ne!(i.status, "supported");
        if mode == "retraction" {
            assert_eq!(i.status, "contradicted");
            assert!(i.judgments.get("cross_segments").is_some());
        }
    }
}
#[tokio::test]
async fn reported_completed_work_does_not_create_or_complete_tasks() {
    let (_dir, app, a) = run_case(
        "good",
        "completed",
        "Alex: I already sent the launch checklist.",
        "Alex: I already sent the launch checklist.",
    )
    .await;
    assert_eq!(a.debrief.as_ref().unwrap().items[0].kind, "completed");
    assert!(a.actions.is_empty());
    assert!(
        app.db
            .list::<ActionItem>("action")
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        app.db
            .list::<chief_of_rust::tasks::Task>("task")
            .await
            .unwrap()
            .is_empty()
    );
}
#[tokio::test]
async fn screen_protocol_warning_and_outage_fail_without_saving_unchecked_artifact() {
    for mode in ["screen", "missing", "warning", "outage"] {
        let (_dir, app, job) = execute_case(
            mode,
            "action",
            "Alex: I will send the launch checklist.",
            "Alex: I will send the launch checklist.",
        )
        .await;
        let j = work::find(&app.db, &job).await.unwrap().unwrap();
        assert_eq!(j.status, "failed");
        assert!(!j.error.unwrap().contains("SECRET_PROVIDER_BODY"));
        assert!(
            app.db
                .list::<Artifact>("meeting_artifact")
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            app.db
                .list::<ActionItem>("action")
                .await
                .unwrap()
                .is_empty()
        );
    }
}
#[tokio::test]
async fn missing_judgment_configuration_fails_with_actionable_message() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = Config::for_workspace(dir.path().into());
    let app = App {
        db: Db::open(&cfg.db_path()).unwrap(),
        llm: Arc::new(llm::MockLlm),
        judge: chief_of_rust::judgments::from_config(&cfg),
        cfg,
    };
    let m = meetings::create_record(
        &app.db,
        MeetingInput {
            title: "Offline".into(),
            starts_at: "2026-10-13T14:00:00Z".into(),
            attendees: String::new(),
            purpose: String::new(),
            notes: String::new(),
            revision: None,
        },
    )
    .await
    .unwrap();
    let t = meetings::upload_record(&app.db, "Source", "Alex: An update.", Some(m.id.clone()))
        .await
        .unwrap();
    let j = work::enqueue(
        &app.db,
        "meetings.debrief",
        "offline",
        json!({"meeting":m,"transcripts":[t]}),
    )
    .await
    .unwrap();
    work::run_once(&app).await.unwrap();
    assert!(
        work::find(&app.db, &j.id)
            .await
            .unwrap()
            .unwrap()
            .error
            .unwrap()
            .contains("OPENROUTER_API_KEY")
    );
    assert!(
        app.db
            .list::<Artifact>("meeting_artifact")
            .await
            .unwrap()
            .is_empty()
    );
}

struct ChangingJudge {
    db: Db,
    source_id: String,
}
#[async_trait::async_trait]
impl chief_of_rust::judgments::Judge for ChangingJudge {
    async fn evaluate(
        &self,
        state: Value,
        questions: Value,
    ) -> anyhow::Result<chief_of_rust::judgments::Evaluation> {
        if questions.get("support_0").is_some() {
            let mut t = self
                .db
                .get::<meetings::Transcript>("transcript", &self.source_id)
                .await?
                .unwrap();
            t.revision += 1;
            t.text
                .push_str("\nSource edited while analysis was running.");
            self.db.put("transcript", &t.id, t.clone()).await?;
        }
        Ok(common::fixture_evaluation(&state, &questions))
    }
}
struct CitedFixture {
    source_id: String,
}
#[async_trait::async_trait]
impl llm::LlmProvider for CitedFixture {
    fn name(&self) -> &'static str {
        "explicit-fixture"
    }
    async fn complete(&self, _: &str) -> anyhow::Result<String> {
        Ok(json!({"items":[{"kind":"action","text":"Send the checklist","owner":null,"due":null,"due_phrase":null,"evidence":[{"transcript_id":self.source_id,"start_line":1,"end_line":1,"quote":"Alex: I will send the checklist."}]}]}).to_string())
    }
}
#[tokio::test]
async fn source_changed_during_semantic_analysis_keeps_attempt_evidence_but_publishes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = Config::for_workspace(dir.path().into());
    let db = Db::open(&cfg.db_path()).unwrap();
    let m = meetings::create_record(
        &db,
        MeetingInput {
            title: "Concurrent edit".into(),
            starts_at: "2026-10-13T14:00:00Z".into(),
            attendees: String::new(),
            purpose: String::new(),
            notes: String::new(),
            revision: None,
        },
    )
    .await
    .unwrap();
    let t = meetings::upload_record(
        &db,
        "Source",
        "Alex: I will send the checklist.",
        Some(m.id.clone()),
    )
    .await
    .unwrap();
    let app = App {
        cfg,
        db: db.clone(),
        llm: Arc::new(CitedFixture {
            source_id: t.id.clone(),
        }),
        judge: Arc::new(ChangingJudge {
            db: db.clone(),
            source_id: t.id.clone(),
        }),
    };
    let j = work::enqueue(
        &db,
        "meetings.debrief",
        "concurrent",
        json!({"meeting":m,"transcripts":[t]}),
    )
    .await
    .unwrap();
    work::run_once(&app).await.unwrap();
    let j = work::find(&db, &j.id).await.unwrap().unwrap();
    assert_eq!(j.status, "failed");
    assert!(j.error.unwrap().contains("changed"));
    assert!(
        db.list::<Artifact>("meeting_artifact")
            .await
            .unwrap()
            .is_empty()
    );
    assert!(db.list::<ActionItem>("action").await.unwrap().is_empty());
    let traces = db.list::<Value>("meeting_debrief_trace").await.unwrap();
    assert!(traces.iter().all(|t| t["run_id"] == j.id));
    assert!(
        traces
            .iter()
            .any(|t| t["phase"] == "Candidate evidence checked")
    );
    let draft = traces
        .iter()
        .find(|t| t["phase"] == "Candidates extracted")
        .unwrap();
    assert!(
        draft["details"]["draft"]
            .as_str()
            .unwrap()
            .contains("Alex: I will send the checklist.")
    );
}
