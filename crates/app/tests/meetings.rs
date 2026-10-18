//! Meeting flows read the durable evidence and proposals behind rendered pages.
use async_trait::async_trait;
use chief_of_rust::{
    App,
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
    chief_of_rust::Installation::for_workspace(dir.path().to_path_buf())
        .app()
        .with_llm(Arc::new(FixtureLlm))
        .with_judge(Arc::new(FixtureJudge))
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
        app.db(),
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
        app.db(),
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
    assert!(
        app.db()
            .list::<Meeting>("meeting")
            .await
            .unwrap()
            .is_empty()
    );
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
        .db()
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
        .db()
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
        .db()
        .list::<Transcript>("transcript")
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(t.meeting_id, None);
    let page = server.get(&format!("/transcripts/{}", t.id)).await;
    assert!(page.text().contains("shared words in title"));
    assert!(
        app.db()
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
        .db()
        .get::<Transcript>("transcript", &t.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(t.meeting_id, Some(m.id.clone()));
    assert_eq!(t.association, "confirmed by user");
    assert_eq!(t.revision, 2);
    let job = queued_debrief(&app, &m, &t).await;
    assert!(work::run_once(&app).await.unwrap());
    let completed = work::find(app.db(), &job.id).await.unwrap().unwrap();
    assert_eq!(completed.status, "done");
    let a = app
        .db()
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
        app.db()
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
    let actions = app.db().list::<ActionItem>("action").await.unwrap();
    assert_eq!(actions.len(), 1);
    assert_eq!(actions[0].title, "Send the launch checklist");
    assert_eq!(actions[0].meeting_id, m.id);
    assert_eq!(
        actions[0].source_id,
        format!("{}:{}", a.id, a.actions[0].id)
    );
    assert_eq!(actions[0].state, "pending");
    let task = tasks::accept(app.db(), &actions[0].id).await.unwrap();
    assert_eq!(task.title, "Send the launch checklist");
    let deleted = server
        .post(&format!("/transcripts/{}/delete", t.id))
        .form(&[("revision", "2")])
        .await;
    assert_eq!(deleted.status_code(), 303);
    let retained = app
        .db()
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
        app.db(),
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
    let failed = work::find(app.db(), &job.id).await.unwrap().unwrap();
    assert_eq!(failed.status, "failed");
    assert!(failed.error.unwrap().contains("changed"));
    assert!(
        app.db()
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
    assert!(work::list(app.db()).await.unwrap().is_empty());
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
        app.db(),
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
        .db()
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
        app.db()
            .get::<Meeting>("meeting", &m.id)
            .await
            .unwrap()
            .is_none()
    );
    let evidence = app
        .db()
        .get::<Transcript>("transcript", &t.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(evidence.meeting_id, None);
    assert_eq!(evidence.text, t.text);
    assert_eq!(evidence.revision, 2);
    let preserved = app
        .db()
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
    meetings::import_calendar_records(app.db(), "primary", vec![event.clone(), event.clone()])
        .await
        .unwrap();
    let meetings = app.db().list::<Meeting>("meeting").await.unwrap();
    assert_eq!(meetings.len(), 1);
    let mut meeting = meetings[0].clone();
    assert_eq!(meeting.attendees, "Nicolas <nicolas@example.com>");
    assert_eq!(meeting.purpose, "Calendar agenda");
    meeting.notes = "Private strategy".into();
    meeting.revision += 1;
    app.db()
        .put("meeting", &meeting.id, meeting.clone())
        .await
        .unwrap();
    let changed = json!({"id":"event-1","summary":"Launch moved","start":{"dateTime":"2026-10-14T14:00:00-04:00"}});
    meetings::import_calendar_records(app.db(), "primary", vec![changed])
        .await
        .unwrap();
    let saved = app
        .db()
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
        meetings::import_calendar_records(app.db(), "primary", vec![valid, invalid])
            .await
            .is_err()
    );
    assert_eq!(app.db().list::<Meeting>("meeting").await.unwrap().len(), 1);
    meetings::import_calendar_records(
        app.db(),
        "primary",
        vec![json!({"id":"event-1","status":"cancelled"})],
    )
    .await
    .unwrap();
    let cancelled = app
        .db()
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
        app.db(),
        "meetings.drive",
        "revoked",
        json!({"folder_id":"previously-authorized"}),
    )
    .await
    .unwrap();
    work::run_once(&app).await.unwrap();
    let failed = work::find(app.db(), &job.id).await.unwrap().unwrap();
    assert_eq!(failed.status, "failed");
    assert!(failed.error.unwrap().contains("consent"));
    assert!(
        app.db()
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
        .post("/terminal/people")
        .form(&[
            ("name", "Nicolas"),
            ("email", "nicolas@example.com"),
            ("role", "Founder"),
        ])
        .await
        .assert_status(axum::http::StatusCode::SEE_OTHER);
    server
        .post("/terminal/people")
        .form(&[
            ("name", "Nicolas"),
            ("email", "other@example.com"),
            ("role", "Unrelated"),
        ])
        .await
        .assert_status(axum::http::StatusCode::SEE_OTHER);
    let p = app
        .db()
        .list::<chief_of_rust::people::Person>("person")
        .await
        .unwrap()
        .into_iter()
        .find(|p| p.email == "nicolas@example.com")
        .unwrap();
    let action = tasks::propose(
        app.db(),
        &m.id,
        "fixture",
        "Check the budget",
        Some("nicolas@example.com".into()),
        None,
        "Explicit source fixture",
    )
    .await
    .unwrap();
    let task = tasks::accept(app.db(), &action.id).await.unwrap();
    server
        .post(&format!("/meetings/{}/brief", m.id))
        .form(&[("revision", "1")])
        .await
        .assert_status(axum::http::StatusCode::SEE_OTHER);
    let job = work::list(app.db()).await.unwrap().pop().unwrap();
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
        .post(&format!("/terminal/people/{}", p.id))
        .form(&[
            ("name", "Nicolas"),
            ("email", "nicolas@example.com"),
            ("role", "Revised role"),
            ("version", "1"),
        ])
        .await
        .assert_status(axum::http::StatusCode::SEE_OTHER);
    work::run_once(&app).await.unwrap();
    let failed = work::find(app.db(), &job.id).await.unwrap().unwrap();
    assert_eq!(failed.status, "failed");
    assert!(failed.error.unwrap().contains("changed"));
    server
        .post(&format!("/meetings/{}/brief", m.id))
        .form(&[("revision", "1")])
        .await
        .assert_status(axum::http::StatusCode::SEE_OTHER);
    work::run_once(&app).await.unwrap();
    let artifact = app
        .db()
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
    let gmail = work::list(app.db())
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
    let mut t = meetings::upload_record(app.db(), "Imported transcript", "Evidence", None)
        .await
        .unwrap();
    t.source_id = Some("google-file-1".into());
    app.db().put("transcript", &t.id, t.clone()).await.unwrap();
    server
        .post(&format!("/transcripts/{}/delete", t.id))
        .form(&[("revision", "1")])
        .await
        .assert_status(axum::http::StatusCode::SEE_OTHER);
    let marker = app
        .db()
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
        app.db()
            .get::<serde_json::Value>("transcript_tombstone", "google-file-1")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        app.db()
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
        .db()
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
        app.db()
            .get::<serde_json::Value>("meeting_delivery_intent", &artifact.id)
            .await
            .unwrap()
            .is_none()
    );
    // Separately model a persisted interrupted external create for the
    // reconciliation seam. No remote request is claimed by this fixture.
    app.db()
        .put(
            "meeting_delivery_intent",
            &artifact.id,
            serde_json::json!({"artifact_id":artifact.id,"attempted_at":chief_of_rust::now_ms()}),
        )
        .await
        .unwrap();
    let intent = app
        .db()
        .get::<serde_json::Value>("meeting_delivery_intent", &artifact.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(intent["artifact_id"], artifact.id);
    assert!(intent["attempted_at"].as_i64().unwrap() > 0);
    assert!(
        app.db()
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
        app.db()
            .get::<serde_json::Value>("meeting_delivery_intent", &artifact.id)
            .await
            .unwrap()
            .is_none()
    );
    let resolution = app
        .db()
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
    app = app.with_llm(Arc::new(NeverCalled));
    let m = meeting(&app).await;
    let job = work::enqueue(
        app.db(),
        "meetings.weekly",
        "stale-week",
        json!({"meetings":[m],"artifacts":[],"from":"2026-10-12","to":"2026-10-18"}),
    )
    .await
    .unwrap();
    app.db().delete("meeting", &m.id).await.unwrap();
    let error = meetings::execute(&app.for_run(&job), &job)
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("evidence changed"));
    assert!(
        app.db()
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
            .db()
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
            .db()
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
            app.db()
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
    app.db()
        .put("meeting_artifact", &id, artifact)
        .await
        .unwrap();
    for path in [
        format!("/meetings/{}", m.id),
        format!("/meetings/{}/artifacts/{id}", m.id),
    ] {
        let html = server.get(&path).await.text();
        assert!(html.contains("Oct 13, 2026 · 08:19 EDT"));
        assert!(html.contains("<time datetime="));
        assert!(!html.contains("1791893978391"));
    }
    let preferences = chief_of_rust::settings::WorkspaceSettings {
        timezone: "UTC".into(),
        ..Default::default()
    };
    app.db()
        .put("settings", "workspace", preferences)
        .await
        .unwrap();
    assert!(
        server
            .get(&format!("/meetings/{}", m.id))
            .await
            .text()
            .contains("Oct 13, 2026 · 12:19 UTC")
    );
}

// Scheduling fixture: exercises the actual worker path; it does not measure model accuracy.
struct DelayedExtraction {
    active: std::sync::atomic::AtomicUsize,
    peak: std::sync::atomic::AtomicUsize,
    calls: std::sync::atomic::AtomicUsize,
    fail_index: Option<u64>,
}
#[async_trait]
impl LlmProvider for DelayedExtraction {
    fn name(&self) -> &'static str {
        "scheduling-fixture"
    }
    async fn complete(&self, prompt: &str) -> anyhow::Result<String> {
        self.complete_schema(prompt, &serde_json::Value::Null).await
    }
    async fn complete_schema(&self, prompt: &str, _: &serde_json::Value) -> anyhow::Result<String> {
        use std::sync::atomic::Ordering::SeqCst;
        struct Active<'a>(&'a std::sync::atomic::AtomicUsize);
        impl Drop for Active<'_> {
            fn drop(&mut self) {
                self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let active = self.active.fetch_add(1, SeqCst) + 1;
        let _active = Active(&self.active);
        self.calls.fetch_add(1, SeqCst);
        self.peak.fetch_max(active, SeqCst);
        let source: serde_json::Value =
            serde_json::from_str(prompt.split("DIALOGUE DATA:\n").last().unwrap())?;
        let index = source["title"].as_str().unwrap().parse::<u64>().unwrap();
        if self.fail_index == Some(index) {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            anyhow::bail!("Simulated provider 429");
        }
        tokio::time::sleep(std::time::Duration::from_millis(120 - index * 10)).await;
        FixtureLlm.complete(prompt).await
    }
}
#[tokio::test]
async fn debrief_overlaps_extraction_but_preserves_source_order_and_checks() {
    use std::sync::atomic::Ordering::SeqCst;
    for mode in [1, 2, 4, 0, 99] {
        let dir = TempDir::new().unwrap();
        let mut app = app(&dir);
        let mut changed = app.cfg().clone();
        changed.meeting_segment_concurrency = mode;
        app = app.with_cfg(changed);
        let llm = Arc::new(DelayedExtraction {
            active: 0.into(),
            peak: 0.into(),
            calls: 0.into(),
            fail_index: None,
        });
        app = app.with_llm(llm.clone());
        let m = meeting(&app).await;
        let mut sources = Vec::new();
        for i in 0..6 {
            sources.push(
                meetings::upload_record(
                    app.db(),
                    &i.to_string(),
                    "Nicolas: I will send the launch checklist by 2026-10-16.",
                    Some(m.id.clone()),
                )
                .await
                .unwrap(),
            );
        }
        let job = work::enqueue(
            app.db(),
            "meetings.debrief",
            "scheduling",
            json!({"meeting":m,"transcripts":sources}),
        )
        .await
        .unwrap();
        let started = std::time::Instant::now();
        work::run_once(&app).await.unwrap();
        assert_eq!(
            work::find(app.db(), &job.id).await.unwrap().unwrap().status,
            "done"
        );
        let artifacts = app.db().list::<Artifact>("meeting_artifact").await.unwrap();
        let d = artifacts[0].debrief.as_ref().unwrap();
        assert_eq!(
            d.segments
                .iter()
                .map(|s| &s.transcript_id)
                .collect::<Vec<_>>(),
            sources.iter().map(|s| &s.id).collect::<Vec<_>>()
        );
        assert_eq!(d.generation_calls, 6);
        assert_eq!(d.items.len(), 6);
        assert!(!d.reconciliation.is_empty());
        let peak = llm.peak.load(SeqCst);
        println!(
            "six segment scheduling: peak={peak} elapsed_ms={}",
            started.elapsed().as_millis()
        );
        assert_eq!(
            peak,
            mode.clamp(1, 4),
            "extraction must respect the configured bound"
        );
        assert_eq!(d.segment_concurrency, mode.clamp(1, 4));
        assert!(d.segment_elapsed_ms > 0);
    }
}

#[tokio::test]
async fn debrief_segment_failure_cancels_siblings_before_returning_and_publishes_nothing() {
    use std::sync::atomic::Ordering::SeqCst;
    let dir = TempDir::new().unwrap();
    let mut app = app(&dir);
    let llm = Arc::new(DelayedExtraction {
        active: 0.into(),
        peak: 0.into(),
        calls: 0.into(),
        fail_index: Some(1),
    });
    app = app.with_llm(llm.clone());
    let m = meeting(&app).await;
    let mut sources = Vec::new();
    for i in 0..8 {
        sources.push(
            meetings::upload_record(
                app.db(),
                &i.to_string(),
                "Nicolas: I will send the launch checklist by 2026-10-16.",
                Some(m.id.clone()),
            )
            .await
            .unwrap(),
        );
    }
    let job = work::enqueue(
        app.db(),
        "meetings.debrief",
        "scheduling-failure",
        json!({"meeting":m,"transcripts":sources}),
    )
    .await
    .unwrap();
    work::run_once(&app).await.unwrap();
    let saved = work::find(app.db(), &job.id).await.unwrap().unwrap();
    assert_eq!(saved.status, "failed");
    assert!(saved.error.unwrap().contains("Simulated provider 429"));
    assert!(
        app.db()
            .list::<Artifact>("meeting_artifact")
            .await
            .unwrap()
            .is_empty()
    );
    let traces = app
        .db()
        .list::<serde_json::Value>("meeting_debrief_trace")
        .await
        .unwrap();
    assert!(
        !traces.is_empty() && traces.len() <= 4,
        "completed screening evidence must survive cancellation"
    );
    let mut seen = std::collections::BTreeSet::new();
    for trace in traces {
        assert_eq!(trace["phase"], "Dialogue screened");
        assert_eq!(trace["run_id"], job.id);
        assert_eq!(trace["attempt"], 1);
        assert_eq!(trace["total_segments"], 8);
        let segment = trace["segment"].as_u64().unwrap() as usize;
        assert!((1..=4).contains(&segment));
        assert!(seen.insert(segment), "screening checkpoints must be unique");
        assert_eq!(trace["details"]["transcript_id"], sources[segment - 1].id);
        assert_eq!(
            trace["details"]["evaluation"]["answers"]["injection"]["noul"],
            0.0
        );
    }
    assert_eq!(
        llm.active.load(SeqCst),
        0,
        "all in-flight provider futures must be dropped before worker returns"
    );
    assert!(
        llm.calls.load(SeqCst) <= 4,
        "pending segments must not start after failure"
    );
}

struct FulfillmentJudge;
#[async_trait]
impl chief_of_rust::judgments::Judge for FulfillmentJudge {
    async fn evaluate(
        &self,
        state: serde_json::Value,
        questions: serde_json::Value,
    ) -> anyhow::Result<chief_of_rust::judgments::Evaluation> {
        let mut result = common::fixture_evaluation(&state, &questions);
        for (id, answer) in &mut result.answers {
            if id.starts_with("fulfilled_") {
                answer["noul"] =
                    json!(if state["dialogue"]["lines"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|l| l["text"]
                            .as_str()
                            .unwrap()
                            .contains("already sent the launch checklist"))
                    {
                        1.0
                    } else {
                        0.0
                    });
            }
        }
        Ok(result)
    }
}
#[tokio::test]
async fn debrief_fulfilled_action_is_not_capturable_and_keeps_source_signal() {
    let dir = TempDir::new().unwrap();
    let mut app = app(&dir);
    app = app.with_judge(Arc::new(FulfillmentJudge));
    let m = meeting(&app).await;
    let promised = meetings::upload_record(
        app.db(),
        "Promise",
        "Nicolas: I will send the launch checklist by 2026-10-16.",
        Some(m.id.clone()),
    )
    .await
    .unwrap();
    let fulfilled = meetings::upload_record(
        app.db(),
        "Later fulfillment",
        "Nicolas: I already sent the launch checklist. Sam: I received it.",
        Some(m.id.clone()),
    )
    .await
    .unwrap();
    let job = work::enqueue(
        app.db(),
        "meetings.debrief",
        "fulfilled-action",
        json!({"meeting":m,"transcripts":[promised,fulfilled]}),
    )
    .await
    .unwrap();
    work::run_once(&app).await.unwrap();
    assert_eq!(
        work::find(app.db(), &job.id).await.unwrap().unwrap().status,
        "done"
    );
    let artifacts = app.db().list::<Artifact>("meeting_artifact").await.unwrap();
    assert!(
        artifacts[0].actions.is_empty(),
        "reported fulfillment must not become an outstanding action proposal"
    );
    let d = artifacts[0].debrief.as_ref().unwrap();
    let item = d
        .items
        .iter()
        .find(|i| i.evidence[0].transcript_id == promised.id)
        .unwrap();
    assert_eq!(item.status, "fulfilled");

    assert!(d.items.iter().filter(|i| i.status == "fulfilled").all(|i| {
        i.judgments["cross_segments"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["transcript_id"] == fulfilled.id && s["fulfilled"]["noul"] == 1.0)
    }));
    assert!(
        app.db()
            .list::<tasks::Task>("task")
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        app.db()
            .list::<tasks::ActionItem>("action")
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn browser_meeting_dates_use_workspace_zone_and_preserve_instants_on_edit() {
    let dir = TempDir::new().unwrap();
    let app = app(&dir);
    let server = server(&app);
    let html = server.get("/meetings").await.text();
    assert!(html.contains("type=\"datetime-local\""));
    assert!(html.contains("name=\"timezone\" type=\"text\" value=\"America/New_York\""));
    server
        .post("/meetings")
        .form(&[
            ("title", "Morning briefing"),
            ("starts_at", "2026-10-16T09:30"),
            ("timezone", "America/New_York"),
        ])
        .await
        .assert_status_see_other();
    let meeting = app
        .db()
        .list::<Meeting>("meeting")
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(meeting.starts_at, "2026-10-16T09:30:00-04:00");
    let path = format!("/meetings/{}", meeting.id);
    let html = server.get(&path).await.text();
    assert!(html.contains("value=\"2026-10-16T09:30:00\""));
    server
        .post(&path)
        .form(&[
            ("title", "Edited briefing"),
            ("starts_at", "2026-10-16T09:30:00"),
            ("timezone", "America/New_York"),
            ("revision", "1"),
        ])
        .await
        .assert_status_see_other();
    let saved = app
        .db()
        .get::<Meeting>("meeting", &meeting.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.starts_at, meeting.starts_at);
    assert_eq!(saved.title, "Edited briefing");
    assert_eq!(saved.revision, 2);
    for (date, zone) in [
        ("2026-03-08T02:30", "America/New_York"),
        ("2026-11-01T01:30", "America/New_York"),
        ("2026-10-16T09:30", "Not/AZone"),
        ("not a date", "UTC"),
    ] {
        server
            .post("/meetings")
            .form(&[
                ("title", "Invalid"),
                ("starts_at", date),
                ("timezone", zone),
            ])
            .await
            .assert_status_bad_request();
    }
    assert_eq!(app.db().list::<Meeting>("meeting").await.unwrap().len(), 1);
    server
        .post("/meetings")
        .form(&[
            ("title", "Winter briefing"),
            ("starts_at", "2026-12-16T09:30"),
            ("timezone", "America/New_York"),
        ])
        .await
        .assert_status_see_other();
    let meetings = app.db().list::<Meeting>("meeting").await.unwrap();
    assert!(
        meetings
            .iter()
            .any(|m| m.starts_at == "2026-12-16T09:30:00-05:00")
    );
}

#[tokio::test]
async fn editing_a_repeated_hour_preserves_the_imported_offset() {
    let dir = TempDir::new().unwrap();
    let app = app(&dir);
    let server = server(&app);
    server
        .post("/meetings")
        .form(&[
            ("title", "Repeated hour"),
            ("starts_at", "2026-11-01T01:30:00-05:00"),
        ])
        .await
        .assert_status_see_other();
    let meeting = app
        .db()
        .list::<Meeting>("meeting")
        .await
        .unwrap()
        .pop()
        .unwrap();
    let path = format!("/meetings/{}", meeting.id);
    let html = server.get(&path).await.text();
    assert!(html.contains("name=\"original_starts_at\" value=\"2026-11-01T01:30:00-05:00\""));
    server
        .post(&path)
        .form(&[
            ("title", "Repeated hour edited"),
            ("starts_at", "2026-11-01T01:30"),
            ("timezone", "America/New_York"),
            ("revision", "1"),
            ("original_starts_at", "2026-11-01T01:30:00-05:00"),
        ])
        .await
        .assert_status_see_other();
    let saved = app
        .db()
        .get::<Meeting>("meeting", &meeting.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.starts_at, meeting.starts_at);
    assert_eq!(saved.title, "Repeated hour edited");
}

#[tokio::test]
async fn meeting_validation_retains_agenda_notes_and_original_revision_for_recovery() {
    let dir = TempDir::new().unwrap();
    let app = app(&dir);
    let server = server(&app);
    let notes = "Conservar notas </textarea><script>alert(1)</script>";
    let response = server
        .post("/meetings")
        .form(&[
            ("title", "Revisión del consejo"),
            ("starts_at", "2026-03-29T02:30"),
            ("timezone", "Europe/Madrid"),
            ("attendees", "Elena; Lucía"),
            ("purpose", "Revisar presupuesto"),
            ("notes", notes),
        ])
        .await;
    response.assert_status_bad_request();
    let html = response.text();
    assert!(html.contains("role=\"alert\""));
    assert!(html.contains("value=\"2026-03-29T02:30\""));
    assert!(html.contains("value=\"Europe/Madrid\""));
    assert!(!html.contains("<script>"));
    let document = scraper::Html::parse_document(&html);
    let selector = scraper::Selector::parse("textarea[name=notes]").unwrap();
    assert_eq!(
        document
            .select(&selector)
            .next()
            .unwrap()
            .text()
            .collect::<String>(),
        notes
    );
    assert!(
        app.db()
            .list::<Meeting>("meeting")
            .await
            .unwrap()
            .is_empty()
    );
    server
        .post("/meetings")
        .form(&[
            ("title", "Revisión del consejo"),
            ("starts_at", "2026-03-29T03:30"),
            ("timezone", "Europe/Madrid"),
            ("attendees", "Elena; Lucía"),
            ("purpose", "Revisar presupuesto"),
            ("notes", notes),
        ])
        .await
        .assert_status_see_other();
    let meeting = app
        .db()
        .list::<Meeting>("meeting")
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(meeting.starts_at, "2026-03-29T03:30:00+02:00");
    assert_eq!(meeting.notes, notes);
    assert_eq!(meeting.attendees, "Elena; Lucía");
    assert_eq!(meeting.purpose, "Revisar presupuesto");
    let path = format!("/meetings/{}", meeting.id);
    let response = server
        .post(&path)
        .form(&[
            ("title", "   "),
            ("starts_at", "2026-03-29T03:30"),
            ("timezone", "Europe/Madrid"),
            ("revision", "1"),
            ("notes", "New notes to retain"),
        ])
        .await;
    response.assert_status_bad_request();
    assert!(response.text().contains("New notes to retain"));
    assert!(response.text().contains("name=\"revision\" value=\"1\""));
    assert_eq!(
        app.db()
            .get::<Meeting>("meeting", &meeting.id)
            .await
            .unwrap()
            .unwrap()
            .notes,
        notes
    );
    server
        .post(&path)
        .form(&[
            ("title", "Corrected meeting"),
            ("starts_at", "2026-03-29T03:30"),
            ("timezone", "Europe/Madrid"),
            ("revision", "1"),
            ("notes", "New notes to retain"),
        ])
        .await
        .assert_status_see_other();
    let response = server
        .post(&path)
        .form(&[
            ("title", "Other tab"),
            ("starts_at", "2026-03-29T03:30"),
            ("timezone", "Europe/Madrid"),
            ("revision", "1"),
            ("notes", "Stale draft to copy"),
        ])
        .await;
    response.assert_status_conflict();
    assert!(response.text().contains("Stale draft to copy"));
    assert!(response.text().contains("name=\"revision\" value=\"1\""));
    assert!(response.text().contains("Reload saved meeting"));
    let saved = app
        .db()
        .get::<Meeting>("meeting", &meeting.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.notes, "New notes to retain");
    assert_eq!(saved.title, "Corrected meeting");
    assert_eq!(saved.revision, 2);
}
