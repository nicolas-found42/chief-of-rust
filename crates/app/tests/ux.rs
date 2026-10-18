//! UX regressions exercise the real routes and inspect durable records after form actions.
use chief_of_rust::{App, Config, db::Db, llm, meetings, tasks, terminal, work};
use scraper::{Html, Selector};
use serde_json::{Value, json};

fn setup() -> (tempfile::TempDir, App, axum_test::TestServer) {
    let dir = tempfile::tempdir().unwrap();
    let cfg = Config::for_workspace(dir.path().into());
    let app = App {
        db: Db::open(&cfg.db_path()).unwrap(),
        llm: llm::from_config(&cfg),
        pacer: std::sync::Arc::new(chief_of_rust::collect::Pacer::system()),
        judge: chief_of_rust::judgments::from_config(&cfg),
        cfg,
    };
    let server = axum_test::TestServer::new(chief_of_rust::routes::router(app.clone()));
    (dir, app, server)
}
fn count(html: &str, selector: &str) -> usize {
    Html::parse_document(html)
        .select(&Selector::parse(selector).unwrap())
        .count()
}

#[tokio::test]
async fn shell_tracks_aliases_and_active_runs_without_exposing_job_tokens() {
    let (_dir, app, server) = setup();
    let job = work::enqueue(
        &app.db,
        "terminal.company_research",
        "fixture",
        json!({"company":{"name":"Acme <Labs>"}}),
    )
    .await
    .unwrap();
    let id = job.id.clone();
    app.db
        .transaction(move |tx| {
            tx.execute("UPDATE job SET status='running' WHERE id=?1", [id])?;
            Ok(())
        })
        .await
        .unwrap();
    for (path, href) in [
        ("/transcripts", "/meetings"),
        ("/content", "/content-scout"),
        ("/research", "/content-research"),
        ("/youtube", "/content-research"),
        ("/terminal/companies", "/terminal"),
        ("/onboarding", "/settings"),
    ] {
        let html = server.get(path).await.text();
        assert_eq!(
            count(
                &html,
                &format!("header a[aria-current=page][href='{href}']")
            ),
            1
        );
        assert!(html.contains("1 running"));
    }
    let list = server.get("/runs").await.text();
    assert!(list.contains("Company Research — Acme &lt;Labs&gt;"));
    assert!(!list.contains("terminal.company_research"));
    let detail = server.get(&format!("/runs/{}", job.id)).await.text();
    assert_eq!(count(&detail, "meta[http-equiv=refresh][content='3']"), 1);
    let id = job.id;
    app.db
        .transaction(move |tx| {
            tx.execute(
                "UPDATE job SET status='done',result=?2 WHERE id=?1",
                rusqlite::params![
                    id,
                    json!({"ledger_valid":false,"url":"/terminal/companies"}).to_string()
                ],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let done = server
        .get(&format!("/runs/{id}", id = job_id(&app).await))
        .await
        .text();
    assert_eq!(count(&done, "meta[http-equiv=refresh]"), 0);
    assert!(done.contains("Ledger warnings"));
    assert_eq!(count(&done, "a.btn-primary[href='/terminal/companies']"), 1);
    assert_eq!(count(&done, "details:not([open]) pre"), 2);
}
async fn job_id(app: &App) -> String {
    work::list(&app.db).await.unwrap()[0].id.clone()
}

#[tokio::test]
async fn catalog_orders_pages_and_preserves_filters_in_navigation() {
    let (_dir, app, server) = setup();
    for i in 0..27 {
        let transcript = meetings::Transcript {
            id: uuid::Uuid::new_v4().to_string(),
            title: format!("Review {i:02}"),
            text: "Alex: Short source.".into(),
            meeting_id: None,
            association: "unassigned".into(),
            source_url: None,
            source_id: None,
            revision: 1,
            created_at: i,
        };
        app.db
            .put("transcript", &transcript.id, transcript.clone())
            .await
            .unwrap();
    }
    let meeting_page = server.get("/meetings").await.text();
    assert_eq!(
        count(&meeting_page, "form[action='/meetings'] button.btn-primary"),
        1
    );
    let first = server.get("/transcripts").await.text();
    assert_eq!(count(&first, "tbody tr"), 25);
    assert!(first.find("Review 26").unwrap() < first.find("Review 25").unwrap());
    assert!(first.find("Add Transcript Text").unwrap() < first.find("<table").unwrap());
    assert!(first.contains("Very short / &lt;1 KB"));
    assert_eq!(count(&first, "tbody .badge-warning"), 25);
    let page = server
        .get("/transcripts?q=Review&association=unassigned&page=2")
        .await
        .text();
    assert_eq!(count(&page, "tbody tr"), 2);
    assert!(page.contains("q=Review&amp;association=unassigned&amp;page=1"));
    assert_eq!(
        count(
            &server
                .get("/transcripts?association=confirmed")
                .await
                .text(),
            "tbody tr"
        ),
        0
    );
}

#[tokio::test]
async fn trash_is_focused_and_completion_is_version_fenced() {
    let (_dir, app, server) = setup();
    server
        .post("/tasks")
        .form(&[("title", "Follow up")])
        .await
        .assert_status_see_other();
    let task = app
        .db
        .list::<tasks::Task>("task")
        .await
        .unwrap()
        .pop()
        .unwrap();
    server
        .post(&format!("/tasks/{}/complete", task.id))
        .form(&[("version", "1"), ("status", "done")])
        .await
        .assert_status_see_other();
    let saved = app
        .db
        .get::<tasks::Task>("task", &task.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.status, "done");
    assert_eq!(saved.version, 2);
    server
        .post(&format!("/tasks/{}/complete", task.id))
        .form(&[("version", "1"), ("status", "open")])
        .await
        .assert_status_conflict();
    assert_eq!(
        app.db
            .get::<tasks::Task>("task", &task.id)
            .await
            .unwrap()
            .unwrap()
            .status,
        "done"
    );
    server
        .post(&format!("/tasks/{}/trash", task.id))
        .await
        .assert_status_see_other();
    let trash = server.get("/tasks?trash=true").await.text();
    for label in [
        "Capture a task",
        "Meeting actions to review",
        "Create a list",
    ] {
        assert!(!trash.contains(label));
    }
    assert!(trash.contains("Restore task"));
    let mut current = app
        .db
        .get::<tasks::Task>("task", &task.id)
        .await
        .unwrap()
        .unwrap();
    current.links.push(tasks::ExternalLink {
        provider: "asana".into(),
        container: "project".into(),
        remote_id: None,
        state: "uncertain".into(),
        error: None,
        synced_version: None,
        google_binding: None,
    });
    app.db.put("task", &task.id, current).await.unwrap();
    let detail = server.get(&format!("/tasks/{}", task.id)).await.text();
    assert_eq!(
        count(
            &detail,
            "form[action$=reconcile] input[name=provider][value=asana]"
        ),
        1
    );
    assert_eq!(
        count(
            &detail,
            "form[action$=resolve-absent] input[name=provider][value=asana]"
        ),
        1
    );
    assert_eq!(count(&detail, "form[action$=reconcile] select"), 0);
}

#[tokio::test]
async fn research_prose_links_numbered_sources_and_escapes_html() {
    let (_dir, app, server) = setup();
    let id = uuid::Uuid::new_v4().to_string();
    let source = uuid::Uuid::new_v4().to_string();
    let report = json!({"id":id,"watch_id":"watch","person_name":"Research fixture","created_at":"2026-10-15T05:49:00.667833802+00:00","evidence":[{"id":source,"title":"Source title","url":"https://example.com","text":"Source text","observed_at":"2026-10-15T05:49:00Z"}],"artifact":{"id":"artifact","stage":"research","body":format!("# Findings\n\n**Supported** [{source}]\n\n- A finding\n\n<script>alert(1)</script>"),"source_ids":[source],"unsupported_claims":[],"created_at":"2026-10-15T05:49:00Z","approved_at":null,"model":"fixture"}});
    app.db.put("content.report", &id, report).await.unwrap();
    let html = server.get(&format!("/research/reports/{id}")).await.text();
    assert_eq!(count(&html, ".prose h1"), 1);
    assert_eq!(count(&html, ".prose li"), 1);
    assert_eq!(count(&html, ".prose sup a[href='#source-1']"), 1);
    assert_eq!(count(&html, "article#source-1"), 1);
    assert_eq!(count(&html, "script"), 0);
    let doc = Html::parse_document(&html);
    let prose = doc
        .select(&Selector::parse(".prose").unwrap())
        .next()
        .unwrap();
    assert!(!prose.text().collect::<String>().contains(&source));
    assert!(html.contains("Oct 15, 2026 · 05:49 UTC"));
}

#[tokio::test]
async fn company_directory_and_saved_briefs_include_ledger_warnings() {
    let (_dir, app, server) = setup();
    server
        .post("/terminal/companies")
        .form(&[("name", "Acme")])
        .await
        .assert_status_see_other();
    let c = app
        .db
        .list::<terminal::Company>("company")
        .await
        .unwrap()
        .pop()
        .unwrap();
    let brief = json!({"id":"brief","company_id":c.id,"company_version":1,"question":"What is known?","brief":"## Findings Public facts ## Limits More evidence needed","claims":[],"sources":[],"coverage":[{"family":"empty_collector","question":"Evidence?","state":"bounded_empty"}],"frontier":[],"ledger_check":{"valid":false,"warnings":[],"errors":["coverage[0]: covered question needs source evidence"]},"created_at":1,"run_id":"fixture-run"});
    app.db.put("company_brief", "brief", brief).await.unwrap();
    let profile = server
        .get(&format!("/terminal/companies/{}", c.id))
        .await
        .text();
    assert!(profile.contains("What is known?"));
    assert!(profile.contains("Ledger warnings"));
    let directory = server.get("/terminal/companies").await.text();
    assert_eq!(count(&directory, "form[action='/terminal/companies']"), 0);
    assert_eq!(count(&directory, "form[action='/terminal/comparisons']"), 0);
    server
        .get(&format!("/terminal/companies/{}/briefs/brief", c.id))
        .await
        .assert_status_see_other();
    let detail = server
        .get(&format!("/terminal/companies/{}", c.id))
        .await
        .text();
    assert_eq!(count(&detail, ".prose h2"), 2);
    assert!(detail.contains("Show 1 skipped or empty collectors"));
    assert!(!detail.contains("coverage[0]"));
}

#[tokio::test]
async fn archived_person_disables_edits_but_allows_restoration() {
    let (_dir, app, server) = setup();
    server
        .post("/terminal/people")
        .form(&[("name", "Alex")])
        .await
        .assert_status_see_other();
    let p = app
        .db
        .list::<chief_of_rust::people::Person>("person")
        .await
        .unwrap()
        .pop()
        .unwrap();
    server
        .post(&format!("/terminal/people/{}/archive", p.id))
        .await
        .assert_status_see_other();
    let html = server
        .get(&format!("/terminal/people/{}", p.id))
        .await
        .text();
    assert!(html.contains("Archived Person"));
    assert_eq!(count(&html, "input, textarea, select"), 0);
    let homepage = server.get("/terminal").await.text();
    assert!(count(&homepage, "form[action$=restore]") >= 1);
    assert_eq!(count(&html, "fieldset[disabled] form[action$=restore]"), 0);
    server
        .post(&format!("/terminal/people/{}", p.id))
        .form(&[("name", "Changed"), ("version", "2")])
        .await
        .assert_status_conflict();
    assert_eq!(
        app.db.get::<Value>("person", &p.id).await.unwrap().unwrap()["name"],
        "Alex"
    );
    server
        .post(&format!("/terminal/people/{}/restore", p.id))
        .await
        .assert_status_see_other();
    assert!(
        !app.db
            .get::<chief_of_rust::people::Person>("person", &p.id)
            .await
            .unwrap()
            .unwrap()
            .archived
    );
    server
        .post(&format!("/terminal/people/{}/archive", p.id))
        .await
        .assert_status_see_other();
    server
        .post(&format!("/terminal/people/{}/privacy-delete", p.id))
        .form(&[("version", "4"), ("acknowledgement", "DELETE")])
        .await
        .assert_status_see_other();
    assert!(
        app.db
            .get::<Value>("person", &p.id)
            .await
            .unwrap()
            .is_none()
    );
}
