//! Opt-in live acceptance tests. No API key or provider response is printed.
//! Ordinary CI uses fixtures; run these explicitly with the key of the provider
//! `LLM_PROVIDER` selects (`OPENCODE_API_KEY` for the default `opencode`).
use chief_of_rust::{
    App, Config,
    content::Project,
    db::Db,
    llm,
    meetings::{Artifact, Meeting, Transcript},
    people::{Dossier, Person},
    work,
};
use rusqlite::Connection;
use serde_json::{Value, json};
use tempfile::TempDir;

/// The installation variable that enables the provider the environment selected,
/// named here so the acceptance failure says which one is missing.
fn key_variable(provider: &str) -> &'static str {
    match provider {
        "mistral" => "MISTRAL_API_KEY",
        "opencode" => "OPENCODE_API_KEY",
        "zai" => "ZAI_API_KEY",
        "ollama-cloud" => "OLLAMA_CLOUD_API_KEY",
        other => panic!("LLM_PROVIDER={other} has no live generation suite"),
    }
}

fn setup() -> (TempDir, App, axum_test::TestServer) {
    let dir = TempDir::new().unwrap();
    let mut cfg = Config::from_env();
    cfg.workspace_dir = dir.path().to_owned();
    cfg.google_token_path = dir.path().join("token.json");
    let key = key_variable(&cfg.llm_provider);
    assert!(
        cfg.llm_key().is_some(),
        "{key} is required for the live suite selected by LLM_PROVIDER={}",
        cfg.llm_provider
    );
    let app = App {
        pacer: std::sync::Arc::new(chief_of_rust::collect::Pacer::system()),
        judge: chief_of_rust::judgments::from_config(&cfg),
        db: Db::open(&cfg.db_path()).unwrap(),
        llm: llm::from_config(&cfg),
        cfg,
    };
    let server = axum_test::TestServer::new(chief_of_rust::routes::router(app.clone()));
    (dir, app, server)
}

/// The provider and model each attempt used, as the durable record holds them.
fn recorded_attempts(app: &App) -> Vec<(String, String)> {
    let conn = Connection::open(app.cfg.db_path()).unwrap();
    let mut stmt = conn
        .prepare("SELECT provider,model FROM job_attempt")
        .unwrap();
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    rows.collect::<rusqlite::Result<Vec<_>>>().unwrap()
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
    // The run's own record must name the configured provider and model, not a
    // fixture or a substitution, so nothing here compares against a literal.
    for (provider, model) in recorded_attempts(app) {
        assert_eq!(provider, app.cfg.llm_provider);
        assert_eq!(model, app.cfg.llm_model());
    }
}

#[tokio::test]
#[ignore = "Explicit live generation acceptance test for the provider LLM_PROVIDER selects"]
async fn live_meeting_brief_debrief_and_weekly_review_use_the_selected_model() {
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
            .all(|a| a.provider == app.cfg.llm_provider && !a.body.is_empty())
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
        "PASS: live meeting brief, debrief with proposals, reviewed weekly summary on {}/{}",
        app.cfg.llm_provider,
        app.cfg.llm_model()
    );
}

#[tokio::test]
#[ignore = "Explicit live generation acceptance test for the provider LLM_PROVIDER selects"]
async fn live_people_dossier_and_reviewed_content_export_use_the_selected_model() {
    let (_dir, app, server) = setup();
    let model = app.cfg.llm_model().to_owned();
    server
        .post("/terminal/people")
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
    server.post(&format!("/terminal/people/{}/evidence",person.id)).form(&[("title","Owner supplied meeting notes"),("kind","manual"),("text","Alex Example leads Example Studio. Alex said, I prefer weekly written updates and concrete examples when discussing proposals.")]).await.assert_status_see_other();
    server
        .post(&format!("/terminal/people/{}/research", person.id))
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
        assert_eq!(artifact.model, model);
        server
            .post(&format!("{base}/approve/{}", artifact.id))
            .form(&[("revision", "1")])
            .await
            .assert_status_see_other();
    }
    let export = server.get(&format!("{base}/export")).await;
    export.assert_status_ok();
    assert!(export.text().contains(&model));
    assert!(!export.text().contains("[mock]"));
    println!(
        "PASS: live quoted dossier, reviewed outline, reviewed draft export on {}/{}",
        app.cfg.llm_provider, model
    );
}

/// The default generation model's wire contract, exercised apart from the
/// workflows: OpenCode serves non-GPT models such as `beam-free` over Chat
/// Completions, and both ends of the catalog's effort range must work there.
#[tokio::test]
#[ignore = "Explicit live OpenCode beam-free wire contract request"]
async fn live_beam_free_plain_and_schema_completions_use_chat_completions() {
    let mut cfg = Config::from_env();
    assert!(
        cfg.opencode.api_key.is_some(),
        "OPENCODE_API_KEY is required for the beam-free wire contract"
    );
    // The wire contract belongs to OpenCode, so it holds even when LLM_PROVIDER
    // selects another provider for the workflow suites.
    cfg.llm_provider = "opencode".into();
    cfg.opencode.model = "beam-free".into();
    let schema = json!({"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false});
    for effort in ["low", "max"] {
        cfg.opencode.reasoning_effort = effort.into();
        let provider = llm::from_config(&cfg)
            .for_session("live-beam-free")
            .unwrap();
        let text = provider
            .complete("Reply with exactly the word READY.")
            .await
            .unwrap();
        assert!(!text.trim().is_empty(), "effort {effort} returned no text");
        // The adapter returns only choices[0].message.content, so equality here
        // also fails if a reasoning trace were concatenated into the text.
        assert!(
            text.trim()
                .trim_end_matches('.')
                .eq_ignore_ascii_case("READY"),
            "effort {effort} did not follow the text contract"
        );
        // The measured schema call must report usage and return only the JSON
        // contract, so a leaked reasoning trace could not pass this comparison.
        let measured = provider
            .complete_measured_schema("Return a JSON object with ok set to true.", &schema)
            .await
            .unwrap();
        assert!(
            measured.usage.input_tokens > 0 && measured.usage.output_tokens > 0,
            "effort {effort} reported {} input and {} output tokens",
            measured.usage.input_tokens,
            measured.usage.output_tokens
        );
        let parsed: Value = serde_json::from_str(&measured.text).unwrap();
        assert_eq!(parsed, json!({"ok":true}));
        println!(
            "PASS: beam-free effort {effort} plain and schema Chat Completions; tokens={}/{}",
            measured.usage.input_tokens, measured.usage.output_tokens
        );
    }
}

/// An effort outside the catalog must fail before any request leaves the process.
#[test]
#[ignore = "Explicit live OpenCode beam-free wire contract check"]
fn live_beam_free_unsupported_effort_is_refused_locally() {
    let mut cfg = Config::from_env();
    // No request is sent: the effort is rejected while the adapter is built, so
    // this placeholder key never reaches OpenCode.
    cfg.opencode.api_key = Some("refused-before-the-request".into());
    cfg.opencode.model = "beam-free".into();
    cfg.opencode.reasoning_effort = "none".into();
    let Err(error) = llm::providers::LiveLlm::new("opencode", &cfg.opencode) else {
        panic!("beam-free must refuse an unsupported effort locally");
    };
    let error = error.to_string();
    assert!(error.contains("Reasoning effort"), "{error}");
}
