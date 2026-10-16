//! Opt-in acceptance against configured real model, judgment and search providers.
//! Each invocation creates one subject in an isolated retained workspace so
//! its full evidence can be inspected before the next invocation.
use chief_of_rust::{
    App, Config,
    db::Db,
    terminal::automatic::{Dossier, Request},
};

#[tokio::test]
#[ignore = "uses configured live providers; retains the isolated acceptance workspace"]
async fn live_terminal_dossier() {
    let kind = std::env::var("TERMINAL_ACCEPT_KIND").expect("TERMINAL_ACCEPT_KIND");
    let name = std::env::var("TERMINAL_ACCEPT_NAME").expect("TERMINAL_ACCEPT_NAME");
    let root = std::path::PathBuf::from(
        std::env::var("TERMINAL_ACCEPT_DIR").expect("TERMINAL_ACCEPT_DIR"),
    );
    let mut cfg = Config::from_env();
    cfg.workspace_dir = root.clone();
    cfg.terminal_archive_dir = root.join("archive");
    cfg.google_token_path = root.join("credentials/google.json");
    assert_ne!(
        cfg.llm_provider, "mock",
        "Live acceptance must use real providers"
    );
    std::fs::create_dir_all(&root).unwrap();
    let app = App {
        db: Db::open(&cfg.db_path()).unwrap(),
        llm: chief_of_rust::llm::from_config(&cfg),
        judge: std::sync::Arc::new(RecordedJudge {
            inner: chief_of_rust::judgments::from_config(&cfg),
            root: root.clone(),
        }),
        cfg,
    };
    let server = axum_test::TestServer::new(chief_of_rust::routes::router(app.clone()));
    let mut fields = vec![("kind".to_owned(), kind), ("name".to_owned(), name)];
    for field in [
        "website",
        "linkedin",
        "company",
        "role",
        "email",
        "phone",
        "jurisdiction",
    ] {
        if let Ok(value) = std::env::var(format!("TERMINAL_ACCEPT_{}", field.to_uppercase())) {
            fields.push((field.into(), value));
        }
    }
    if std::env::var("TERMINAL_ACCEPT_RETRY").as_deref() == Ok("1") {
        let request: Request = app
            .db
            .list("terminal_request")
            .await
            .unwrap()
            .into_iter()
            .next()
            .unwrap();
        server
            .post(&format!("/runs/{}/retry", request.run_id))
            .await
            .assert_status_see_other();
    } else {
        server
            .post("/terminal/intake")
            .form(&fields)
            .await
            .assert_status_see_other();
    }
    assert!(chief_of_rust::work::run_once(&app).await.unwrap());
    let request: Request = app
        .db
        .list("terminal_request")
        .await
        .unwrap()
        .into_iter()
        .next()
        .unwrap();
    std::fs::write(
        root.join("request.json"),
        serde_json::to_vec_pretty(&request).unwrap(),
    )
    .unwrap();
    let run = chief_of_rust::work::find(&app.db, &request.run_id)
        .await
        .unwrap()
        .unwrap();
    std::fs::write(
        root.join("run.json"),
        serde_json::to_vec_pretty(&run).unwrap(),
    )
    .unwrap();
    assert_eq!(run.status, "done", "{}", run.error.unwrap_or_default());
    assert_eq!(request.status, "complete", "{}", request.phase);
    let dossier: Dossier = app
        .db
        .list("terminal_dossier")
        .await
        .unwrap()
        .into_iter()
        .next()
        .unwrap();
    assert!(!dossier.sources.is_empty());
    assert!(!dossier.body.trim().is_empty());
    std::fs::write(
        root.join("dossier.json"),
        serde_json::to_vec_pretty(&dossier).unwrap(),
    )
    .unwrap();
    std::fs::write(root.join("dossier.md"), &dossier.body).unwrap();
    let candidates = app
        .db
        .list::<serde_json::Value>("terminal_candidate")
        .await
        .unwrap();
    std::fs::write(
        root.join("candidates.json"),
        serde_json::to_vec_pretty(&candidates).unwrap(),
    )
    .unwrap();
    println!("Acceptance evidence: {}", root.display());
}

// Retain the exact evidence presented to the live verifier, including rejected
// drafts, so acceptance failures can be diagnosed rather than blindly retried.
struct RecordedJudge {
    inner: std::sync::Arc<dyn chief_of_rust::judgments::Judge>,
    root: std::path::PathBuf,
}
#[async_trait::async_trait]
impl chief_of_rust::judgments::Judge for RecordedJudge {
    fn available(&self) -> bool {
        self.inner.available()
    }
    async fn evaluate(
        &self,
        state: serde_json::Value,
        questions: serde_json::Value,
    ) -> anyhow::Result<chief_of_rust::judgments::Evaluation> {
        let result = self.inner.evaluate(state.clone(), questions.clone()).await;
        let record = serde_json::json!({"state":state, "questions":questions, "result":result.as_ref().ok(), "error":result.as_ref().err().map(ToString::to_string)});
        std::fs::write(
            self.root
                .join(format!("judgment-{}.json", uuid::Uuid::new_v4())),
            serde_json::to_vec_pretty(&record)?,
        )?;
        result
    }
}
