//! Opt-in live acceptance tests. No API key or provider response is printed.
//! Ordinary CI uses fixtures; run these explicitly with MISTRAL_API_KEY set.
use chief_of_rust::{
    App, Config,
    content::Project,
    db::Db,
    llm,
    meetings::{Artifact, Meeting, Transcript},
    people::{Dossier, Person},
    work,
};
use tempfile::TempDir;
fn setup() -> (TempDir, App, axum_test::TestServer) {
    let dir = TempDir::new().unwrap();
    let mut cfg = Config::from_env();
    cfg.workspace_dir = dir.path().to_owned();
    cfg.google_token_path = dir.path().join("token.json");
    cfg.llm_provider = "mistral".into();
    assert!(
        cfg.mistral_api_key.is_some(),
        "MISTRAL_API_KEY is required for the opt-in live suite"
    );
    let app = App {
        judge: chief_of_rust::judgments::from_config(&cfg),
        db: Db::open(&cfg.db_path()).unwrap(),
        llm: llm::from_config(&cfg),
        cfg,
    };
    let server = axum_test::TestServer::new(chief_of_rust::routes::router(app.clone()));
    (dir, app, server)
}
async fn finish(app: &App) {
    assert!(work::run_once(app).await.unwrap());
    let jobs = work::list(&app.db).await.unwrap();
    let failed: Vec<_> = jobs.iter().filter(|j| j.status == "failed").collect();
    assert!(
        failed.is_empty(),
        "Live workflow failed: {}",
        failed
            .iter()
            .map(|j| format!("{}: {}", j.kind, j.error.as_deref().unwrap_or("unknown")))
            .collect::<Vec<_>>()
            .join("; ")
    );
}
#[tokio::test]
#[ignore = "Explicit live Mistral Large 4 acceptance test"]
async fn live_meeting_brief_debrief_and_weekly_review_use_large_4() {
    let (_dir, app, server) = setup();
    server
        .post("/meetings")
        .form(&[
            ("title", "Proposal review"),
            ("starts_at", "2026-10-13T14:00:00-04:00"),
            (
                "attendees",
                "Alex <alex@example.com>; Sam <sam@example.com>",
            ),
            ("purpose", "Agree proposal follow-through"),
        ])
        .await
        .assert_status_see_other();
    let meeting = app
        .db
        .list::<Meeting>("meeting")
        .await
        .unwrap()
        .pop()
        .unwrap();
    server.post("/transcripts").form(&[("title","Proposal review transcript"),("meeting_id",&meeting.id),("text","Alex: We agreed to a weekly check-in on the proposal. I will send the draft proposal by 2026-10-20. Sam: The budget is still unconfirmed; I will ask Finance for the budget before the next meeting.")]).await.assert_status_see_other();
    assert_eq!(
        app.db.list::<Transcript>("transcript").await.unwrap().len(),
        1
    );
    for kind in ["brief", "debrief"] {
        server
            .post(&format!("/meetings/{}/{kind}", meeting.id))
            .form(&[("revision", "1")])
            .await
            .assert_status_see_other();
        finish(&app).await;
    }
    let artifacts = app.db.list::<Artifact>("meeting_artifact").await.unwrap();
    assert_eq!(artifacts.len(), 2);
    assert!(
        artifacts
            .iter()
            .all(|a| a.provider == "mistral" && !a.body.is_empty())
    );
    let debrief = artifacts.iter().find(|a| a.kind == "debrief").unwrap();
    assert!(!debrief.actions.is_empty());
    server
        .post(&format!(
            "/meetings/{}/artifacts/{}/review",
            meeting.id, debrief.id
        ))
        .form(&[("selected", "")])
        .await
        .assert_status_see_other();
    server
        .post("/meetings/weekly")
        .form(&[("from", "2026-10-12"), ("to", "2026-10-18")])
        .await
        .assert_status_see_other();
    finish(&app).await;
    println!(
        "PASS: live Mistral Large 4 meeting brief, debrief with proposals, reviewed weekly summary"
    );
}
#[tokio::test]
#[ignore = "Explicit live Mistral Large 4 acceptance test"]
async fn live_people_dossier_and_reviewed_content_export_use_large_4() {
    let (_dir, app, server) = setup();
    server
        .post("/people")
        .form(&[
            ("name", "Alex Example"),
            ("email", "alex@example.com"),
            ("role", "Founder"),
            ("company", "Example Studio"),
        ])
        .await
        .assert_status_see_other();
    let person = app
        .db
        .list::<Person>("person")
        .await
        .unwrap()
        .pop()
        .unwrap();
    server.post(&format!("/people/{}/evidence",person.id)).form(&[("title","Owner supplied meeting notes"),("kind","manual"),("text","Alex Example leads Example Studio. Alex said, I prefer weekly written updates and concrete examples when discussing proposals.")]).await.assert_status_see_other();
    server
        .post(&format!("/people/{}/research", person.id))
        .form(&[
            ("question", "What communication preference did Alex state?"),
            ("search", "false"),
        ])
        .await
        .assert_status_see_other();
    finish(&app).await;
    let dossiers = app.db.list::<Dossier>("dossier").await.unwrap();
    assert_eq!(dossiers.len(), 1);
    assert!(!dossiers[0].claims.is_empty());
    server.post("/content/brand").form(&[("revision","0"),("name","Found42"),("audience","Technical founders"),("voice","Concrete first-person examples. Explain tradeoffs and distinguish observations from guesses."),("evidence","We build software and share our engineering decisions.")]).await.assert_status_see_other();
    server.post("/content/projects").form(&[("subject","Why we use explicit review steps for AI-generated work"),("objective","Explain a practical approach using our own experience in 300 words"),("audience","Technical founders"),("target","website-blog-article"),("material","Our experience: separate a generated proposal from an accepted commitment. We review transcript evidence before accepting a task. We keep the source snapshot after accepting the task so later source changes do not rewrite the commitment. These are our own implementation decisions, not measured claims about all users.")]).await.assert_status_see_other();
    let project = app
        .db
        .list::<Project>("content.project")
        .await
        .unwrap()
        .pop()
        .unwrap();
    let base = format!("/content/projects/{}", project.id);
    server
        .post(&format!("{base}/review"))
        .form(&[("revision", "1")])
        .await
        .assert_status_see_other();
    for stage in ["outline", "draft"] {
        server
            .post(&format!("{base}/generate/{stage}"))
            .form(&[("revision", "1")])
            .await
            .assert_status_see_other();
        finish(&app).await;
        let p: Project = app
            .db
            .get("content.project", &project.id)
            .await
            .unwrap()
            .unwrap();
        let artifact = p
            .current()
            .artifacts
            .iter()
            .rev()
            .find(|a| a.stage == stage)
            .unwrap();
        assert_eq!(artifact.model, "mistral-large-4");
        server
            .post(&format!("{base}/approve/{}", artifact.id))
            .form(&[("revision", "1")])
            .await
            .assert_status_see_other();
    }
    let export = server.get(&format!("{base}/export")).await;
    export.assert_status_ok();
    assert!(export.text().contains("mistral-large-4"));
    assert!(!export.text().contains("[mock]"));
    println!("PASS: live Mistral Large 4 quoted dossier, reviewed outline, reviewed draft export");
}
