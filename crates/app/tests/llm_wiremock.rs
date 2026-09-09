//! The test story for real providers (survey #3): a wiremock server plays
//! the OpenAI-compatible chat endpoint, and the rig-backed provider answers
//! through the actual `/llm` route.

use axum_test::TestServer;
use tempfile::TempDir;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use chief_of_rust::{App, Config, db::Db, llm};

#[tokio::test]
async fn rig_provider_answers_through_wiremock() {
    let mock = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "chatcmpl-test",
            "object": "chat.completion",
            "created": 1_700_000_000,
            "model": "gpt-4o-mini",
            "system_fingerprint": null,
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": "[wiremock] hello from the fake"}
            }],
            "usage": {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3}
        })))
        .mount(&mock)
        .await;

    let dir = TempDir::new().unwrap();
    let cfg = Config {
        port: 0,
        workspace_dir: dir.path().to_path_buf(),
        llm_provider: "openai".into(),
        openai_api_key: Some("test-key".into()),
        openai_base_url: Some(mock.uri()),
        openai_model: "gpt-4o-mini".into(),
        google_secret_path: None,
        google_token_path: dir.path().join("token.json"),
        google_redirect_port: 4319,
    };
    let db = Db::open(&cfg.db_path()).unwrap();
    let app = App {
        cfg: cfg.clone(),
        db: db.clone(),
        llm: llm::from_config(&cfg),
    };
    let server = TestServer::new(chief_of_rust::routes::router(app));
    let response = server.post("/llm").form(&[("prompt", "hi")]).await;
    let html = response.text();
    assert!(
        html.contains("[wiremock] hello from the fake"),
        "reply: {html}"
    );

    // The exchange landed in the record under the openai provider name.
    let stats = db.stats().await.unwrap();
    let call = stats.last_call.expect("recorded");
    assert_eq!(call.provider, "openai");
    assert_eq!(call.prompt, "hi");
}
