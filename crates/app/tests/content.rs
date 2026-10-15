use async_trait::async_trait;
use chief_of_rust::{
    App, Config,
    content::{self, Artifact, Brand, Evidence, Opportunity, Project},
    db::Db,
    llm::LlmProvider,
    work,
};
use serde_json::json;
use std::sync::Arc;
use tempfile::TempDir;

struct Fixture;
#[async_trait]
impl LlmProvider for Fixture {
    fn name(&self) -> &'static str {
        "mock"
    }
    async fn complete(&self, _: &str) -> anyhow::Result<String> {
        Ok(json!({"body":"Demo fixture copy. Human review required.","source_ids":[],"unsupported_claims":["Verify the illustrative example before publication."]}).to_string())
    }
}
fn setup() -> (TempDir, App, axum_test::TestServer) {
    let dir = TempDir::new().unwrap();
    let cfg = Config::for_workspace(dir.path().to_owned());
    let app = App {
        judge: chief_of_rust::judgments::from_config(&cfg),
        db: Db::open(&cfg.db_path()).unwrap(),
        cfg,
        llm: Arc::new(Fixture),
    };
    let server = axum_test::TestServer::new(content::router().with_state(app.clone()));
    (dir, app, server)
}
async fn brand(server: &axum_test::TestServer) {
    server
        .post("/content/brand")
        .form(&[
            ("revision", "0"),
            ("name", "Found42"),
            ("audience", "Technical founders"),
            ("voice", "Concrete examples; rigorous evidence"),
            ("boundaries", "No invented statistics"),
            ("evidence", "Original founder perspective"),
        ])
        .await
        .assert_status_see_other();
}
async fn create(app: &App, server: &axum_test::TestServer) -> Project {
    server
        .post("/content/projects")
        .form(&[
            ("subject", "Rust <script>alert(1)</script>"),
            ("objective", "Explain a useful tradeoff"),
            ("audience", "Technical founders"),
            ("target", "website-blog-article"),
            (
                "material",
                "Our original experience: simple interfaces help.",
            ),
        ])
        .await
        .assert_status_see_other();
    app.db
        .list::<Project>("content.project")
        .await
        .unwrap()
        .pop()
        .unwrap()
}
async fn run_stage(
    app: &App,
    server: &axum_test::TestServer,
    id: &str,
    revision: u64,
    stage: &str,
) -> work::Job {
    let response = server
        .post(&format!("/content/projects/{id}/generate/{stage}"))
        .form(&[("revision", revision.to_string())])
        .await;
    response.assert_status_see_other();
    let mut jobs = work::list(&app.db).await.unwrap();
    jobs.sort_by_key(|j| j.created_at);
    let artifact_count = applicable_count(app, id).await;
    let job = jobs
        .into_iter()
        .find(|j| {
            j.kind == format!("content.{stage}")
                && j.input["revision"]["artifacts"]
                    .as_array()
                    .map_or(0, Vec::len)
                    == artifact_count
        })
        .unwrap();
    content::execute(app, &job).await.unwrap();
    job
}
async fn applicable_count(app: &App, id: &str) -> usize {
    app.db
        .get::<Project>("content.project", id)
        .await
        .unwrap()
        .unwrap()
        .current()
        .artifacts
        .len()
}
async fn approve(server: &axum_test::TestServer, id: &str, revision: u64, artifact: &Artifact) {
    server
        .post(&format!("/content/projects/{id}/approve/{}", artifact.id))
        .form(&[("revision", revision.to_string())])
        .await
        .assert_status_see_other();
}
async fn latest(app: &App, id: &str, stage: &str) -> Artifact {
    app.db
        .get::<Project>("content.project", id)
        .await
        .unwrap()
        .unwrap()
        .current()
        .artifacts
        .iter()
        .rev()
        .find(|a| a.stage == stage)
        .unwrap()
        .clone()
}

fn assert_button_ready(html: &str, label: &str, ready: bool) {
    let button = html
        .split("<button")
        .find(|part| part.split("</button>").next().unwrap_or("").contains(label))
        .expect("button exists");
    let attributes = button.split('>').next().unwrap();
    assert_eq!(
        !attributes.contains("disabled"),
        ready,
        "{label}: {attributes}"
    );
}

#[tokio::test]
async fn research_readiness_tracks_active_and_paused_watches() {
    let (_dir, app, server) = setup();
    let empty = server.get("/research").await.text();
    assert_button_ready(&empty, "Research active watches", false);
    assert!(empty.contains("Add or resume a watch"));
    server
        .post("/research/watches")
        .form(&[("name", "Test subject"), ("query", "Test public query")])
        .await
        .assert_status_see_other();
    assert_button_ready(
        &server.get("/research").await.text(),
        "Research active watches",
        true,
    );
    let watch = app
        .db
        .list::<content::Watch>("content.watch")
        .await
        .unwrap()
        .pop()
        .unwrap();
    let toggle = format!("/research/watches/{}/toggle", watch.id);
    server.post(&toggle).await.assert_status_see_other();
    assert_button_ready(
        &server.get("/research").await.text(),
        "Research active watches",
        false,
    );
    server
        .post("/research/run")
        .await
        .assert_status_bad_request();
    assert!(work::list(&app.db).await.unwrap().is_empty());
    server.post(&toggle).await.assert_status_see_other();
    assert_button_ready(
        &server.get("/research").await.text(),
        "Research active watches",
        true,
    );
}

#[tokio::test]
async fn content_review_lineage_export_and_revision_fences() {
    let (_dir, app, server) = setup();
    brand(&server).await;
    let project = create(&app, &server).await;
    let path = format!("/content/projects/{}", project.id);
    let html = server.get(&path).await.text();
    assert_button_ready(&html, "Generate outline", false);
    assert_button_ready(&html, "Generate draft", false);
    assert!(html.contains("Review and approve the evidence in step 1"));
    assert!(html.contains("Rust &lt;script&gt;"));
    assert!(!html.contains("<script>alert(1)</script>"));
    server
        .post(&format!("{path}/generate/outline"))
        .form(&[("revision", "1")])
        .await
        .assert_status_bad_request();
    server
        .post(&format!("{path}/review"))
        .form(&[("revision", "1")])
        .await
        .assert_status_see_other();
    let reviewed_html = server.get(&path).await.text();
    assert_button_ready(&reviewed_html, "Generate outline", true);
    assert_button_ready(&reviewed_html, "Generate draft", false);
    let first = server
        .post(&format!("{path}/generate/outline"))
        .form(&[("revision", "1")])
        .await;
    let second = server
        .post(&format!("{path}/generate/outline"))
        .form(&[("revision", "1")])
        .await;
    assert_eq!(first.header("location"), second.header("location"));
    assert_eq!(work::list(&app.db).await.unwrap().len(), 1);
    let outline_job = work::list(&app.db).await.unwrap().pop().unwrap();
    content::execute(&app, &outline_job).await.unwrap();
    let outline = latest(&app, &project.id, "outline").await;
    content::execute(&app, &outline_job).await.unwrap();
    assert_eq!(
        app.db
            .get::<Project>("content.project", &project.id)
            .await
            .unwrap()
            .unwrap()
            .current()
            .artifacts
            .len(),
        1
    );
    server
        .post(&format!("{path}/generate/draft"))
        .form(&[("revision", "1")])
        .await
        .assert_status_bad_request();
    assert_button_ready(&server.get(&path).await.text(), "Generate draft", false);
    approve(&server, &project.id, 1, &outline).await;
    assert_button_ready(&server.get(&path).await.text(), "Generate draft", true);
    run_stage(&app, &server, &project.id, 1, "draft").await;
    let draft = latest(&app, &project.id, "draft").await;
    assert_eq!(draft.outline_id.as_deref(), Some(outline.id.as_str()));
    server
        .get(&format!("{path}/export"))
        .await
        .assert_status_bad_request();
    approve(&server, &project.id, 1, &draft).await;
    let exported = server.get(&format!("{path}/export")).await;
    exported.assert_status_ok();
    assert!(exported.text().contains("demo fixture"));
    assert!(exported.text().contains("Claims requiring verification"));
    assert_eq!(
        exported.header("content-type"),
        "text/markdown; charset=utf-8"
    );
    run_stage(&app, &server, &project.id, 1, "outline").await;
    assert_button_ready(&server.get(&path).await.text(), "Generate draft", false);
    server
        .get(&format!("{path}/export"))
        .await
        .assert_status_bad_request();
    server
        .post(&format!("{path}/approve/{}", draft.id))
        .form(&[("revision", "1")])
        .await
        .assert_status_conflict();
    let saved = app
        .db
        .get::<Project>("content.project", &project.id)
        .await
        .unwrap()
        .unwrap();
    assert!(
        saved
            .current()
            .artifacts
            .iter()
            .find(|a| a.id == draft.id)
            .unwrap()
            .approved_at
            .is_some(),
        "the historical human approval remains intact"
    );
    server
        .post(&format!("{path}/revise"))
        .form(&[
            ("revision", "1"),
            ("subject", "Updated topic"),
            ("objective", "New angle"),
            ("audience", "Founders"),
            ("target", "linkedin-standard-post"),
            ("material", "Revised original material"),
        ])
        .await
        .assert_status_see_other();
    let updated = app
        .db
        .get::<Project>("content.project", &project.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(updated.revisions.len(), 2);
    assert_eq!(updated.revisions[0].subject, project.current().subject);
    assert_eq!(updated.revisions[0].artifacts.len(), 3);
    assert!(!updated.current().evidence_reviewed);
    assert!(updated.current().artifacts.is_empty());
    let mut unexecuted = outline_job.clone();
    unexecuted.id = uuid::Uuid::new_v4().to_string();
    assert!(
        content::execute(&app, &unexecuted)
            .await
            .unwrap_err()
            .to_string()
            .contains("stale")
    );
    server
        .post(&format!("{path}/evidence"))
        .form(&[
            ("revision", "1"),
            ("title", "Evidence"),
            ("text", "A supported original fact"),
        ])
        .await
        .assert_status_conflict();
    assert_eq!(
        app.db
            .get::<Project>("content.project", &project.id)
            .await
            .unwrap()
            .unwrap()
            .revisions
            .len(),
        2
    );
}

#[tokio::test]
async fn brand_edits_and_opportunity_selection_are_atomic() {
    let (_dir, app, server) = setup();
    brand(&server).await;
    server
        .post("/content/brand")
        .form(&[
            ("revision", "0"),
            ("name", "Changed"),
            ("audience", "Others"),
            ("voice", "New"),
        ])
        .await
        .assert_status_conflict();
    let brand = app
        .db
        .get::<Brand>("brand", "current")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(brand.name, "Found42");
    let opportunity = Opportunity {
        id: uuid::Uuid::new_v4().to_string(),
        run_id: uuid::Uuid::new_v4().to_string(),
        title: "A worthwhile subject".into(),
        angle: "A relevant angle".into(),
        evidence: vec![Evidence {
            id: uuid::Uuid::new_v4().to_string(),
            title: "Original source".into(),
            url: Some("https://example.com/evidence".into()),
            text: "Captured source text".into(),
            observed_at: "2026-10-13T12:00:00Z".into(),
        }],
        brand,
        state: "shortlisted".into(),
        project_id: None,
        created_at: "2026-10-13T12:00:00Z".into(),
    };
    app.db
        .put(
            "content.opportunity",
            &opportunity.id.clone(),
            opportunity.clone(),
        )
        .await
        .unwrap();
    let first = server
        .post(&format!("/content/opportunities/{}/select", opportunity.id))
        .await;
    let second = server
        .post(&format!("/content/opportunities/{}/select", opportunity.id))
        .await;
    assert_eq!(first.header("location"), second.header("location"));
    let projects = app.db.list::<Project>("content.project").await.unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(
        projects[0].opportunity_id.as_deref(),
        Some(opportunity.id.as_str())
    );
    assert_eq!(projects[0].current().evidence.len(), 1);
    assert!(!projects[0].current().evidence_reviewed);
}

struct InventedCitation;
#[async_trait]
impl LlmProvider for InventedCitation {
    fn name(&self) -> &'static str {
        "mock"
    }
    async fn complete(&self, _: &str) -> anyhow::Result<String> {
        Ok(
            json!({"body":"A claim","source_ids":["invented-source"],"unsupported_claims":[]})
                .to_string(),
        )
    }
}
#[tokio::test]
async fn unknown_model_citations_cannot_enter_a_project() {
    let (_dir, mut app, server) = setup();
    brand(&server).await;
    let project = create(&app, &server).await;
    server
        .post(&format!("/content/projects/{}/review", project.id))
        .form(&[("revision", "1")])
        .await
        .assert_status_see_other();
    server
        .post(&format!(
            "/content/projects/{}/generate/outline",
            project.id
        ))
        .form(&[("revision", "1")])
        .await
        .assert_status_see_other();
    let job = work::list(&app.db).await.unwrap().pop().unwrap();
    app.llm = Arc::new(InventedCitation);
    let error = content::execute(&app, &job).await.unwrap_err();
    assert!(error.to_string().contains("not supplied"));
    assert!(
        app.db
            .get::<Project>("content.project", &project.id)
            .await
            .unwrap()
            .unwrap()
            .current()
            .artifacts
            .is_empty()
    );
}

#[tokio::test]
async fn paused_watches_and_sources_are_excluded_from_frozen_runs() {
    let (_dir, app, server) = setup();
    brand(&server).await;
    server
        .post("/content/sources")
        .form(&[
            ("label", "Public feed"),
            ("url", "https://example.com/feed"),
        ])
        .await
        .assert_status_see_other();
    server
        .post("/content/sources")
        .form(&[
            ("label", "Paused feed"),
            ("url", "https://example.com/paused"),
        ])
        .await
        .assert_status_see_other();
    let sources = app
        .db
        .list::<content::Source>("content.source")
        .await
        .unwrap();
    let paused = sources.iter().find(|s| s.label == "Paused feed").unwrap();
    server
        .post(&format!("/content/sources/{}/toggle", paused.id))
        .await
        .assert_status_see_other();
    server
        .post("/content/scout")
        .await
        .assert_status_see_other();
    let job = work::list(&app.db).await.unwrap().pop().unwrap();
    assert_eq!(job.input["sources"].as_array().unwrap().len(), 1);
    assert_eq!(job.input["sources"][0]["label"], "Public feed");
    for path in [
        "/content-scout",
        "/content-research",
        "/content-research/trends",
    ] {
        server.get(path).await.assert_status_ok();
    }
    server
        .post("/research/run")
        .await
        .assert_status_bad_request();
    server
        .post("/research/watches")
        .form(&[
            ("name", "A public creator"),
            ("query", "A public creator engineering"),
        ])
        .await
        .assert_status_see_other();
    let watches = app
        .db
        .list::<content::Watch>("content.watch")
        .await
        .unwrap();
    server
        .post(&format!("/research/watches/{}/toggle", watches[0].id))
        .await
        .assert_status_see_other();
    server
        .post("/research/run")
        .await
        .assert_status_bad_request();
}

#[tokio::test]
async fn youtube_trends_use_real_observation_dates_without_interpolation() {
    let (_dir, app, server) = setup();
    let channel_id = "UCabcdefghijklmnopqrstuv";
    server
        .post("/youtube/channels")
        .form(&[("id", channel_id), ("title", "Engineering channel")])
        .await
        .assert_status_see_other();
    for (day, views) in [
        ("2026-09-01T10:00:00Z", 100),
        ("2026-10-01T10:00:00Z", 160),
        ("2026-10-10T10:00:00Z", 190),
        ("2026-10-13T10:00:00Z", 210),
    ] {
        let observation = content::Observation {
            id: uuid::Uuid::new_v4().to_string(),
            channel_id: channel_id.into(),
            measured_at: day.into(),
            data: json!({"videos":[{"id":"abcdefghijk","title":"Observed upload","views":views}]}),
        };
        app.db
            .put("content.observation", &observation.id.clone(), observation)
            .await
            .unwrap();
    }
    let html = server.get("/content-research/trends").await.text();
    assert!(html.contains("<td>7 days</td><td>+50</td>"));
    assert!(html.contains("<td>30 days</td><td>+110</td>"));
    assert!(html.contains("210 views across observed uploads"));
    assert!(!html.contains("2026-10-02"));
}

#[tokio::test]
async fn evidence_exclusion_and_human_edits_preserve_prior_versions() {
    let (_dir, app, server) = setup();
    brand(&server).await;
    let p = create(&app, &server).await;
    let path = format!("/content/projects/{}", p.id);
    server
        .post(&format!("{path}/evidence"))
        .form(&[
            ("revision", "1"),
            ("title", "Source to review"),
            ("url", "https://example.com/evidence"),
            ("text", "An attributable original source."),
        ])
        .await
        .assert_status_see_other();
    let attached = app
        .db
        .get::<Project>("content.project", &p.id)
        .await
        .unwrap()
        .unwrap();
    let evidence_id = &attached.current().evidence[0].id;
    let html = server.get(&path).await.text();
    assert!(html.contains("Exclude this source in a new revision"));
    server
        .post(&format!("{path}/evidence/{evidence_id}/exclude"))
        .form(&[("revision", "2")])
        .await
        .assert_status_see_other();
    let excluded = app
        .db
        .get::<Project>("content.project", &p.id)
        .await
        .unwrap()
        .unwrap();
    assert!(excluded.current().evidence.is_empty());
    assert_eq!(
        excluded.revisions[1].evidence[0].text,
        "An attributable original source."
    );
    server
        .post(&format!("{path}/review"))
        .form(&[("revision", "3")])
        .await
        .assert_status_see_other();
    run_stage(&app, &server, &p.id, 3, "outline").await;
    let outline = latest(&app, &p.id, "outline").await;
    approve(&server, &p.id, 3, &outline).await;
    run_stage(&app, &server, &p.id, 3, "draft").await;
    let generated = latest(&app, &p.id, "draft").await;
    server
        .post(&format!("{path}/edit/{}", generated.id))
        .form(&[
            ("revision", "3"),
            ("body", "Our manually revised final copy."),
        ])
        .await
        .assert_status_see_other();
    let edited = latest(&app, &p.id, "draft").await;
    assert_ne!(edited.id, generated.id);
    assert_eq!(edited.body, "Our manually revised final copy.");
    assert_eq!(edited.outline_id, generated.outline_id);
    assert!(edited.approved_at.is_none());
    server
        .get(&format!("{path}/export"))
        .await
        .assert_status_bad_request();
    approve(&server, &p.id, 3, &edited).await;
    let export = server.get(&format!("{path}/export")).await;
    export.assert_status_ok();
    assert!(export.text().contains("Our manually revised final copy."));
    assert!(export.text().contains("Human edits require checking"));
    let saved = app
        .db
        .get::<Project>("content.project", &p.id)
        .await
        .unwrap()
        .unwrap();
    assert!(
        saved
            .current()
            .artifacts
            .iter()
            .any(|a| a.id == generated.id && a.body == generated.body)
    );
}

#[tokio::test]
async fn evidence_review_explains_missing_prerequisites_before_submission() {
    let (_dir, app, server) = setup();
    let project = create(&app, &server).await;
    let path = format!("/content/projects/{}", project.id);
    let html = server.get(&path).await.text();
    assert!(html.contains("Save a brand profile before approving evidence."));
    assert!(html.contains("href=\"/content#brand-profile\""));
    let document = scraper::Html::parse_document(&html);
    let review = scraper::Selector::parse(&format!(
        "form[action='{path}/review'] button[disabled][aria-describedby]"
    ))
    .unwrap();
    assert_eq!(document.select(&review).count(), 1);
    brand(&server).await;
    let html = server.get(&path).await.text();
    assert_eq!(
        scraper::Html::parse_document(&html).select(&review).count(),
        0
    );
    server
        .post(&format!("{path}/review"))
        .form(&[("revision", "1")])
        .await
        .assert_status_see_other();
    let saved = app
        .db
        .get::<Project>("content.project", &project.id)
        .await
        .unwrap()
        .unwrap();
    assert!(saved.current().evidence_reviewed);
    assert_eq!(saved.current().brand.as_ref().unwrap().name, "Found42");
}
