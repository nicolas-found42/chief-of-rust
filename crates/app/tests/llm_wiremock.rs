//! Verify the production Mistral request shape through Wiremock and the real
//! diagnostic route, including content parts, schemas and failure boundaries.

use axum_test::TestServer;
use tempfile::TempDir;
use wiremock::matchers::{body_partial_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use chief_of_rust::{Config, db::Db, llm};

#[tokio::test]
async fn mistral_rate_limits_retry_and_honor_the_provider_delay_budget() {
    use chief_of_rust::llm::{LlmProvider, MistralLlm};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    // A rate limit is retried up to three times with the provider's own
    // pacing; an unreadable or over-budget delay fails at once instead.
    for (delay, persistent, expected_calls, succeeds) in [
        ("0", false, 2, true),
        ("0", true, 4, false),
        ("61", false, 1, false),
        ("Thu, 01 Jan 1970 00:00:00 GMT", false, 2, true),
        ("unreadable-delay", false, 1, false),
    ] {
        let server = MockServer::start().await;
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        Mock::given(method("POST")).and(path("/chat/completions"))
            .respond_with(move |_: &wiremock::Request| {
                if seen.fetch_add(1, Ordering::SeqCst) == 0 || persistent {
                    ResponseTemplate::new(429).insert_header("Retry-After", delay)
                } else {
                    ResponseTemplate::new(200).set_body_json(serde_json::json!({"choices":[{"finish_reason":"stop","message":{"content":"Recovered"}}]}))
                }
            }).mount(&server).await;
        let provider = MistralLlm::new("fake-key", &server.uri()).unwrap();
        let result = provider.complete("Bounded rate-limit recovery").await;
        assert_eq!(result.is_ok(), succeeds);
        assert_eq!(calls.load(Ordering::SeqCst), expected_calls);
    }
}

#[tokio::test]
async fn mistral_transient_server_errors_retry_instead_of_discarding_the_run() {
    use chief_of_rust::llm::{LlmProvider, MistralLlm};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    // A Run holds twenty minutes of retained evidence. One overloaded provider
    // response must not discard it, so 5xx is retried with backoff, while a
    // client error still fails immediately.
    for (status, expected_calls, succeeds) in [(503, 2, true), (500, 2, true), (502, 2, true)] {
        let server = MockServer::start().await;
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(move |_: &wiremock::Request| {
                if seen.fetch_add(1, Ordering::SeqCst) == 0 {
                    ResponseTemplate::new(status)
                } else {
                    ResponseTemplate::new(200).set_body_json(
                        serde_json::json!({"choices":[{"finish_reason":"stop","message":{"content":"Recovered"}}]}),
                    )
                }
            })
            .mount(&server)
            .await;
        let provider = MistralLlm::new("fake-key", &server.uri()).unwrap();
        assert_eq!(
            provider
                .complete("Transient provider recovery")
                .await
                .is_ok(),
            succeeds
        );
        assert_eq!(calls.load(Ordering::SeqCst), expected_calls);
    }
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(503))
        .expect(4)
        .mount(&server)
        .await;
    let provider = MistralLlm::new("fake-key", &server.uri()).unwrap();
    assert!(provider.complete("Persistent outage").await.is_err());
}

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
    let mut cfg = Config::for_workspace(dir.path().to_path_buf());
    cfg.llm_provider = "mistral".into();
    cfg.mistral.api_key = Some("test-key".into());
    cfg.mistral.base_url = Some(mock.uri());
    let db = Db::open(&cfg.db_path()).unwrap();
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        db.clone(),
        llm::from_config(&cfg),
        chief_of_rust::judgments::from_config(&cfg),
        std::sync::Arc::new(chief_of_rust::collect::Pacer::system()),
    )
    .app();
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
    let provider = MistralLlm::new("fake-key", &mock.uri()).unwrap();
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
    let provider = MistralLlm::new("fake-key", &mock.uri()).unwrap();
    assert!(
        provider
            .complete("A bounded request")
            .await
            .unwrap_err()
            .to_string()
            .contains("truncated")
    );
}

#[tokio::test]
async fn mistral_transport_timeout_gets_one_bounded_retry_with_the_same_contract() {
    use chief_of_rust::llm::{LlmProvider, MistralLlm};
    let mock = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .and(body_partial_json(
            serde_json::json!({"model":"mistral-large-4"}),
        ))
        .respond_with(ResponseTemplate::new(200).set_delay(std::time::Duration::from_millis(200)))
        .expect(2)
        .mount(&mock)
        .await;
    let provider = MistralLlm::new("fake-key", &mock.uri()).unwrap();
    let provider = provider
        .with_request_timeout(std::time::Duration::from_millis(50))
        .unwrap();
    assert!(
        provider
            .complete("Generate text")
            .await
            .unwrap_err()
            .to_string()
            .contains("timed out")
    );
    assert_eq!(mock.received_requests().await.unwrap().len(), 2);
}
