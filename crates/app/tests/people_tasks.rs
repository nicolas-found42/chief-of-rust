use async_trait::async_trait;
use chief_of_rust::{
    App,
    db::Db,
    llm::LlmProvider,
    people::{Dossier, Evidence, Person},
    tasks::{self, ActionItem, Task},
    work,
};
use serde_json::json;
use std::sync::Arc;

struct Reply(String);
#[async_trait]
impl LlmProvider for Reply {
    fn name(&self) -> &'static str {
        "test"
    }
    async fn complete(&self, _: &str) -> anyhow::Result<String> {
        Ok(self.0.clone())
    }
}
fn app(dir: &tempfile::TempDir) -> App {
    chief_of_rust::Installation::for_workspace(dir.path().to_path_buf())
        .app()
        .with_llm(Arc::new(Reply("{}".into())))
}
fn server(app: &App) -> axum_test::TestServer {
    axum_test::TestServer::new(
        chief_of_rust::people::router()
            .merge(tasks::router())
            .with_state(app.clone()),
    )
}

#[tokio::test]
async fn action_acceptance_is_atomic_idempotent_and_independent_of_sources() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let action = tasks::propose(
        app.db(),
        "meeting-a",
        "debrief-a",
        "Send proposal",
        Some("Sam".into()),
        Some("2026-11-02".into()),
        "Sam promised to send a proposal.",
    )
    .await
    .unwrap();
    let same = tasks::propose(
        app.db(),
        "meeting-a",
        "debrief-a",
        " send proposal ",
        None,
        None,
        "",
    )
    .await
    .unwrap();
    assert_eq!(same.id, action.id);
    let (first, second) = tokio::join!(
        tasks::accept(app.db(), &action.id),
        tasks::accept(app.db(), &action.id)
    );
    let first = first.unwrap();
    assert_eq!(first.id, second.unwrap().id);
    assert_eq!(app.db().list::<Task>("task").await.unwrap().len(), 1);
    app.db().delete("action", &action.id).await.unwrap();
    app.db().delete("meeting", "meeting-a").await.unwrap();
    let reopened = Db::open(&app.cfg().db_path()).unwrap();
    let task: Task = reopened.get("task", &first.id).await.unwrap().unwrap();
    assert_eq!(task.owner, "Sam");
    assert_eq!(
        task.source.unwrap().context,
        "Sam promised to send a proposal."
    );
}
#[tokio::test]
async fn dismissal_needs_undo_before_acceptance() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let server = server(&app);
    let action = tasks::propose(app.db(), "m", "s", "Reply", None, None, "")
        .await
        .unwrap();
    server
        .post(&format!("/actions/{}/dismiss", action.id))
        .await
        .assert_status_see_other();
    assert!(tasks::accept(app.db(), &action.id).await.is_err());
    server
        .post(&format!("/actions/{}/undo", action.id))
        .await
        .assert_status_see_other();
    tasks::accept(app.db(), &action.id).await.unwrap();
    let a: ActionItem = app.db().get("action", &action.id).await.unwrap().unwrap();
    assert_eq!(a.state, "accepted");
}
#[tokio::test]
async fn person_identity_conflicts_and_stale_forms_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let server = server(&app);
    server
        .post("/terminal/people")
        .form(&[("name", "Pat"), ("email", "pat@example.com")])
        .await
        .assert_status_see_other();
    server
        .post("/terminal/people")
        .form(&[("name", "Duplicate"), ("email", "PAT@example.com")])
        .await
        .assert_status_conflict();
    let p = app
        .db()
        .list::<Person>("person")
        .await
        .unwrap()
        .pop()
        .unwrap();
    server
        .post(&format!("/terminal/people/{}", p.id))
        .form(&[
            ("name", "Pat corrected"),
            ("email", "pat@example.com"),
            ("version", "1"),
        ])
        .await
        .assert_status_see_other();
    server
        .post(&format!("/terminal/people/{}", p.id))
        .form(&[("name", "Lost update"), ("version", "1")])
        .await
        .assert_status_conflict();
    let current: Person = app.db().get("person", &p.id).await.unwrap().unwrap();
    assert_eq!(current.name, "Pat corrected");
    server
        .post(&format!("/terminal/people/{}/archive", p.id))
        .await
        .assert_status_see_other();
    server
        .post(&format!("/terminal/people/{}/evidence", p.id))
        .form(&[
            ("title", "Source"),
            ("text", "Evidence"),
            ("kind", "manual"),
        ])
        .await
        .assert_status_conflict();
    server
        .post(&format!("/terminal/people/{}/restore", p.id))
        .await
        .assert_status_see_other();
}
#[tokio::test]
async fn merge_moves_evidence_but_preserves_conflicting_identity_in_audit_note() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let server = server(&app);
    server
        .post("/terminal/people")
        .form(&[("name", "Pat"), ("role", "CEO")])
        .await
        .assert_status_see_other();
    server
        .post("/terminal/people")
        .form(&[("name", "Patrick"), ("role", "Founder")])
        .await
        .assert_status_see_other();
    let people = app.db().list::<Person>("person").await.unwrap();
    let canonical = people.iter().find(|p| p.name == "Pat").unwrap();
    let duplicate = people.iter().find(|p| p.name == "Patrick").unwrap();
    server
        .post(&format!("/terminal/people/{}/evidence", duplicate.id))
        .form(&[
            ("title", "Record"),
            ("text", "Patrick founded Acme."),
            ("kind", "public"),
            ("url", "https://example.com/profile"),
        ])
        .await
        .assert_status_see_other();
    server
        .post(&format!("/terminal/people/{}/merge", canonical.id))
        .form(&[("duplicate_id", duplicate.id.as_str()), ("version", "1")])
        .await
        .assert_status_see_other();
    let p: Person = app
        .db()
        .get("person", &canonical.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(p.role, "CEO");
    assert!(p.notes.contains("Founder"));
    let d: Person = app
        .db()
        .get("person", &duplicate.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(d.merged_into, Some(p.id.clone()));
    assert_eq!(
        app.db().list::<Evidence>("person_evidence").await.unwrap()[0].person_id,
        p.id
    );
    server
        .post(&format!("/terminal/people/{}/restore", d.id))
        .await
        .assert_status_conflict();
}
async fn research_fixture(app: &App) -> (Person, Evidence) {
    let p = Person {
        id: "p".into(),
        name: "Pat".into(),
        email: "".into(),
        role: "".into(),
        company: "Acme".into(),
        notes: "".into(),
        profile_url: "".into(),
        archived: false,
        merged_into: None,
        version: 1,
        created_at: 0,
        updated_at: 0,
    };
    let e = Evidence {
        id: "source-1".into(),
        person_id: p.id.clone(),
        title: "Acme profile".into(),
        url: "https://example.com/pat".into(),
        text: "Pat joined Acme in 2024.".into(),
        kind: "public".into(),
        created_at: 0,
    };
    app.db().put("person", &p.id, p.clone()).await.unwrap();
    app.db()
        .put("person_evidence", &e.id, e.clone())
        .await
        .unwrap();
    (p, e)
}
#[tokio::test]
async fn dossiers_require_exact_evidence_and_stale_research_cannot_replace_good_revision() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = app(&dir);
    let (p, e) = research_fixture(&app).await;
    let mut job = work::enqueue(
        app.db(),
        "people.research",
        "research-1",
        json!({"person":p,"evidence":[e],"question":"When did Pat join?","search":false}),
    )
    .await
    .unwrap();
    app = app.with_llm(Arc::new(Reply(json!({"claims":[{"text":"Acme joining date","source_id":"source-1","quote":"Pat joined Acme in 2024."}],"unknowns":[]}).to_string())));
    chief_of_rust::people::execute(&app, &job).await.unwrap();
    assert_eq!(app.db().list::<Dossier>("dossier").await.unwrap().len(), 1);
    job.id = "invalid-research".into();
    app = app.with_llm(Arc::new(Reply(json!({"claims":[{"text":"Wrong","source_id":"source-1","quote":"Pat was CEO in 2020."}],"unknowns":[]}).to_string())));
    assert!(chief_of_rust::people::execute(&app, &job).await.is_err());
    assert_eq!(app.db().list::<Dossier>("dossier").await.unwrap().len(), 1);
    app = app.with_llm(Arc::new(Reply(
        json!({"claims":[],"unknowns":["No information"]}).to_string(),
    )));
    let mut changed = p;
    changed.version += 1;
    app.db()
        .put("person", &changed.id, changed.clone())
        .await
        .unwrap();
    assert!(chief_of_rust::people::execute(&app, &job).await.is_err());
    assert_eq!(app.db().list::<Dossier>("dossier").await.unwrap().len(), 1);
}
#[tokio::test]
async fn task_edit_rejects_invalid_due_dates_and_stale_versions() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let server = server(&app);
    server
        .post("/tasks")
        .form(&[("title", "Work")])
        .await
        .assert_status_see_other();
    let task = app.db().list::<Task>("task").await.unwrap().pop().unwrap();
    let path = format!("/tasks/{}", task.id);
    server
        .post(&path)
        .form(&[
            ("title", "Work"),
            ("version", "1"),
            ("priority", "high"),
            ("status", "open"),
            ("due", "2026-99-01"),
        ])
        .await
        .assert_status_bad_request();
    server
        .post(&path)
        .form(&[
            ("title", "Updated"),
            ("version", "1"),
            ("priority", "urgent"),
            ("status", "in_progress"),
            ("due", "2026-12-01"),
        ])
        .await
        .assert_status_see_other();
    server
        .post(&path)
        .form(&[
            ("title", "Stale"),
            ("version", "1"),
            ("priority", "normal"),
            ("status", "open"),
        ])
        .await
        .assert_status_conflict();
    server
        .post(&format!("{path}/trash"))
        .await
        .assert_status_see_other();
    assert!(
        app.db()
            .get::<Task>("task", &task.id)
            .await
            .unwrap()
            .unwrap()
            .trashed
    );
    server
        .post(&format!("{path}/restore"))
        .await
        .assert_status_see_other();
    assert!(
        !app.db()
            .get::<Task>("task", &task.id)
            .await
            .unwrap()
            .unwrap()
            .trashed
    );
}

#[tokio::test]
async fn remote_jobs_reject_stale_or_uncertain_local_state_before_any_network_call() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let server = server(&app);
    server
        .post("/tasks")
        .form(&[("title", "Keep local")])
        .await
        .assert_status_see_other();
    let mut task = app.db().list::<Task>("task").await.unwrap().pop().unwrap();
    let job = work::enqueue(
        app.db(),
        "tasks.sync",
        "delivery",
        json!({"task":task,"provider":"google","container":"list"}),
    )
    .await
    .unwrap();
    task.version += 1;
    app.db().put("task", &task.id, task.clone()).await.unwrap();
    let error = tasks::execute(&app, &job).await.unwrap_err();
    assert!(error.to_string().contains("changed"));
    assert!(
        app.db()
            .get::<Task>("task", &task.id)
            .await
            .unwrap()
            .unwrap()
            .links
            .is_empty()
    );
    task.version -= 1;
    task.links.push(tasks::ExternalLink {
        provider: "google".into(),
        container: "list".into(),
        remote_id: None,
        state: "uncertain".into(),
        google_binding: None,
        error: None,
        synced_version: None,
    });
    app.db().put("task", &task.id, task.clone()).await.unwrap();
    let error = tasks::execute(&app, &job).await.unwrap_err();
    assert!(error.to_string().contains("reconciliation"));
    server
        .post(&format!("/tasks/{}/link", task.id))
        .form(&[("provider", "google"), ("container", "list")])
        .await
        .assert_status_conflict();
}

#[tokio::test]
async fn privacy_delete_requires_acknowledgement_and_purges_removed_evidence_history_and_jobs_but_keeps_tasks()
 {
    let dir = tempfile::tempdir().unwrap();
    let mut app = app(&dir);
    let (p, e) = research_fixture(&app).await;
    let server = server(&app);
    let job = work::enqueue(
        app.db(),
        "people.research",
        "privacy-research",
        json!({"person":p,"evidence":[e],"question":"When did Pat join?","search":false}),
    )
    .await
    .unwrap();
    app = app.with_llm(Arc::new(Reply(json!({"claims":[{"text":"Source","source_id":"source-1","quote":"Pat joined Acme in 2024."}],"unknowns":[]}).to_string())));
    chief_of_rust::people::execute(&app, &job).await.unwrap();
    server
        .post("/terminal/people/p/evidence/source-1")
        .await
        .assert_status_see_other();
    let action = tasks::propose(
        app.db(),
        "m",
        "s",
        "Send Pat a proposal",
        Some("Pat".into()),
        None,
        "Promised at a meeting.",
    )
    .await
    .unwrap();
    let task = tasks::accept(app.db(), &action.id).await.unwrap();
    server
        .post("/terminal/people/p/privacy-delete")
        .form(&[("version", "2"), ("acknowledgement", "yes")])
        .await
        .assert_status_bad_request();
    server
        .post("/terminal/people/p/privacy-delete")
        .form(&[("version", "1"), ("acknowledgement", "DELETE")])
        .await
        .assert_status_conflict();
    server
        .post("/terminal/people/p/privacy-delete")
        .form(&[("version", "2"), ("acknowledgement", "DELETE")])
        .await
        .assert_status_see_other();
    assert!(
        app.db()
            .get::<Person>("person", "p")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        app.db()
            .list::<Dossier>("dossier")
            .await
            .unwrap()
            .is_empty()
    );
    assert!(work::find(app.db(), &job.id).await.unwrap().is_none());
    assert!(
        app.db()
            .get::<Task>("task", &task.id)
            .await
            .unwrap()
            .is_some()
    );
    let remaining:i64=app.db().transaction(|tx|Ok(tx.query_row("SELECT COUNT(*) FROM revision WHERE kind IN ('person','person_evidence','dossier')",[],|r|r.get(0))?)).await.unwrap();
    assert_eq!(remaining, 0);
    assert!(chief_of_rust::people::execute(&app, &job).await.is_err());
}
#[tokio::test]
async fn remote_absence_resolution_requires_explicit_confirmation_and_fences_old_jobs() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let server = server(&app);
    server
        .post("/tasks")
        .form(&[("title", "Delivery")])
        .await
        .assert_status_see_other();
    let mut task = app.db().list::<Task>("task").await.unwrap().pop().unwrap();
    task.links.push(tasks::ExternalLink {
        provider: "google".into(),
        container: "list".into(),
        remote_id: None,
        state: "uncertain".into(),
        google_binding: None,
        error: None,
        synced_version: None,
    });
    app.db().put("task", &task.id, task.clone()).await.unwrap();
    let path = format!("/tasks/{}/resolve-absent", task.id);
    server
        .post(&path)
        .form(&[("provider", "google"), ("note", "Checked task list")])
        .await
        .assert_status_bad_request();
    server
        .post(&path)
        .form(&[
            ("provider", "google"),
            ("note", "Checked all tasks and confirmed no create"),
            ("confirmed", "true"),
        ])
        .await
        .assert_status_see_other();
    let current: Task = app.db().get("task", &task.id).await.unwrap().unwrap();
    assert_eq!(current.version, task.version + 1);
    assert_eq!(current.links[0].state, "resolved_absent");
    assert!(
        current.links[0]
            .error
            .as_ref()
            .unwrap()
            .contains("confirmed no create")
    );
}

#[tokio::test]
async fn trash_filter_preserves_view_and_restored_task_returns_to_active() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let server = server(&app);
    server
        .post("/tasks")
        .form(&[("title", "Recover briefing")])
        .await
        .assert_status_see_other();
    let task = app.db().list::<Task>("task").await.unwrap().pop().unwrap();
    let path = format!("/tasks/{}", task.id);
    server
        .post(&format!("{path}/trash"))
        .await
        .assert_status_see_other();
    let html = server
        .get("/tasks?trash=true&q=briefing&status=open")
        .await
        .text();
    assert!(html.contains("<h1>Tasks · Trash</h1>"));
    assert!(html.contains("<input type=\"hidden\" name=\"trash\" value=\"true\">"));
    assert!(html.contains(&format!("href=\"{path}\"")));
    assert!(
        !server
            .get("/tasks?q=briefing")
            .await
            .text()
            .contains(&format!("href=\"{path}\""))
    );
    server
        .post(&format!("{path}/restore"))
        .await
        .assert_status_see_other();
    assert!(
        !app.db()
            .get::<Task>("task", &task.id)
            .await
            .unwrap()
            .unwrap()
            .trashed
    );
    assert!(
        server
            .get("/tasks?q=briefing")
            .await
            .text()
            .contains(&format!("href=\"{path}\""))
    );
    assert!(
        !server
            .get("/tasks?trash=true&q=briefing")
            .await
            .text()
            .contains(&format!("href=\"{path}\""))
    );
}

#[tokio::test]
async fn archived_people_search_preserves_view_and_restore_keeps_identity() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let server = server(&app);
    server
        .post("/terminal/people")
        .form(&[("name", "Alex Rivera"), ("email", "alex@example.test")])
        .await
        .assert_status_see_other();
    let person = app
        .db()
        .list::<Person>("person")
        .await
        .unwrap()
        .pop()
        .unwrap();
    let path = format!("/terminal/people/{}", person.id);
    server
        .post(&format!("{path}/archive"))
        .await
        .assert_status_see_other();
    let html = server
        .get("/terminal/people?archived=true&q=Alex")
        .await
        .text();
    assert!(html.contains("<h1>People · Archived</h1>"));
    assert!(html.contains("<input type=\"hidden\" name=\"archived\" value=\"true\">"));
    assert!(html.contains(&format!("href=\"{path}\"")));
    assert!(
        !server
            .get("/terminal/people?q=Alex")
            .await
            .text()
            .contains(&format!("href=\"{path}\""))
    );
    server
        .post(&format!("{path}/restore"))
        .await
        .assert_status_see_other();
    let restored = app
        .db()
        .get::<Person>("person", &person.id)
        .await
        .unwrap()
        .unwrap();
    assert!(!restored.archived);
    assert_eq!(restored.email, "alex@example.test");
    assert!(
        server
            .get("/terminal/people?q=Alex")
            .await
            .text()
            .contains(&format!("href=\"{path}\""))
    );
}

#[tokio::test]
async fn rejected_task_edits_remain_correctable_without_changing_saved_work() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let server = server(&app);
    server
        .post("/tasks")
        .form(&[("title", "Board follow-up")])
        .await
        .assert_status_see_other();
    let task = app.db().list::<Task>("task").await.unwrap().pop().unwrap();
    let path = format!("/tasks/{}", task.id);
    let notes = "Conservar notas de Lucía </textarea><script>alert(1)</script>";
    let response = server
        .post(&path)
        .form(&[
            ("version", "1"),
            ("title", "   "),
            ("notes", notes),
            ("owner", "Elena & Lucía"),
            ("priority", "urgent"),
            ("status", "in_progress"),
            ("due", "2026-10-20"),
        ])
        .await;
    response.assert_status_bad_request();
    let html = response.text();
    assert!(html.contains("role=\"alert\""));
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
    let selector = scraper::Selector::parse("input[name=owner]").unwrap();
    assert_eq!(
        document
            .select(&selector)
            .next()
            .unwrap()
            .value()
            .attr("value"),
        Some("Elena & Lucía")
    );
    let selector = scraper::Selector::parse("select[name=priority] option[selected]").unwrap();
    assert_eq!(
        document
            .select(&selector)
            .next()
            .unwrap()
            .value()
            .attr("value"),
        Some("urgent")
    );
    let saved = app
        .db()
        .get::<Task>("task", &task.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.title, "Board follow-up");
    assert_eq!(saved.notes, "");
    assert_eq!(saved.version, 1);
    server
        .post(&path)
        .form(&[
            ("version", "1"),
            ("title", "Corrected follow-up"),
            ("notes", notes),
            ("owner", "Elena & Lucía"),
            ("priority", "urgent"),
            ("status", "in_progress"),
            ("due", "2026-10-20"),
        ])
        .await
        .assert_status_see_other();
    let saved = app
        .db()
        .get::<Task>("task", &task.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.title, "Corrected follow-up");
    assert_eq!(saved.notes, notes);
    assert_eq!(saved.owner, "Elena & Lucía");
    assert_eq!(saved.due.as_deref(), Some("2026-10-20"));
    assert_eq!(saved.priority, "urgent");
    assert_eq!(saved.status, "in_progress");
    assert_eq!(saved.version, 2);
    let stale = server
        .post(&path)
        .form(&[
            ("version", "1"),
            ("title", "Other tab edits"),
            ("notes", "Do not lose this draft"),
            ("priority", "normal"),
            ("status", "open"),
        ])
        .await;
    stale.assert_status_conflict();
    assert!(stale.text().contains("Do not lose this draft"));
    assert!(stale.text().contains("name=\"version\" value=\"1\""));
    assert!(
        stale
            .text()
            .contains(&format!("href=\"{path}\">Reload saved task"))
    );
    let saved = app
        .db()
        .get::<Task>("task", &task.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.notes, notes);
    assert_eq!(saved.version, 2);
    let bad_date = server
        .post(&path)
        .form(&[
            ("version", "2"),
            ("title", "Corrected follow-up"),
            ("notes", notes),
            ("priority", "normal"),
            ("status", "open"),
            ("due", "2026-99-01"),
        ])
        .await;
    bad_date.assert_status_bad_request();
    assert!(
        bad_date
            .text()
            .contains("type=\"text\" name=\"due\" value=\"2026-99-01\"")
    );
}
