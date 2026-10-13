//! Verify the production Mistral request shape through Wiremock and the real
//! diagnostic route, including content parts, schemas and failure boundaries.

use axum_test::TestServer;
use tempfile::TempDir;
use wiremock::matchers::{body_partial_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use chief_of_rust::{App, Config, db::Db, llm};

#[tokio::test]
async fn mistral_large_4_answers_through_wiremock() {
    let mock = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .and(header("authorization", "Bearer test-key"))
        .and(body_partial_json(
            serde_json::json!({"model":"mistral-large-4"}),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "chatcmpl-test",
            "object": "chat.completion",
            "created": 1_700_000_000,
            "model": "mistral-large-4",
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
        llm_provider: "mistral".into(),
        mistral_api_key: Some("test-key".into()),
        openrouter_api_key: None,
        typesafe_base_url: None,
        mistral_base_url: Some(mock.uri()),
        mistral_model: "mistral-large-4".into(),
        google_secret_path: None,
        google_token_path: dir.path().join("token.json"),
    };
    let db = Db::open(&cfg.db_path()).unwrap();
    let app = App {
        judge: chief_of_rust::judgments::from_config(&cfg),
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

    // The record names the production provider rather than a test fallback.
    let stats = db.stats().await.unwrap();
    let call = stats.last_call.expect("recorded");
    assert_eq!(call.provider, "mistral");
    assert_eq!(call.prompt, "hi");
}

#[tokio::test]
async fn mistral_schema_and_text_chunks_preserve_answer_without_reasoning() {
    use chief_of_rust::llm::{LlmProvider, MistralLlm};
    let mock = MockServer::start().await;
    let schema = serde_json::json!({"type":"object","properties":{"source_ids":{"type":"array","maxItems":0}},"required":["source_ids"],"additionalProperties":false});
    Mock::given(method("POST")).and(path("/chat/completions"))
        .and(body_partial_json(serde_json::json!({"model":"mistral-large-4","reasoning_effort":"none","response_format":{"type":"json_schema","json_schema":{"name":"workspace_result","strict":true,"schema":schema}}})))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"choices":[{"finish_reason":"stop","message":{"content":[{"type":"thinking","thinking":[{"type":"text","text":"Private provider reasoning must not enter the artifact."}]},{"type":"text","text":"{\"source_ids\":[]}"}]}}]})))
        .expect(1).mount(&mock).await;
    let provider = MistralLlm::new("fake-key", Some(&mock.uri())).unwrap();
    let answer = provider
        .complete_schema("Return JSON with source_ids empty", &schema)
        .await
        .unwrap();
    assert_eq!(answer, "{\"source_ids\":[]}");
    assert!(!answer.contains("reasoning"));
}
#[tokio::test]
async fn truncated_mistral_output_is_a_failure_without_a_second_request() {
    use chief_of_rust::llm::{LlmProvider, MistralLlm};
    let mock = MockServer::start().await;
    Mock::given(method("POST")).and(path("/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"choices":[{"finish_reason":"length","message":{"content":"Incomplete content"}}]})))
        .expect(1).mount(&mock).await;
    let provider = MistralLlm::new("fake-key", Some(&mock.uri())).unwrap();
    assert!(
        provider
            .complete("A bounded request")
            .await
            .unwrap_err()
            .to_string()
            .contains("truncated")
    );
}
