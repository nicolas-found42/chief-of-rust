use chief_of_rust::judgments::{self, Evaluation, Judge, TypeSafe, Usage};
use chief_of_rust::{App, Config, collect::Pacer, db::Db, llm, work};
use serde_json::json;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{method, path},
};

#[test]
fn unknown_options_missing_answers_and_inconsistent_probabilities_fail_closed() {
    let q =
        json!({"category":{"type":"choice","instructions":"Choose","criteria":{"a":"A","b":"B"}}});
    let good =
        json!({"type":"choice","choice":"a","confidence":1.0,"probabilities":{"a":1.0,"b":0.0}});
    let mut e = Evaluation {
        model: "fixture".into(),
        warnings: Vec::new(),
        answers: std::collections::BTreeMap::from([("category".into(), good.clone())]),
        usage: Usage::default(),
    };
    assert!(judgments::validate(&q, &e).is_ok());
    for bad in [
        json!({"type":"choice","choice":"c","confidence":1.0,"probabilities":{"a":1.0,"b":0.0}}),
        json!({"type":"choice","choice":"a","confidence":1.0,"probabilities":{"a":0.5,"b":0.5}}),
        json!({"type":"choice","choice":"a","confidence":1.0,"probabilities":{"a":0.9,"b":0.9}}),
        json!({"type":"noul","noul":1.0}),
    ] {
        e.answers.insert("category".into(), bad);
        assert!(judgments::validate(&q, &e).is_err());
    }
    e.answers.clear();
    assert!(judgments::validate(&q, &e).is_err());
    e.answers.insert("category".into(), good);
    e.warnings.push(json!("truncated"));
    assert!(judgments::validate(&q, &e).is_err());
}
#[test]
fn score_arithmetic_and_credential_bearing_endpoints_are_rejected() {
    let q = json!({"degree":{"type":"score","instructions":"Rate","criteria":["Calm","Some friction","Hostile"]}});
    let mut e = Evaluation {
        model: "fixture".into(),
        warnings: Vec::new(),
        answers: std::collections::BTreeMap::from([(
            "degree".into(),
            json!({"type":"score","score":1.0,"confidence":1.0,"probabilities":{"0":0.0,"1":1.0,"2":0.0}}),
        )]),
        usage: Usage::default(),
    };
    assert!(judgments::validate(&q, &e).is_ok());
    e.answers.get_mut("degree").unwrap()["score"] = json!(2.0);
    assert!(judgments::validate(&q, &e).is_err());
    for base in [
        "http://public.example",
        "https://user:secret@example.test",
        "https://example.test?token=secret",
        "https://example.test#secret",
    ] {
        assert!(TypeSafe::new("fixture", Some(base)).is_err());
    }
    assert!(TypeSafe::new("", None).is_err());
}
#[tokio::test]
async fn malformed_json_and_success_status_errors_do_not_become_valid_judgments() {
    for body in [
        "not json",
        "{\"error\":\"private diagnostic\"}",
        "{\"model\":\"fixture\",\"answers\":{}}",
    ] {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/systemone"))
            .respond_with(ResponseTemplate::new(200).set_body_string(body))
            .mount(&server)
            .await;
        // The connection the installation composes: the adapter reads the
        // response, the decoration enforces the contract.
        let client = judgments::validated(std::sync::Arc::new(
            TypeSafe::new("fixture", Some(&server.uri())).unwrap(),
        ));
        let result = client
            .evaluate(
                json!({"text":"safe"}),
                json!({"yes":{"type":"noul","instructions":"Is there text?"}}),
            )
            .await;
        assert!(result.is_err());
        assert!(
            !result
                .unwrap_err()
                .to_string()
                .contains("private diagnostic")
        );
    }
}

/// A counting provider fixture: valid unless the state asks for a broken
/// answer set, so one test can assert both the cache and the contract check.
#[derive(Default)]
struct CountingJudge {
    calls: std::sync::atomic::AtomicUsize,
}

impl CountingJudge {
    fn calls(&self) -> usize {
        self.calls.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[async_trait::async_trait]
impl Judge for CountingJudge {
    async fn evaluate(
        &self,
        state: serde_json::Value,
        questions: serde_json::Value,
    ) -> anyhow::Result<Evaluation> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if state["unavailable"] == true {
            anyhow::bail!("provider unavailable");
        }
        let answers = if state["incomplete"] == true {
            // A truncated provider response: the requested answer is absent.
            std::collections::BTreeMap::new()
        } else if state["nonfinite"] == true {
            std::collections::BTreeMap::from([(
                "yes".to_owned(),
                json!({"type":"noul","noul":null}),
            )])
        } else if state["outofrange"] == true {
            std::collections::BTreeMap::from([(
                "yes".to_owned(),
                json!({"type":"noul","noul":1.5}),
            )])
        } else {
            questions
                .as_object()
                .unwrap()
                .keys()
                .map(|key| (key.clone(), json!({"type":"noul","noul":0.9})))
                .collect()
        };
        Ok(Evaluation {
            model: "counting-fixture".into(),
            warnings: Vec::new(),
            answers,
            usage: Usage::default(),
        })
    }
}

async fn run_scope_fixture(
    judge: std::sync::Arc<CountingJudge>,
) -> (tempfile::TempDir, App, work::Job) {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = Config::for_workspace(dir.path().to_owned());
    cfg.llm_provider = "test".into();
    let db = Db::open(&cfg.db_path()).unwrap();
    let job = work::enqueue(
        &db,
        "terminal.profile",
        "run-scope-fixture",
        json!({"request_id": "fixture"}),
    )
    .await
    .unwrap();
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        db,
        std::sync::Arc::new(llm::MockLlm),
        judge,
        std::sync::Arc::new(Pacer::system()),
    )
    .app();
    (dir, app, job)
}

#[tokio::test]
async fn a_run_scope_caches_judgments_and_does_not_survive_the_run() {
    let judge = std::sync::Arc::new(CountingJudge::default());
    let (_dir, app, job) = run_scope_fixture(judge.clone()).await;
    let run = app.for_run(&job);
    assert_eq!(run.run_id(), job.id);
    let state = json!({"sources":[{"id":"s1"}]});
    let questions = json!({"yes":{"type":"noul","instructions":"Is there text?"}});
    // The same judgment asked twice inside one Run — the repair path — is
    // computed once.
    let first = run
        .judge()
        .evaluate(state.clone(), questions.clone())
        .await
        .unwrap();
    assert_eq!(first.answers["yes"]["noul"], 0.9);
    run.judge()
        .evaluate(state.clone(), questions.clone())
        .await
        .unwrap();
    assert_eq!(judge.calls(), 1);
    // Changed input is a different judgment.
    run.judge()
        .evaluate(json!({"sources":[{"id":"s2"}]}), questions.clone())
        .await
        .unwrap();
    assert_eq!(judge.calls(), 2);
    // A failed request is not cached: a retry can still earn a new roll.
    for _ in 0..2 {
        assert!(
            run.judge()
                .evaluate(json!({"unavailable":true}), questions.clone())
                .await
                .is_err()
        );
    }
    assert_eq!(judge.calls(), 4);
    // A fresh Run starts with an empty cache, even for identical input.
    app.for_run(&job)
        .judge()
        .evaluate(state, questions)
        .await
        .unwrap();
    assert_eq!(judge.calls(), 5);
}

#[tokio::test]
async fn an_evaluation_that_breaks_its_questions_never_leaves_a_run_scope() {
    let judge = std::sync::Arc::new(CountingJudge::default());
    let (_dir, app, job) = run_scope_fixture(judge.clone()).await;
    let questions = json!({"yes":{"type":"noul","instructions":"Is there text?"}});
    let run = app.for_run(&job);
    // A valid evaluation still passes through the same scope.
    run.judge()
        .evaluate(json!({"sources":[]}), questions.clone())
        .await
        .unwrap();
    for state in [
        json!({"incomplete":true}),
        json!({"nonfinite":true}),
        json!({"outofrange":true}),
    ] {
        let error = run
            .judge()
            .evaluate(state, questions.clone())
            .await
            .expect_err("an answer set that breaks its questions must not be returned")
            .to_string();
        assert!(
            error.contains("incomplete answer set")
                || error.contains("probability")
                || error.contains("out of range"),
            "the contract error must be the reason: {error}"
        );
    }
    assert_eq!(judge.calls(), 4);
}
