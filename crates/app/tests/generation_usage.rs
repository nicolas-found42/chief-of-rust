//! Product generation measurements through the real provider and recorder ports.
use chief_of_rust::{Config, connection::EventRecorder, llm};
use serde_json::json;
use std::sync::Arc;
use wiremock::{Mock, MockServer, ResponseTemplate, matchers::method};

#[tokio::test]
async fn length_limited_generation_recovers_without_returning_partial_output() {
    for model in ["beam-free", "gpt-6-luna"] {
        let server = MockServer::start().await;
        let responses = model.starts_with("gpt-");
        let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        Mock::given(method("POST")).respond_with(move |_: &wiremock::Request| {
            let truncated = attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0;
            let text = if truncated { r#"{"revision":"partial"}"# } else { r#"{"revision":"complete"}"# };
            let response = if responses {
                json!({"status":if truncated {"incomplete"} else {"completed"},"incomplete_details":if truncated {json!({"reason":"max_output_tokens"})} else {serde_json::Value::Null},"output":[{"type":"message","content":[{"type":"output_text","text":text}]}],"usage":{"input_tokens":23,"output_tokens":if truncated {8192} else {20},"cost":0.001}})
            } else {
                json!({"choices":[{"finish_reason":if truncated {"length"} else {"stop"},"message":{"content":text}}],"usage":{"prompt_tokens":23,"completion_tokens":if truncated {8192} else {20},"cost":0.001}})
            };
            ResponseTemplate::new(200).set_body_json(response)
        }).expect(2).mount(&server).await;
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = Config::for_workspace(dir.path().into());
        cfg.llm_provider = "opencode".into();
        cfg.opencode.model = model.into();
        cfg.opencode.reasoning_effort = "low".into();
        cfg.opencode.api_key = Some("known-generation-secret".into());
        cfg.opencode.base_url = Some(server.uri());
        let recorder = Arc::new(EventRecorder::default());
        let provider = llm::recorded(llm::from_config(&cfg), recorder.clone());
        let schema = json!({"type":"object","properties":{"revision":{"const":"complete"}},"required":["revision"]});
        let completion = provider
            .complete_measured_schema("private person research", &schema)
            .await
            .expect("A token-limited response must be retried before failing the research");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&completion.text).unwrap(),
            json!({"revision":"complete"})
        );
        let usage = recorder.usage_summary().unwrap();
        assert_eq!(usage["llm_calls"], 2);
        assert_eq!(usage["llm_input_tokens"], 46);
        assert_eq!(usage["llm_output_tokens"], 8212);
        assert_eq!(
            usage["generation_calls"][0]["outcome"],
            "failed_or_cancelled"
        );
        assert_eq!(usage["generation_calls"][1]["outcome"], "succeeded");
        assert!(
            usage["generation_calls"][0]["cause"]
                .as_str()
                .unwrap()
                .contains("retrying with 16384")
        );
        assert_eq!(completion.usage.input_tokens, 46);
        assert_eq!(completion.usage.output_tokens, 8212);
        assert_eq!(completion.usage.cost_usd, Some(0.002));
        let requests = server.received_requests().await.unwrap();
        let budget_field = if responses {
            "max_output_tokens"
        } else {
            "max_tokens"
        };
        let mut first: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
        let mut second: serde_json::Value = serde_json::from_slice(&requests[1].body).unwrap();
        assert_eq!(
            first.as_object_mut().unwrap().remove(budget_field),
            Some(json!(8192))
        );
        assert_eq!(
            second.as_object_mut().unwrap().remove(budget_field),
            Some(json!(16384))
        );
        assert_eq!(
            first, second,
            "Only output capacity may change during token recovery"
        );
        assert_eq!(
            requests[0].headers["x-opencode-session"],
            requests[1].headers["x-opencode-session"]
        );
        assert!(!usage.to_string().contains("private person research"));
        assert!(!usage.to_string().contains("known-generation-secret"));
    }
}

#[tokio::test]
async fn output_token_recovery_stops_at_its_ceiling_and_keeps_every_failed_call() {
    for model in ["beam-free", "gpt-6-luna"] {
        let server = MockServer::start().await;
        let responses = model.starts_with("gpt-");
        Mock::given(method("POST")).respond_with(move |request:&wiremock::Request| {
            let sent:serde_json::Value=serde_json::from_slice(&request.body).unwrap();
            let budget=sent[if responses {"max_output_tokens"} else {"max_tokens"}].as_u64().unwrap();
            ResponseTemplate::new(200).set_body_json(if responses {
                json!({"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[],"usage":{"input_tokens":23,"output_tokens":budget,"cost":0.001}})
            } else {
                json!({"choices":[{"finish_reason":"length","message":{"content":"partial output"}}],"usage":{"prompt_tokens":23,"completion_tokens":budget,"cost":0.001}})
            })
        }).expect(3).mount(&server).await;
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = Config::for_workspace(dir.path().into());
        cfg.llm_provider = "opencode".into();
        cfg.opencode.model = model.into();
        cfg.opencode.reasoning_effort = "low".into();
        cfg.opencode.api_key = Some("known-generation-secret".into());
        cfg.opencode.base_url = Some(server.uri());
        let recorder = Arc::new(EventRecorder::default());
        let provider = llm::recorded(llm::from_config(&cfg), recorder.clone());
        let error = provider
            .complete_json("private person research")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("32768-token output limit"));
        let requests = server.received_requests().await.unwrap();
        let budgets = requests
            .iter()
            .map(|request| {
                serde_json::from_slice::<serde_json::Value>(&request.body).unwrap()[if responses {
                    "max_output_tokens"
                } else {
                    "max_tokens"
                }]
                .as_u64()
                .unwrap()
            })
            .collect::<Vec<_>>();
        assert_eq!(budgets, [8192, 16384, 32768]);
        let usage = recorder.usage_summary().unwrap();
        assert_eq!(usage["llm_calls"], 3);
        assert_eq!(usage["llm_input_tokens"], 69);
        assert_eq!(usage["llm_output_tokens"], 57344);
        assert!(
            usage["generation_calls"]
                .as_array()
                .unwrap()
                .iter()
                .all(|call| call["outcome"] == "failed_or_cancelled")
        );
        assert!(!usage.to_string().contains("private person research"));
        assert!(!usage.to_string().contains("known-generation-secret"));
    }
}

#[tokio::test]
async fn refusals_and_unknown_incomplete_responses_are_not_token_retried() {
    let cases = [
        (
            "beam-free",
            json!({"choices":[{"finish_reason":"stop","message":{"refusal":"blocked","content":"{}"}}]}),
        ),
        (
            "gpt-6-luna",
            json!({"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"{}"},{"type":"refusal","refusal":"blocked"}]}]}),
        ),
        (
            "beam-free",
            json!({"choices":[{"finish_reason":"length","message":{"refusal":"blocked","content":"partial"}}]}),
        ),
        (
            "beam-free",
            json!({"choices":[{"finish_reason":"content_filter","message":{"content":"partial"}}]}),
        ),
        (
            "beam-free",
            json!({"choices":[{"message":{"content":"partial"}}]}),
        ),
        (
            "gpt-6-luna",
            json!({"status":"incomplete","incomplete_details":{"reason":"content_filter"},"output":[]}),
        ),
        ("gpt-6-luna", json!({"status":"incomplete","output":[]})),
        (
            "gpt-6-luna",
            json!({"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"message","content":[{"type":"refusal","refusal":"blocked"}]}]}),
        ),
    ];
    for (model, response) in cases {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_json(response))
            .expect(1)
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = Config::for_workspace(dir.path().into());
        cfg.llm_provider = "opencode".into();
        cfg.opencode.model = model.into();
        cfg.opencode.reasoning_effort = "low".into();
        cfg.opencode.api_key = Some("known-generation-secret".into());
        cfg.opencode.base_url = Some(server.uri());
        assert!(
            llm::from_config(&cfg)
                .complete_json("private person research")
                .await
                .is_err()
        );
    }
}

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
    // 200 ms keeps the request in flight past the 40 ms cancellation below
    // (and past reset()'s drain) without spending a second of wall clock.
    // Cancellation, unmeasured accounting and the Retry-After retry sequence
    // below are unchanged.
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(200)))
        .mount(&server)
        .await;
    let recorder = Arc::new(EventRecorder::default());
    let provider = llm::recorded(
        // Timing only: the cancelled first request leaves a pooled connection
        // that fails on reuse, so the single automatic transport retry fires;
        // shrinking its wait proves the same retry-and-accounting contract
        // without the 500 ms pause.
        MistralLlm::new("known-generation-secret", &server.uri())
            .unwrap()
            .with_transport_retry_delay(Duration::from_millis(1))
            .unwrap(),
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
        .unwrap()
        // Timing only: both timed-out attempts keep the unmeasured-usage
        // accounting below; shrinking the between-attempts wait proves the
        // same contract without the 500 ms product pause.
        .with_transport_retry_delay(Duration::from_millis(1))
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
    // The delay only has to keep both requests in flight while the poll loop
    // below observes them (sub-millisecond granularity); 100 ms does that
    // without spending a second of wall clock. The snapshot's lower bounds
    // (>= 20 ms, >= 10 ms) stay satisfied.
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(100)))
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

/// A failed generation call keeps its provider, outcome and cause in the
/// durable timeline, so a Run's attempt sequence explains which call failed.
#[tokio::test]
async fn failed_calls_keep_provider_and_cause_but_never_the_key() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(401))
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
    assert!(provider.complete("prompt").await.is_err());

    let usage = recorder.usage_summary().unwrap();
    let call = &usage["generation_calls"][0];
    assert_eq!(call["outcome"], "failed_or_cancelled");
    assert_eq!(call["provider"], "opencode");
    assert!(
        call["cause"].as_str().unwrap().contains("401"),
        "cause keeps the dependency outcome: {call}"
    );

    let events = recorder.drained_events();
    let failed = events
        .iter()
        .find(|event| event.stage == "generation")
        .expect("generation failure row");
    assert_eq!(failed.status, "failed_or_cancelled");
    assert_eq!(failed.action.as_deref(), Some("opencode"));
    assert!(failed.detail.as_deref().unwrap().contains("401"));
    assert!(
        failed.detail.as_deref().unwrap().len() <= 200,
        "cause is bounded"
    );
    assert!(!usage.to_string().contains("known-generation-secret"));
}

/// A transport failure must keep its underlying cause in the recorded text —
/// reqwest's own Display names only the URL, so the source chain is what
/// tells a refused connection apart from a timeout. Uses a closed port so
/// the failure is a connection refusal, deterministically, without a server.
#[tokio::test]
async fn transport_failure_records_the_underlying_source_cause() {
    // Port 9 (discard) is unassigned and closed on loopback.
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = Config::for_workspace(dir.path().into());
    cfg.llm_provider = "opencode".into();
    cfg.opencode.model = "beam-free".into();
    cfg.opencode.reasoning_effort = "low".into();
    cfg.opencode.api_key = Some("known-generation-secret".into());
    cfg.opencode.base_url = Some("http://127.0.0.1:9".into());
    let recorder = Arc::new(EventRecorder::default());
    let provider = llm::recorded(llm::from_config(&cfg), recorder.clone());
    assert!(provider.complete("prompt").await.is_err());

    let usage = recorder.usage_summary().unwrap();
    let cause = usage["generation_calls"][0]["cause"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        cause.contains("os error")
            || cause.contains("Connection refused")
            || cause.contains("connect"),
        "cause names the source chain, not just the URL: {cause}"
    );
    assert!(
        !usage.to_string().contains("known-generation-secret"),
        "keys stay out of cause text"
    );
}
