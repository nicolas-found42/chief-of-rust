//! Product generation measurements through the real provider and recorder ports.
use chief_of_rust::{Config, connection::EventRecorder, llm};
use serde_json::json;
use std::sync::Arc;
use wiremock::{Mock, MockServer, ResponseTemplate, matchers::method};

#[tokio::test]
async fn every_generation_shape_preserves_provider_usage_without_secrets() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "choices":[{"finish_reason":"stop","message":{"content":"{\"ok\":true}"}}],
            "usage":{"prompt_tokens":13,"completion_tokens":7,"cost":0.004}
        })))
        .expect(4)
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = Config::for_workspace(dir.path().into());
    cfg.llm_provider = "opencode".into();
    cfg.opencode.model = "beam-free".into();
    cfg.opencode.reasoning_effort = "low".into();
    cfg.opencode.api_key = Some("known-generation-secret".into());
    cfg.opencode.base_url = Some(server.uri());
    let recorder = Arc::new(EventRecorder::default());
    let provider = llm::recorded(llm::from_config(&cfg), recorder.clone());
    let prompt = "private-contact@example.com known-generation-secret";
    let schema = json!({"type":"object"});
    provider.complete(prompt).await.unwrap();
    provider.complete_json(prompt).await.unwrap();
    provider.complete_schema(prompt, &schema).await.unwrap();
    provider
        .complete_measured_schema(prompt, &schema)
        .await
        .unwrap();
    let usage = recorder.usage_summary().unwrap();
    assert_eq!(usage["llm_input_tokens"], 52);
    assert_eq!(usage["llm_output_tokens"], 28);
    assert_eq!(usage["llm_cost_usd"], 0.016);
    assert_eq!(usage["generation_calls"].as_array().unwrap().len(), 4);
    for call in usage["generation_calls"].as_array().unwrap() {
        assert_eq!(call["input_tokens"], 13);
        assert_eq!(call["output_tokens"], 7);
    }
    let stored = usage.to_string();
    assert!(!stored.contains("known-generation-secret"));
    assert!(!stored.contains("private-contact@example.com"));
}

#[tokio::test]
async fn rejected_billed_responses_keep_usage_and_unknown_calls_stay_explicit() {
    for model in ["beam-free", "gpt-6-luna"] {
        let server = MockServer::start().await;
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = Config::for_workspace(dir.path().into());
        cfg.llm_provider = "opencode".into();
        cfg.opencode.model = model.into();
        cfg.opencode.reasoning_effort = "low".into();
        cfg.opencode.api_key = Some("known-generation-secret".into());
        cfg.opencode.base_url = Some(server.uri());
        let response = if model.starts_with("gpt-") {
            json!({"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"{\"ok\":false}"}]}],"usage":{"input_tokens":19,"output_tokens":11,"cost":0.002}})
        } else {
            json!({"choices":[{"finish_reason":"stop","message":{"content":"{\"ok\":false}"}}],"usage":{"prompt_tokens":19,"completion_tokens":11,"cost":0.002}})
        };
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_json(response))
            .mount(&server)
            .await;
        let recorder = Arc::new(EventRecorder::default());
        let provider = llm::recorded(llm::from_config(&cfg), recorder.clone());
        let schema = json!({"type":"object","properties":{"ok":{"const":true}},"required":["ok"]});
        assert!(
            provider
                .complete_schema("private prompt", &schema)
                .await
                .is_err()
        );
        let usage = recorder.usage_summary().unwrap();
        assert_eq!(usage["llm_input_tokens"], 19);
        assert_eq!(usage["llm_output_tokens"], 11);
        assert_eq!(usage["llm_cost_usd"], 0.002);
        assert_eq!(
            usage["generation_calls"][0]["outcome"],
            "failed_or_cancelled"
        );
        server.reset().await;
        // A client error is not transient: it fails at once and stays explicit.
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(400))
            .expect(1)
            .mount(&server)
            .await;
        assert!(provider.complete("private prompt").await.is_err());
        let usage = recorder.usage_summary().unwrap();
        assert_eq!(usage["llm_calls"], 2);
        assert_eq!(usage["llm_input_tokens"], 19);
        assert_eq!(usage["llm_unmeasured_calls"], 1);
        assert_eq!(usage["llm_cost_usd"], serde_json::Value::Null);
        assert_eq!(
            usage["generation_calls"][1]["input_tokens"],
            serde_json::Value::Null
        );
    }
}

#[tokio::test]
async fn cancelled_and_retried_requests_are_not_lost() {
    use chief_of_rust::llm::{LlmProvider, MistralLlm};
    use std::time::Duration;
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(1)))
        .mount(&server)
        .await;
    let recorder = Arc::new(EventRecorder::default());
    let provider = llm::recorded(
        Arc::new(MistralLlm::new("known-generation-secret", &server.uri()).unwrap()),
        recorder.clone(),
    );
    assert!(
        tokio::time::timeout(
            Duration::from_millis(40),
            provider.complete("private prompt")
        )
        .await
        .is_err()
    );
    let usage = recorder.usage_summary().unwrap();
    assert_eq!(usage["llm_calls"], 1);
    assert_eq!(usage["llm_unmeasured_calls"], 1);
    assert_eq!(
        usage["generation_calls"][0]["outcome"],
        "failed_or_cancelled"
    );
    server.reset().await;
    let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    Mock::given(method("POST")).respond_with(move |_: &wiremock::Request| {
        if attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
            ResponseTemplate::new(429).insert_header("Retry-After", "0")
        } else {
            ResponseTemplate::new(200).set_body_json(json!({"choices":[{"finish_reason":"stop","message":{"content":"ok"}}],"usage":{"prompt_tokens":5,"completion_tokens":3}}))
        }
    }).expect(2).mount(&server).await;
    provider.complete("private prompt").await.unwrap();
    let usage = recorder.usage_summary().unwrap();
    assert_eq!(usage["llm_calls"], 3);
    assert_eq!(usage["llm_unmeasured_calls"], 2);
    assert_eq!(usage["llm_input_tokens"], 5);
    assert_eq!(usage["llm_output_tokens"], 3);
    assert_eq!(usage["llm_cost_usd"], serde_json::Value::Null);
    let timed = MistralLlm::new("known-generation-secret", &server.uri())
        .unwrap()
        .with_request_timeout(Duration::from_millis(50))
        .unwrap();
    let recorder = Arc::new(EventRecorder::default());
    let timed = llm::recorded(timed, recorder.clone());
    server.reset().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(300)))
        .mount(&server)
        .await;
    assert!(timed.complete("private prompt").await.is_err());
    assert_eq!(recorder.usage_summary().unwrap()["llm_unmeasured_calls"], 2);
}

#[tokio::test]
async fn in_flight_parallel_requests_are_present_before_cancellation_finishes() {
    use chief_of_rust::llm::MistralLlm;
    use std::time::Duration;
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(1)))
        .mount(&server)
        .await;
    let recorder = Arc::new(EventRecorder::default());
    let provider = llm::recorded(
        Arc::new(MistralLlm::new("known-generation-secret", &server.uri()).unwrap()),
        recorder.clone(),
    );
    let mut parallel = tokio::task::JoinSet::new();
    for _ in 0..2 {
        let provider = provider.clone();
        parallel.spawn(async move { provider.complete("private prompt").await });
    }
    tokio::time::timeout(Duration::from_secs(2), async {
        while server.received_requests().await.unwrap().len() < 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    // A failing sibling drops the JoinSet, but cancellation need not finish
    // before the worker snapshots the Run's usage (#61).
    tokio::time::sleep(Duration::from_millis(15)).await;
    drop(parallel);
    let snapshot = recorder
        .usage_summary()
        .expect("started requests must already be recorded");
    assert_eq!(snapshot["llm_calls"], 2);
    assert_eq!(snapshot["llm_unmeasured_calls"], 2);
    assert!(snapshot["llm_elapsed_ms"].as_u64().unwrap() >= 20);
    for call in snapshot["generation_calls"].as_array().unwrap() {
        assert!(call["elapsed_ms"].as_u64().unwrap() >= 10);
    }
    assert_eq!(snapshot["generation_calls"].as_array().unwrap().len(), 2);
}
