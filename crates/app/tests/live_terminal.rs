//! Opt-in acceptance against configured real model, judgment and search providers.
//! Each invocation creates one subject in an isolated retained workspace so
//! its full evidence can be inspected before the next invocation.
use chief_of_rust::{
    App, Config,
    db::Db,
    terminal::automatic::{Candidate, Dossier, Request},
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
    if let Ok(contact) = std::env::var("TERMINAL_ACCEPT_OPERATOR_CONTACT") {
        let revision = chief_of_rust::settings::load(&app.db)
            .await
            .unwrap()
            .revision;
        server
            .post("/settings/contact")
            .form(&[
                ("revision", revision.to_string()),
                ("research_contact", contact),
            ])
            .await
            .assert_status_see_other();
    }
    let requested_kind = kind.clone();
    let requested_name = name.clone();
    let prior = if std::env::var("TERMINAL_ACCEPT_REFRESH").as_deref() == Ok("1") {
        Some(
            app.db
                .list::<Dossier>("terminal_dossier")
                .await
                .unwrap()
                .into_iter()
                .find(|d| d.identity.kind == kind && d.identity.name == name)
                .expect("Existing accepted dossier"),
        )
    } else {
        None
    };
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
    let request_id = if std::env::var("TERMINAL_ACCEPT_RETRY").as_deref() == Ok("1") {
        let request: Request = app
            .db
            .list("terminal_request")
            .await
            .unwrap()
            .into_iter()
            .find(|request: &Request| {
                request.status == "failed"
                    && request.identity.kind == requested_kind
                    && request.identity.name == requested_name
            })
            .unwrap();
        server
            .post(&format!("/runs/{}/retry", request.run_id))
            .await
            .assert_status_see_other();
        request.id
    } else if std::env::var("TERMINAL_ACCEPT_CANDIDATE").as_deref() == Ok("1") {
        let candidate: Candidate = app
            .db
            .list("terminal_candidate")
            .await
            .unwrap()
            .into_iter()
            .find(|candidate: &Candidate| {
                !candidate.dismissed
                    && candidate.identity.kind == requested_kind
                    && candidate.identity.name == requested_name
            })
            .expect("Sourced research candidate");
        server
            .post(&format!("/terminal/candidates/{}", candidate.id))
            .form(&[("action", "research")])
            .await
            .assert_status_see_other();
        app.db
            .get::<Candidate>("terminal_candidate", &candidate.id)
            .await
            .unwrap()
            .unwrap()
            .request_id
            .expect("Candidate research request")
    } else if let Some(prior) = &prior {
        let response = server
            .post(&format!(
                "/terminal/profiles/{}/{}/refresh",
                prior.identity.kind, prior.subject_id
            ))
            .await;
        response.assert_status_see_other();
        response
            .header("location")
            .to_str()
            .unwrap()
            .split("#request-")
            .nth(1)
            .unwrap()
            .to_owned()
    } else {
        let response = server.post("/terminal/intake").form(&fields).await;
        response.assert_status_see_other();
        response
            .header("location")
            .to_str()
            .unwrap()
            .split("#request-")
            .nth(1)
            .unwrap()
            .to_owned()
    };
    assert!(chief_of_rust::work::run_once(&app).await.unwrap());
    let request: Request = app
        .db
        .list("terminal_request")
        .await
        .unwrap()
        .into_iter()
        .find(|request: &Request| request.id == request_id)
        .unwrap();
    let output = root.join("acceptance").join(&request.id);
    std::fs::create_dir_all(&output).unwrap();
    std::fs::write(
        output.join("request.json"),
        serde_json::to_vec_pretty(&request).unwrap(),
    )
    .unwrap();
    let run = chief_of_rust::work::find(&app.db, &request.run_id)
        .await
        .unwrap()
        .unwrap();
    std::fs::write(
        output.join("run.json"),
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
        .find(|dossier: &Dossier| Some(&dossier.subject_id) == request.target_id.as_ref())
        .unwrap();
    assert!(!dossier.sources.is_empty());
    assert!(!dossier.body.trim().is_empty());
    if let Some(prior) = &prior {
        assert_eq!(dossier.subject_id, prior.subject_id);
        assert_ne!(dossier.id, prior.id);
        assert_eq!(dossier.subject_version, prior.subject_version + 1);
        let archived = root
            .join("archive")
            .join(&prior.identity.kind)
            .join(&prior.subject_id);
        let paths = std::fs::read_dir(archived)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(&prior.id)
            })
            .collect::<Vec<_>>();
        let json = paths
            .iter()
            .find(|path| path.extension().is_some_and(|e| e == "json"))
            .unwrap();
        let markdown = paths
            .iter()
            .find(|path| path.extension().is_some_and(|e| e == "md"))
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&std::fs::read(json).unwrap()).unwrap(),
            serde_json::to_value(prior).unwrap()
        );
        assert_eq!(std::fs::read_to_string(markdown).unwrap(), prior.body);
    }
    std::fs::write(
        output.join("dossier.json"),
        serde_json::to_vec_pretty(&dossier).unwrap(),
    )
    .unwrap();
    std::fs::write(output.join("dossier.md"), &dossier.body).unwrap();
    let candidates = app
        .db
        .list::<serde_json::Value>("terminal_candidate")
        .await
        .unwrap();
    std::fs::write(
        output.join("candidates.json"),
        serde_json::to_vec_pretty(&candidates).unwrap(),
    )
    .unwrap();
    println!("Acceptance evidence: {}", output.display());
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

#[tokio::test]
#[ignore = "uses configured live providers and existing checked acceptance dossiers"]
async fn live_terminal_report() {
    use serde_json::Value;
    let root = std::path::PathBuf::from(std::env::var("TERMINAL_ACCEPT_DIR").unwrap());
    let mut cfg = Config::from_env();
    cfg.workspace_dir = root.clone();
    cfg.terminal_archive_dir = root.join("archive");
    cfg.google_token_path = root.join("credentials/google.json");
    assert_ne!(cfg.llm_provider, "mock");
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
    let subjects = std::env::var("TERMINAL_ACCEPT_SUBJECTS").unwrap();
    let mut fields = subjects
        .split(',')
        .enumerate()
        .map(|(i, s)| (format!("subject_{}", i + 1), s.to_owned()))
        .collect::<Vec<_>>();
    fields.push((
        "question".into(),
        std::env::var("TERMINAL_ACCEPT_QUESTION").unwrap(),
    ));
    let before: Vec<Dossier> = app.db.list("terminal_dossier").await.unwrap();
    let response = server.post("/terminal/reports").form(&fields).await;
    response.assert_status_see_other();
    let location = response.header("location").to_str().unwrap().to_owned();
    let id = location.rsplit('/').next().unwrap();
    assert!(chief_of_rust::work::run_once(&app).await.unwrap());
    let report: Value = app.db.get("terminal_report", id).await.unwrap().unwrap();
    let run = chief_of_rust::work::find(&app.db, report["run_id"].as_str().unwrap())
        .await
        .unwrap()
        .unwrap();
    let output = root.join("acceptance").join(id);
    std::fs::create_dir_all(&output).unwrap();
    std::fs::write(
        output.join("run.json"),
        serde_json::to_vec_pretty(&run).unwrap(),
    )
    .unwrap();
    std::fs::write(
        output.join("report.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    assert_eq!(run.status, "done", "{}", run.error.unwrap_or_default());
    assert!(!report["body"].as_str().unwrap().is_empty());
    let after: Vec<Dossier> = app.db.list("terminal_dossier").await.unwrap();
    assert_eq!(
        serde_json::to_value(before).unwrap(),
        serde_json::to_value(after).unwrap()
    );
    println!("Acceptance evidence: {}", output.display());
}
