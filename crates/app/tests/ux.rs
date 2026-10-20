//! UX regressions exercise the real routes and inspect durable records after form actions.
use chief_of_rust::{App, Config, db::Db, llm, meetings, tasks, terminal, work};
use scraper::{Html, Selector};
use serde_json::{Value, json};

fn setup() -> (tempfile::TempDir, App, axum_test::TestServer) {
    let dir = tempfile::tempdir().unwrap();
    let cfg = Config::for_workspace(dir.path().into());
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        Db::open(&cfg.db_path()).unwrap(),
        llm::from_config(&cfg),
        chief_of_rust::judgments::from_config(&cfg),
        std::sync::Arc::new(chief_of_rust::collect::Pacer::system()),
    )
    .app();
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
        app.db(),
        "terminal.company_research",
        "fixture",
        json!({"company":{"name":"Acme <Labs>"}}),
    )
    .await
    .unwrap();
    let id = job.id.clone();
    app.db()
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
    app.db()
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
    assert_eq!(
        count(&done, "a.cds-btn--primary[href='/terminal/companies']"),
        1
    );
    assert_eq!(count(&done, "details:not([open]) pre"), 2);
}
async fn job_id(app: &App) -> String {
    work::list(app.db()).await.unwrap()[0].id.clone()
}

/// The shell renders the page title unless the body declares its own heading.
/// Either declaration must leave exactly one `<h1>`, and the request middleware
/// must still own the navigation highlight and the Run badge.
#[tokio::test]
async fn pages_declare_their_own_heading_and_keep_the_request_context() {
    let (_dir, app, server) = setup();
    let job = work::enqueue(
        app.db(),
        "terminal.company_research",
        "heading",
        json!({"company":{"name":"Acme"}}),
    )
    .await
    .unwrap();
    let id = job.id.clone();
    app.db()
        .transaction(move |tx| {
            tx.execute("UPDATE job SET status='running' WHERE id=?1", [id])?;
            Ok(())
        })
        .await
        .unwrap();
    // The workspace home belongs to no product section, so it highlights no
    // navigation entry; every other page below highlights exactly one.
    let home = server.get("/").await.text();
    assert_eq!(count(&home, "h1"), 1, "{home}");
    assert!(home.contains("<h1>Chief of Staff</h1>"), "{home}");
    assert!(home.contains("1 running"), "{home}");
    for (path, heading) in [
        ("/meetings", "Meeting Wizard"),
        ("/meetings/history", "Meeting history"),
        ("/meetings/weekly", "Weekly meeting review"),
        ("/transcripts", "Transcript catalog"),
        ("/content", "Build from evidence. Publish with intent."),
        (
            "/content-scout",
            "Build from evidence. Publish with intent.",
        ),
        (
            "/content-research",
            "Keep up with the people shaping your field.",
        ),
        ("/research", "Keep up with the people shaping your field."),
        ("/youtube", "Observe channel momentum."),
        ("/terminal", "Bloomberg Terminal"),
        ("/terminal/people", "People"),
        ("/terminal/companies", "Company Profiles"),
        ("/tasks", "Tasks"),
        ("/settings", "Settings"),
        ("/onboarding", "Settings"),
        ("/runs", "Runs"),
    ] {
        let html = server.get(path).await.text();
        assert_eq!(count(&html, "h1"), 1, "{path} renders one heading: {html}");
        assert!(
            html.contains(&format!("<h1>{heading}</h1>")),
            "{path} renders {heading}: {html}"
        );
        assert_eq!(count(&html, "header a[aria-current=page]"), 1, "{path}");
        assert!(html.contains("1 running"), "{path} shows the Run badge");
    }
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
        app.db()
            .put("transcript", &transcript.id, transcript.clone())
            .await
            .unwrap();
    }
    let meeting_page = server.get("/meetings").await.text();
    assert_eq!(
        count(
            &meeting_page,
            "form[action='/meetings'] button.cds-btn--primary"
        ),
        1
    );
    let first = server.get("/transcripts").await.text();
    assert_eq!(count(&first, "tbody tr"), 25);
    assert!(first.find("Review 26").unwrap() < first.find("Review 25").unwrap());
    assert!(first.find("Add Transcript Text").unwrap() < first.find("<table").unwrap());
    assert!(first.contains("Very short / &lt;1 KB"));
    assert_eq!(count(&first, "tbody .cds-tag--yellow"), 25);
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
        .db()
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
        .db()
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
        app.db()
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
        .db()
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
    app.db().put("task", &task.id, current).await.unwrap();
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
    app.db().put("content.report", &id, report).await.unwrap();
    let html = server.get(&format!("/research/reports/{id}")).await.text();
    assert_eq!(count(&html, ".cds-prose h1"), 1);
    assert_eq!(count(&html, ".cds-prose li"), 1);
    assert_eq!(count(&html, ".cds-prose sup a[href='#source-1']"), 1);
    assert_eq!(count(&html, "article#source-1"), 1);
    assert_eq!(count(&html, "script"), 0);
    let doc = Html::parse_document(&html);
    let prose = doc
        .select(&Selector::parse(".cds-prose").unwrap())
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
        .db()
        .list::<terminal::Company>("company")
        .await
        .unwrap()
        .pop()
        .unwrap();
    let brief = json!({"id":"brief","company_id":c.id,"company_version":1,"question":"What is known?","brief":"## Findings Public facts ## Limits More evidence needed","claims":[],"sources":[],"coverage":[{"family":"empty_collector","question":"Evidence?","state":"bounded_empty"}],"frontier":[],"ledger_check":{"valid":false,"warnings":[],"errors":["coverage[0]: covered question needs source evidence"]},"created_at":1,"run_id":"fixture-run"});
    app.db().put("company_brief", "brief", brief).await.unwrap();
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
    assert_eq!(count(&detail, ".cds-prose h2"), 2);
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
        .db()
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
        app.db()
            .get::<Value>("person", &p.id)
            .await
            .unwrap()
            .unwrap()["name"],
        "Alex"
    );
    server
        .post(&format!("/terminal/people/{}/restore", p.id))
        .await
        .assert_status_see_other();
    assert!(
        !app.db()
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
        app.db()
            .get::<Value>("person", &p.id)
            .await
            .unwrap()
            .is_none()
    );
}

/// Every product page, in navigation order.
const PRODUCT_PAGES: &[&str] = &[
    "/",
    "/meetings",
    "/meetings/history",
    "/meetings/weekly",
    "/transcripts",
    "/content",
    "/content-scout",
    "/content-research",
    "/research",
    "/youtube",
    "/terminal",
    "/terminal/people",
    "/terminal/companies",
    "/tasks",
    "/settings",
    "/onboarding",
    "/runs",
];

/// Heading order stays linear on every product page: exactly one `<h1>`
/// first, and no heading skips a level.
#[tokio::test]
async fn product_pages_keep_heading_order() {
    let (_dir, _app, server) = setup();
    for path in PRODUCT_PAGES {
        let html = server.get(path).await.text();
        let headings = Html::parse_document(&html)
            .select(&Selector::parse("h1, h2, h3, h4, h5, h6").unwrap())
            .map(|heading| heading.value().name().as_bytes()[1] - b'0')
            .collect::<Vec<_>>();
        assert_eq!(
            headings.first(),
            Some(&1),
            "{path} starts at h1: {headings:?}"
        );
        for pair in headings.windows(2) {
            assert!(
                pair[1] <= pair[0] + 1,
                "{path} skips a heading level: {headings:?}"
            );
        }
    }
}

/// Every form control is named by a `<label>` or an explicit `aria-label`,
/// so keyboard and screen-reader users reach the same fields.
#[tokio::test]
async fn product_pages_label_every_form_control() {
    let (_dir, _app, server) = setup();
    for path in PRODUCT_PAGES {
        let html = server.get(path).await.text();
        let document = Html::parse_document(&html);
        let labels = document
            .select(&Selector::parse("label").unwrap())
            .map(|label| label.html())
            .collect::<String>();
        let mut unlabelled = Vec::new();
        for control in document
            .select(&Selector::parse("input:not([type='hidden']), select, textarea").unwrap())
        {
            let element = control.value();
            let described = element.attr("aria-label").is_some_and(|v| !v.is_empty())
                || element.attr("aria-labelledby").is_some();
            if described {
                continue;
            }
            let name = element.attr("name").unwrap_or_default();
            let marker = format!("name=\"{name}\"");
            if !name.is_empty() && labels.contains(&marker) {
                continue;
            }
            unlabelled.push(control.html());
        }
        assert!(
            unlabelled.is_empty(),
            "{path} leaves form controls unlabelled: {unlabelled:?}"
        );
    }
}

/// Narrow screens keep the single-column form and toolbar rules: the
/// stylesheet's only breakpoint re-flows the grid, the toolbar, the cards and
/// the steps into one column.
#[tokio::test]
async fn narrow_screen_layout_reflows_forms_and_toolbars() {
    let (_dir, _app, server) = setup();
    let css = server.get("/static/carbon.css").await.text();
    let narrow = css
        .split("@media (max-width: 40rem)")
        .skip(1)
        .collect::<String>();
    assert!(
        !narrow.is_empty(),
        "carbon.css keeps its narrow-screen breakpoint"
    );
    // Compare trimmed lines so indentation cannot hide a lost rule while
    // selector whitespace stays significant.
    let lines = narrow.lines().map(str::trim).collect::<Vec<_>>();
    for rule in [
        ".cds-form--grid { grid-template-columns: 1fr; }",
        ".cds-toolbar { flex-direction: column; align-items: stretch; }",
        ".cds-toolbar label { flex-basis: 100%; }",
        ".cds-cards { grid-template-columns: 1fr; }",
        ".cds-steps { flex-direction: column; }",
        "dl { grid-template-columns: 1fr; }",
    ] {
        assert!(lines.contains(&rule), "narrow screens keep {rule}");
    }
}

/// Severity text survives on a real page: a short transcript keeps its
/// warning tag, and a blocked or failed state keeps a red tag.
#[tokio::test]
async fn rendered_pages_retain_severity_text() {
    use chief_of_rust::meetings;
    let (_dir, app, server) = setup();
    let transcript = meetings::Transcript {
        id: uuid::Uuid::new_v4().to_string(),
        title: "Short review".into(),
        text: "Alex: Short source.".into(),
        meeting_id: None,
        association: "unassigned".into(),
        source_url: None,
        source_id: None,
        revision: 1,
        created_at: 1,
    };
    let id = transcript.id.clone();
    app.db().put("transcript", &id, transcript).await.unwrap();
    let html = server.get("/transcripts").await.text();
    for (class, text) in [
        ("cds-tag--yellow", "Very short / &lt;1 KB"),
        ("cds-tag--gray", "Unassigned"),
    ] {
        assert!(
            html.contains(&format!("class=\"cds-tag {class}\">{text}</span>")),
            "the {text} state keeps its severity text: {html}"
        );
    }
}

/// Keyboard focus stays visible on every control the pages render, and the
/// skip link is the first focusable element on each page.
#[tokio::test]
async fn keyboard_focus_is_visible_and_the_skip_link_comes_first() {
    let (_dir, _app, server) = setup();
    let css = server.get("/static/carbon.css").await.text();
    assert!(
        css.contains("outline: var(--cds-focus-width) solid var(--cds-focus)"),
        "the stylesheet draws a real focus ring"
    );
    for control in ["a", "button", "input", "select", "textarea", "summary"] {
        assert!(
            css.contains(&format!("{control}:focus-visible")),
            "{control} keeps its focus ring"
        );
    }
    assert!(
        !css.contains("outline: none") && !css.contains("outline: 0"),
        "no rule removes the focus ring: {css}"
    );
    for path in PRODUCT_PAGES {
        let html = server.get(path).await.text();
        let first_focusable = Html::parse_document(&html)
            .select(&Selector::parse("a[href], button, input, select, textarea").unwrap())
            .next()
            .map(|element| element.html())
            .unwrap_or_default();
        assert!(
            first_focusable.contains("cds-skip-link"),
            "{path} focuses the skip link first: {first_focusable}"
        );
    }
}
