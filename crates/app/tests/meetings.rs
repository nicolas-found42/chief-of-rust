//! Meeting flows read the durable evidence and proposals behind rendered pages.
use async_trait::async_trait;
use chief_of_rust::{
    App, Config,
    db::Db,
    llm::LlmProvider,
    meetings::{self, Artifact, Meeting, MeetingInput, Transcript, WeeklyReview},
    tasks::{self, ActionItem},
    work,
};
use serde_json::json;
use std::sync::Arc;
use tempfile::TempDir;

mod common;
struct FixtureJudge;
#[async_trait]
impl chief_of_rust::judgments::Judge for FixtureJudge {
    async fn evaluate(
        &self,
        state: serde_json::Value,
        questions: serde_json::Value,
    ) -> anyhow::Result<chief_of_rust::judgments::Evaluation> {
        Ok(common::fixture_evaluation(&state, &questions))
    }
}
struct FixtureLlm;
#[async_trait]
impl LlmProvider for FixtureLlm {
    fn name(&self) -> &'static str {
        "mock"
    }
    async fn complete(&self, prompt: &str) -> anyhow::Result<String> {
        if prompt.contains("ONLY JSON") {
            let source: serde_json::Value =
                serde_json::from_str(prompt.split("DIALOGUE DATA:\n").last().unwrap())?;
            let line = &source["lines"][0];
            Ok(json!({"items":[{"kind":"action","text":"Send the launch checklist","owner":"Nicolas","due":"2026-10-16","due_phrase":null,"evidence":[{"transcript_id":source["transcript_id"],"start_line":line["number"],"end_line":line["number"],"quote":line["text"]}]}]}).to_string())
        } else {
            Ok("Demo fixture: discuss the launch scope and confirm budget.".into())
        }
    }
}
fn app(dir: &TempDir) -> App {
    let cfg = Config::for_workspace(dir.path().to_path_buf());
    let db = Db::open(&cfg.db_path()).unwrap();
    App {
        judge: Arc::new(FixtureJudge),
        cfg,
        db,
        llm: Arc::new(FixtureLlm),
    }
}
fn server(app: &App) -> axum_test::TestServer {
    axum_test::TestServer::new(
        meetings::router()
            .merge(chief_of_rust::people::router())
            .merge(tasks::router())
            .with_state(app.clone()),
    )
}
async fn meeting(app: &App) -> Meeting {
    meetings::create_record(
        &app.db,
        MeetingInput {
            title: "Launch review".into(),
            starts_at: "2026-10-13T14:00:00-04:00".into(),
            attendees: "Nicolas <nicolas@example.com>".into(),
            purpose: "Agree launch scope".into(),
            notes: "Budget is not confirmed".into(),
            revision: None,
        },
    )
    .await
    .unwrap()
}
async fn queued_debrief(app: &App, m: &Meeting, t: &Transcript) -> work::Job {
    work::enqueue(
        &app.db,
        "meetings.debrief",
        &format!("test:{}", t.id),
        json!({"meeting":m,"transcripts":[t]}),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn intake_validates_time_and_persists_escaped_private_notes() {
    let dir = TempDir::new().unwrap();
    let app = app(&dir);
    let server = server(&app);
    let invalid = server
        .post("/meetings")
        .form(&[("title", "Launch"), ("starts_at", "2026-10-13T14:00")])
        .await;
    assert_eq!(invalid.status_code(), 400);
    assert!(app.db.list::<Meeting>("meeting").await.unwrap().is_empty());
    let valid = server
        .post("/meetings")
        .form(&[
            ("title", "Launch <script>"),
            ("starts_at", "2026-10-13T14:00:00-04:00"),
            ("notes", "private <script>alert(1)</script>"),
        ])
        .await;
    assert_eq!(valid.status_code(), 303);
    let m = app
        .db
        .list::<Meeting>("meeting")
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(m.title, "Launch <script>");
    assert_eq!(m.notes, "private <script>alert(1)</script>");
    assert_eq!(m.revision, 1);
    let page = server.get(&format!("/meetings/{}", m.id)).await;
    assert!(
        page.text()
            .contains("private &lt;script&gt;alert(1)&lt;/script&gt;")
    );
    assert!(!page.text().contains("<script>alert(1)</script>"));
    let changed = server
        .post(&format!("/meetings/{}", m.id))
        .form(&[
            ("title", "Launch revised"),
            ("starts_at", "2026-10-13T14:00:00-04:00"),
            ("revision", "1"),
        ])
        .await;
    assert_eq!(changed.status_code(), 303);
    let stale = server
        .post(&format!("/meetings/{}", m.id))
        .form(&[
            ("title", "Lost update"),
            ("starts_at", "2026-10-13T14:00:00-04:00"),
            ("revision", "1"),
        ])
        .await;
    assert_eq!(stale.status_code(), 409);
    let saved = app
        .db
        .get::<Meeting>("meeting", &m.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.title, "Launch revised");
    assert_eq!(saved.revision, 2);
}

#[tokio::test]
async fn title_match_requires_confirmation_and_debrief_review_captures_durable_proposal() {
    let dir = TempDir::new().unwrap();
    let app = app(&dir);
    let server = server(&app);
    let m = meeting(&app).await;
    let upload = server
        .post("/transcripts")
        .form(&[
            ("title", "Launch review transcript"),
            (
                "text",
                "Nicolas: I will send the launch checklist by 2026-10-16.",
            ),
        ])
        .await;
    assert_eq!(upload.status_code(), 303);
    let t = app
        .db
        .list::<Transcript>("transcript")
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(t.meeting_id, None);
    let page = server.get(&format!("/transcripts/{}", t.id)).await;
    assert!(page.text().contains("shared words in title"));
    assert!(
        app.db
            .get::<Transcript>("transcript", &t.id)
            .await
            .unwrap()
            .unwrap()
            .meeting_id
            .is_none()
    );
    let confirmation = server
        .post(&format!("/transcripts/{}/associate", t.id))
        .form(&[("meeting_id", m.id.as_str()), ("revision", "1")])
        .await;
    assert_eq!(confirmation.status_code(), 303);
    let t = app
        .db
        .get::<Transcript>("transcript", &t.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(t.meeting_id, Some(m.id.clone()));
    assert_eq!(t.association, "confirmed by user");
    assert_eq!(t.revision, 2);
    let job = queued_debrief(&app, &m, &t).await;
    assert!(work::run_once(&app).await.unwrap());
    let completed = work::find(&app.db, &job.id).await.unwrap().unwrap();
    assert_eq!(completed.status, "done");
    let a = app
        .db
        .get::<Artifact>("meeting_artifact", &job.id)
        .await
        .unwrap()
        .unwrap();
    assert!(a.body.contains("Send the launch checklist"));
    assert_eq!(a.debrief.as_ref().unwrap().items[0].status, "supported");
    assert_eq!(
        a.debrief.as_ref().unwrap().items[0].evidence[0].quote,
        t.text
    );
    assert_eq!(a.transcript_revisions, vec![(t.id.clone(), 2)]);
    assert_eq!(a.actions[0].due.as_deref(), Some("2026-10-16"));
    assert!(!a.reviewed);
    assert!(
        app.db
            .list::<ActionItem>("action")
            .await
            .unwrap()
            .is_empty()
    );
    let action_id = a.actions[0].id.clone();
    for _ in 0..2 {
        let reviewed = server
            .post(&format!("/meetings/{}/artifacts/{}/review", m.id, a.id))
            .form(&[("selected", action_id.as_str())])
            .await;
        assert_eq!(reviewed.status_code(), 303);
    }
    let actions = app.db.list::<ActionItem>("action").await.unwrap();
    assert_eq!(actions.len(), 1);
    assert_eq!(actions[0].title, "Send the launch checklist");
    assert_eq!(actions[0].meeting_id, m.id);
    assert_eq!(
        actions[0].source_id,
        format!("{}:{}", a.id, a.actions[0].id)
    );
    assert_eq!(actions[0].state, "pending");
    let task = tasks::accept(&app.db, &actions[0].id).await.unwrap();
    assert_eq!(task.title, "Send the launch checklist");
    let deleted = server
        .post(&format!("/transcripts/{}/delete", t.id))
        .form(&[("revision", "2")])
        .await;
    assert_eq!(deleted.status_code(), 303);
    let retained = app
        .db
        .get::<tasks::Task>("task", &task.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retained.source.unwrap().context, a.body);
    let review = server
        .post(&format!("/meetings/{}/artifacts/{}/review", m.id, a.id))
        .form(&[("selected", action_id.as_str())])
        .await;
    assert_eq!(review.status_code(), 409);
}

#[tokio::test]
async fn queued_generation_fails_if_transcript_association_changes() {
    let dir = TempDir::new().unwrap();
    let app = app(&dir);
    let server = server(&app);
    let m = meeting(&app).await;
    let t = meetings::upload_record(
        &app.db,
        "Launch transcript",
        "A decision was discussed.",
        Some(m.id.clone()),
    )
    .await
    .unwrap();
    let job = queued_debrief(&app, &m, &t).await;
    server
        .post(&format!("/transcripts/{}/associate", t.id))
        .form(&[("meeting_id", ""), ("revision", "1")])
        .await
        .assert_status(axum::http::StatusCode::SEE_OTHER);
    assert!(work::run_once(&app).await.unwrap());
    let failed = work::find(&app.db, &job.id).await.unwrap().unwrap();
    assert_eq!(failed.status, "failed");
    assert!(failed.error.unwrap().contains("changed"));
    assert!(
        app.db
            .list::<Artifact>("meeting_artifact")
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn missing_evidence_and_unconsented_imports_do_not_enqueue_work() {
    let dir = TempDir::new().unwrap();
    let app = app(&dir);
    let server = server(&app);
    let m = meeting(&app).await;
    let no_transcript = server
        .post(&format!("/meetings/{}/debrief", m.id))
        .form(&[("revision", "1")])
        .await;
    assert_eq!(no_transcript.status_code(), 400);
    let no_consent = server
        .post("/transcripts/drive")
        .form(&[("consent", "yes")])
        .await;
    assert_eq!(no_consent.status_code(), 400);
    let bad_range = server
        .post("/meetings/weekly")
        .form(&[("from", "2026-10-14"), ("to", "2026-10-13")])
        .await;
    assert_eq!(bad_range.status_code(), 400);
    assert!(work::list(&app.db).await.unwrap().is_empty());
    assert!(
        meetings::enqueue_scheduled(&app, "meetings.drive")
            .await
            .is_err()
    );
}

#[tokio::test]
async fn weekly_review_and_meeting_deletion_preserve_source_history() {
    let dir = TempDir::new().unwrap();
    let app = app(&dir);
    let server = server(&app);
    let m = meeting(&app).await;
    let t = meetings::upload_record(
        &app.db,
        "Launch transcript",
        "Nicolas discussed the launch.",
        Some(m.id.clone()),
    )
    .await
    .unwrap();
    let queued = server
        .post("/meetings/weekly")
        .form(&[("from", "2026-10-12"), ("to", "2026-10-18")])
        .await;
    assert_eq!(queued.status_code(), 303);
    work::run_once(&app).await.unwrap();
    let weekly = app
        .db
        .list::<WeeklyReview>("meeting_weekly")
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(weekly.meeting_ids, vec![m.id.clone()]);
    assert!(weekly.body.contains("Demo fixture"));
    assert_eq!(weekly.from, "2026-10-12");
    let deleted = server
        .post(&format!("/meetings/{}/delete", m.id))
        .form(&[("revision", "1")])
        .await;
    assert_eq!(deleted.status_code(), 303);
    assert!(
        app.db
            .get::<Meeting>("meeting", &m.id)
            .await
            .unwrap()
            .is_none()
    );
    let evidence = app
        .db
        .get::<Transcript>("transcript", &t.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(evidence.meeting_id, None);
    assert_eq!(evidence.text, t.text);
    assert_eq!(evidence.revision, 2);
    let preserved = app
        .db
        .get::<WeeklyReview>("meeting_weekly", &weekly.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(preserved.meeting_ids, vec![m.id]);
}

#[tokio::test]
async fn calendar_reimport_keeps_private_notes_deduplicates_and_rolls_back_bad_batch() {
    let dir = TempDir::new().unwrap();
    let app = app(&dir);
    let event = json!({"id":"event-1","summary":"Launch","description":"Calendar agenda","start":{"dateTime":"2026-10-13T14:00:00-04:00"},"attendees":[{"displayName":"Nicolas","email":"nicolas@example.com"}]});
    meetings::import_calendar_records(&app.db, "primary", vec![event.clone(), event.clone()])
        .await
        .unwrap();
    let meetings = app.db.list::<Meeting>("meeting").await.unwrap();
    assert_eq!(meetings.len(), 1);
    let mut meeting = meetings[0].clone();
    assert_eq!(meeting.attendees, "Nicolas <nicolas@example.com>");
    assert_eq!(meeting.purpose, "Calendar agenda");
    meeting.notes = "Private strategy".into();
    meeting.revision += 1;
    app.db
        .put("meeting", &meeting.id, meeting.clone())
        .await
        .unwrap();
    let changed = json!({"id":"event-1","summary":"Launch moved","start":{"dateTime":"2026-10-14T14:00:00-04:00"}});
    meetings::import_calendar_records(&app.db, "primary", vec![changed])
        .await
        .unwrap();
    let saved = app
        .db
        .get::<Meeting>("meeting", &meeting.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.notes, "Private strategy");
    assert_eq!(saved.title, "Launch moved");
    assert_eq!(saved.revision, 3);
    let valid = json!({"id":"event-2","summary":"Would roll back","start":{"date":"2026-10-15"}});
    let invalid = json!({"id":"event-3","summary":"Invalid","start":{"dateTime":"not a date"}});
    assert!(
        meetings::import_calendar_records(&app.db, "primary", vec![valid, invalid])
            .await
            .is_err()
    );
    assert_eq!(app.db.list::<Meeting>("meeting").await.unwrap().len(), 1);
    meetings::import_calendar_records(
        &app.db,
        "primary",
        vec![json!({"id":"event-1","status":"cancelled"})],
    )
    .await
    .unwrap();
    let cancelled = app
        .db
        .get::<Meeting>("meeting", &meeting.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(cancelled.state, "cancelled");
    assert_eq!(cancelled.notes, "Private strategy");
    assert_eq!(cancelled.revision, 4);
}

#[tokio::test]
async fn queued_drive_import_fails_after_consent_is_revoked_before_network_access() {
    let dir = TempDir::new().unwrap();
    let app = app(&dir);
    let job = work::enqueue(
        &app.db,
        "meetings.drive",
        "revoked",
        json!({"folder_id":"previously-authorized"}),
    )
    .await
    .unwrap();
    work::run_once(&app).await.unwrap();
    let failed = work::find(&app.db, &job.id).await.unwrap().unwrap();
    assert_eq!(failed.status, "failed");
    assert!(failed.error.unwrap().contains("consent"));
    assert!(
        app.db
            .list::<Transcript>("transcript")
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn brief_uses_exact_attendee_identity_and_open_tasks_then_fences_context_changes() {
    let dir = TempDir::new().unwrap();
    let app = app(&dir);
    let server = server(&app);
    let m = meeting(&app).await;
    server
        .post("/people")
        .form(&[
            ("name", "Nicolas"),
            ("email", "nicolas@example.com"),
            ("role", "Founder"),
        ])
        .await
        .assert_status(axum::http::StatusCode::SEE_OTHER);
    server
        .post("/people")
        .form(&[
            ("name", "Nicolas"),
            ("email", "other@example.com"),
            ("role", "Unrelated"),
        ])
        .await
        .assert_status(axum::http::StatusCode::SEE_OTHER);
    let p = app
        .db
        .list::<chief_of_rust::people::Person>("person")
        .await
        .unwrap()
        .into_iter()
        .find(|p| p.email == "nicolas@example.com")
        .unwrap();
    let action = tasks::propose(
        &app.db,
        &m.id,
        "fixture",
        "Check the budget",
        Some("nicolas@example.com".into()),
        None,
        "Explicit source fixture",
    )
    .await
    .unwrap();
    let task = tasks::accept(&app.db, &action.id).await.unwrap();
    server
        .post(&format!("/meetings/{}/brief", m.id))
        .form(&[("revision", "1")])
        .await
        .assert_status(axum::http::StatusCode::SEE_OTHER);
    let job = work::list(&app.db).await.unwrap().pop().unwrap();
    let context = job.input["context_sources"].as_array().unwrap();
    assert_eq!(context.iter().filter(|s| s["kind"] == "person").count(), 1);
    assert!(
        context
            .iter()
            .any(|s| s["id"] == p.id && s["body"]["role"] == "Founder")
    );
    assert!(
        context
            .iter()
            .any(|s| s["id"] == task.id && s["body"]["title"] == "Check the budget")
    );
    server
        .post(&format!("/people/{}", p.id))
        .form(&[
            ("name", "Nicolas"),
            ("email", "nicolas@example.com"),
            ("role", "Revised role"),
            ("version", "1"),
        ])
        .await
        .assert_status(axum::http::StatusCode::SEE_OTHER);
    work::run_once(&app).await.unwrap();
    let failed = work::find(&app.db, &job.id).await.unwrap().unwrap();
    assert_eq!(failed.status, "failed");
    assert!(failed.error.unwrap().contains("changed"));
    server
        .post(&format!("/meetings/{}/brief", m.id))
        .form(&[("revision", "1")])
        .await
        .assert_status(axum::http::StatusCode::SEE_OTHER);
    work::run_once(&app).await.unwrap();
    let artifact = app
        .db
        .list::<Artifact>("meeting_artifact")
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert!(
        artifact
            .context_sources
            .iter()
            .any(|s| s.id == p.id && s.body["role"] == "Revised role")
    );
    assert!(artifact.context_sources.iter().any(|s| s.id == task.id));
    let unreviewed = server
        .post(&format!(
            "/meetings/{}/artifacts/{}/gmail",
            m.id, artifact.id
        ))
        .await;
    assert_eq!(unreviewed.status_code(), 400);
    server
        .post(&format!(
            "/meetings/{}/artifacts/{}/review",
            m.id, artifact.id
        ))
        .form(&[("selected", "")])
        .await
        .assert_status(axum::http::StatusCode::SEE_OTHER);
    let drafted = server
        .post(&format!(
            "/meetings/{}/artifacts/{}/gmail",
            m.id, artifact.id
        ))
        .await;
    assert_eq!(drafted.status_code(), 303);
    let gmail = work::list(&app.db)
        .await
        .unwrap()
        .into_iter()
        .find(|j| j.kind == "meetings.gmail")
        .unwrap();
    assert_eq!(gmail.input["subject"], "brief: Launch review");
    assert_eq!(gmail.input["body"], artifact.body);
}

#[tokio::test]
async fn imported_transcript_deletion_keeps_a_durable_exclusion_until_explicitly_restored() {
    let dir = TempDir::new().unwrap();
    let app = app(&dir);
    let server = server(&app);
    let mut t = meetings::upload_record(&app.db, "Imported transcript", "Evidence", None)
        .await
        .unwrap();
    t.source_id = Some("google-file-1".into());
    app.db.put("transcript", &t.id, t.clone()).await.unwrap();
    server
        .post(&format!("/transcripts/{}/delete", t.id))
        .form(&[("revision", "1")])
        .await
        .assert_status(axum::http::StatusCode::SEE_OTHER);
    let marker = app
        .db
        .get::<serde_json::Value>("transcript_tombstone", "google-file-1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(marker["title"], "Imported transcript");
    assert_eq!(marker["source_id"], "google-file-1");
    let catalog = server.get("/transcripts").await;
    assert!(
        catalog
            .text()
            .contains("Allow this file on the next import")
    );
    server
        .post("/transcripts/allow-reimport")
        .form(&[("source_id", "google-file-1")])
        .await
        .assert_status(axum::http::StatusCode::SEE_OTHER);
    assert!(
        app.db
            .get::<serde_json::Value>("transcript_tombstone", "google-file-1")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        app.db
            .get::<Transcript>("transcript", &t.id)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn gmail_draft_attempt_is_not_duplicated_without_owner_reconciliation() {
    let dir = TempDir::new().unwrap();
    let app = app(&dir);
    let server = server(&app);
    let m = meeting(&app).await;
    server
        .post(&format!("/meetings/{}/brief", m.id))
        .form(&[("revision", "1")])
        .await
        .assert_status(axum::http::StatusCode::SEE_OTHER);
    work::run_once(&app).await.unwrap();
    let artifact = app
        .db
        .list::<Artifact>("meeting_artifact")
        .await
        .unwrap()
        .pop()
        .unwrap();
    server
        .post(&format!(
            "/meetings/{}/artifacts/{}/review",
            m.id, artifact.id
        ))
        .form(&[("selected", "")])
        .await
        .assert_status(axum::http::StatusCode::SEE_OTHER);
    server
        .post(&format!(
            "/meetings/{}/artifacts/{}/gmail",
            m.id, artifact.id
        ))
        .await
        .assert_status(axum::http::StatusCode::SEE_OTHER);
    work::run_once(&app).await.unwrap();
    // Missing configuration failed before create; it is plainly retryable.
    assert!(
        app.db
            .get::<serde_json::Value>("meeting_delivery_intent", &artifact.id)
            .await
            .unwrap()
            .is_none()
    );
    // Separately model a persisted interrupted external create for the
    // reconciliation seam. No remote request is claimed by this fixture.
    app.db
        .put(
            "meeting_delivery_intent",
            &artifact.id,
            serde_json::json!({"artifact_id":artifact.id,"attempted_at":chief_of_rust::now_ms()}),
        )
        .await
        .unwrap();
    let intent = app
        .db
        .get::<serde_json::Value>("meeting_delivery_intent", &artifact.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(intent["artifact_id"], artifact.id);
    assert!(intent["attempted_at"].as_i64().unwrap() > 0);
    assert!(
        app.db
            .get::<serde_json::Value>("meeting_delivery", &artifact.id)
            .await
            .unwrap()
            .is_none()
    );
    let duplicate = server
        .post(&format!(
            "/meetings/{}/artifacts/{}/gmail",
            m.id, artifact.id
        ))
        .await;
    assert_eq!(duplicate.status_code(), 409);
    let no_confirmation = server
        .post(&format!(
            "/meetings/{}/artifacts/{}/gmail/resolve-absent",
            m.id, artifact.id
        ))
        .form(&[("note", "Checked Gmail drafts")])
        .await;
    assert_eq!(no_confirmation.status_code(), 400);
    server
        .post(&format!(
            "/meetings/{}/artifacts/{}/gmail/resolve-absent",
            m.id, artifact.id
        ))
        .form(&[
            ("note", "Checked Gmail drafts; no draft exists"),
            ("confirmed", "yes"),
        ])
        .await
        .assert_status(axum::http::StatusCode::SEE_OTHER);
    assert!(
        app.db
            .get::<serde_json::Value>("meeting_delivery_intent", &artifact.id)
            .await
            .unwrap()
            .is_none()
    );
    let resolution = app
        .db
        .list::<serde_json::Value>("meeting_delivery_resolution")
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(resolution["artifact_id"], artifact.id);
    assert_eq!(resolution["previous_intent"], intent);
    assert_eq!(resolution["note"], "Checked Gmail drafts; no draft exists");
}

#[tokio::test]
async fn stale_weekly_sources_are_rejected_before_any_model_call() {
    struct NeverCalled;
    #[async_trait]
    impl LlmProvider for NeverCalled {
        fn name(&self) -> &'static str {
            "counting-fixture"
        }
        async fn complete(&self, _: &str) -> anyhow::Result<String> {
            panic!("Stale weekly evidence reached the model")
        }
    }
    let dir = TempDir::new().unwrap();
    let mut app = app(&dir);
    app.llm = Arc::new(NeverCalled);
    let m = meeting(&app).await;
    let job = work::enqueue(
        &app.db,
        "meetings.weekly",
        "stale-week",
        json!({"meetings":[m],"artifacts":[],"from":"2026-10-12","to":"2026-10-18"}),
    )
    .await
    .unwrap();
    app.db.delete("meeting", &m.id).await.unwrap();
    let error = meetings::execute(&app, &job).await.unwrap_err().to_string();
    assert!(error.contains("evidence changed"));
    assert!(
        app.db
            .list::<WeeklyReview>("meeting_weekly")
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn meeting_state_selection_round_trips_and_repeated_save_keeps_state() {
    let dir = TempDir::new().unwrap();
    let app = app(&dir);
    let server = server(&app);
    let m = meeting(&app).await;
    let path = format!("/meetings/{}", m.id);
    for state in ["completed", "cancelled", "scheduled"] {
        let current = app
            .db
            .get::<Meeting>("meeting", &m.id)
            .await
            .unwrap()
            .unwrap();
        server
            .post(&format!("{path}/state"))
            .form(&[
                ("revision", current.revision.to_string()),
                ("state", state.to_owned()),
            ])
            .await
            .assert_status_see_other();
        let page = server.get(&path).await.text();
        assert!(page.contains(&format!(
            "<option value=\"{state}\" selected>{state}</option>"
        )));
        let current = app
            .db
            .get::<Meeting>("meeting", &m.id)
            .await
            .unwrap()
            .unwrap();
        server
            .post(&format!("{path}/state"))
            .form(&[
                ("revision", current.revision.to_string()),
                ("state", state.to_owned()),
            ])
            .await
            .assert_status_see_other();
        assert_eq!(
            app.db
                .get::<Meeting>("meeting", &m.id)
                .await
                .unwrap()
                .unwrap()
                .state,
            state
        );
    }
}

#[tokio::test]
async fn draft_history_and_detail_display_saved_workspace_times() {
    let dir = TempDir::new().unwrap();
    let app = app(&dir);
    let server = server(&app);
    let m = meeting(&app).await;
    let id = uuid::Uuid::new_v4().to_string();
    let artifact = Artifact {
        id: id.clone(),
        meeting_id: m.id.clone(),
        kind: "brief".into(),
        debrief: None,
        body: "A saved test brief".into(),
        actions: vec![],
        approved_action_ids: vec![],
        reviewed: false,
        meeting_revision: m.revision,
        transcript_revisions: vec![],
        context_sources: vec![],
        provider: "mock".into(),
        created_at: 1791893978391,
    };
    app.db.put("meeting_artifact", &id, artifact).await.unwrap();
    for path in [
        format!("/meetings/{}", m.id),
        format!("/meetings/{}/artifacts/{id}", m.id),
    ] {
        let html = server.get(&path).await.text();
        assert!(html.contains("2026-10-13 08:19:38 EDT"));
        assert!(html.contains("<time datetime="));
        assert!(!html.contains("1791893978391"));
    }
    let preferences = chief_of_rust::settings::WorkspaceSettings {
        timezone: "UTC".into(),
        ..Default::default()
    };
    app.db
        .put("settings", "workspace", preferences)
        .await
        .unwrap();
    assert!(
        server
            .get(&format!("/meetings/{}", m.id))
            .await
            .text()
            .contains("2026-10-13 12:19:38 UTC")
    );
}
