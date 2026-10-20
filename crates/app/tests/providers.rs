use chief_of_rust::{Config, integrations, judgments, llm};
use serde_json::{Value, json};
use tempfile::TempDir;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{body_partial_json, header, method, path},
};

fn schema() -> Value {
    json!({"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false})
}

/// The provider table is the only owner of provider names, models, efforts and
/// endpoints: the selection accessors, the connection wiring and the settings
/// routes all read the same rows, so a new provider is added in one place.
#[test]
fn the_provider_table_is_the_only_provider_vocabulary() {
    let dir = TempDir::new().unwrap();
    let mut cfg = Config::for_workspace(dir.path().into());
    cfg.llm_provider = "ollama-cloud".into();
    cfg.ollama_cloud.api_key = Some("fixture-provider-key".into());
    cfg.ollama_cloud.base_url = Some("https://ollama.example:443/v1".into());

    let row = chief_of_rust::installation::provider(&cfg, "ollama-cloud").unwrap();
    assert_eq!(row.model, cfg.llm_model());
    assert_eq!(row.effort, cfg.llm_effort());
    assert_eq!(row.api_key, cfg.llm_key());
    assert_eq!(row.endpoint().unwrap(), "https://ollama.example:443/v1");

    // An endpoint the installation did not override resolves to the provider default.
    cfg.ollama_cloud.base_url = None;
    let row = chief_of_rust::installation::provider(&cfg, "ollama-cloud").unwrap();
    assert_eq!(row.endpoint().unwrap(), "https://ollama.com/v1");

    // A name without a row is not a provider, and reads as unavailable rather
    // than silently becoming one of the providers that does have a row.
    cfg.llm_provider = "not-a-provider".into();
    assert!(chief_of_rust::installation::provider(&cfg, "not-a-provider").is_none());
    assert_eq!(cfg.llm_model(), "unavailable");
    assert_eq!(cfg.llm_effort(), "none");
    assert_eq!(cfg.llm_key(), None);
    assert!(
        cfg.provider_keys().count() > 0,
        "the installation key must be reachable for redaction"
    );
}

#[tokio::test]
async fn selected_providers_use_their_model_reasoning_and_schema_contracts() {
    for (name, model, effort) in [
        ("opencode", "beam-free", "medium"),
        ("zai", "glm-5.3-flash", "low"),
        ("ollama-cloud", "deepseek-v4.1-flash:1017", "high"),
    ] {
        let server = MockServer::start().await;
        let dir = TempDir::new().unwrap();
        let mut cfg = Config::for_workspace(dir.path().into());
        cfg.llm_provider = name.into();
        let config = match name {
            "opencode" => &mut cfg.opencode,
            "zai" => &mut cfg.zai,
            _ => &mut cfg.ollama_cloud,
        };
        config.api_key = Some("fixture-provider-key".into());
        config.base_url = Some(server.uri());
        // The adapter's verified split: only the OpenCode GPT models use Responses.
        let responses = model.starts_with("gpt-");
        let request = if responses {
            json!({"model":model,"reasoning":{"effort":effort},"text":{"format":{"type":"json_schema","schema":schema()}}})
        } else if name == "zai" {
            json!({"model":model,"reasoning_effort":effort,"thinking":{"type":"enabled"},"response_format":{"type":"json_object"}})
        } else {
            json!({"model":model,"reasoning_effort":effort,"response_format":{"type":"json_schema","json_schema":{"schema":schema()}}})
        };
        let response = if responses {
            json!({"status":"completed","output":[{"type":"reasoning","summary":[{"text":"must not appear"}]},{"type":"message","content":[{"type":"output_text","text":"{\"ok\":true}"}]}],"usage":{"input_tokens":3,"output_tokens":5}})
        } else {
            json!({"choices":[{"finish_reason":"stop","message":{"content":"{\"ok\":true}","reasoning_content":"must not appear"}}],"usage":{"prompt_tokens":3,"completion_tokens":5}})
        };
        Mock::given(method("POST"))
            .and(path(if responses {
                "/responses"
            } else {
                "/chat/completions"
            }))
            .and(header("authorization", "Bearer fixture-provider-key"))
            .and(body_partial_json(request))
            .respond_with(ResponseTemplate::new(200).set_body_json(response))
            .expect(1)
            .mount(&server)
            .await;
        let provider = llm::from_config(&cfg);
        let provider = provider.for_session("fixture-run-session").unwrap();
        assert_eq!(provider.name(), name);
        assert_eq!(cfg.llm_model(), model);
        let result = provider
            .complete_measured_schema("Return JSON with ok true", &schema())
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&result.text).unwrap(),
            json!({"ok":true})
        );
        assert_eq!(result.usage.input_tokens, 3);
        assert_eq!(result.usage.output_tokens, 5);
        if name == "opencode" {
            let requests = server.received_requests().await.unwrap();
            assert_eq!(
                requests[0].headers["x-opencode-session"],
                "fixture-run-session"
            );
            assert_eq!(requests[0].headers["user-agent"], "chief-of-rust/0.1.0");
        }
    }
}

/// `beam-free` is the OpenCode model that offers `max`; the catalog gates it per model, and the
/// adapter rejects an effort outside the selected model's entry.
#[test]
fn opencode_beam_free_offers_max_reasoning_effort() {
    assert!(llm::catalog::models("opencode").contains(&"beam-free"));
    assert_eq!(
        llm::catalog::efforts("opencode", "beam-free"),
        ["low", "medium", "high", "max"].as_slice()
    );
    assert_eq!(
        llm::catalog::efforts("opencode", "gpt-6-luna"),
        ["low", "medium", "high"].as_slice()
    );
    let dir = TempDir::new().unwrap();
    let mut cfg = Config::for_workspace(dir.path().into());
    cfg.opencode.api_key = Some("fixture-opencode-key".into());
    cfg.opencode.model = "beam-free".into();
    cfg.opencode.reasoning_effort = "max".into();
    assert!(llm::providers::LiveLlm::new("opencode", &cfg.opencode).is_ok());
    cfg.opencode.model = "gpt-6-luna".into();
    assert!(llm::providers::LiveLlm::new("opencode", &cfg.opencode).is_err());
}

/// Pins the OpenCode protocol switch: only GPT models use Responses, so `beam-free` must POST
/// Chat Completions bodies and accept the `choices[0].message.content` reply.
#[tokio::test]
async fn opencode_beam_free_uses_chat_completions_while_gpt_models_use_responses() {
    for (model, effort) in [("beam-free", "max"), ("gpt-6-luna", "medium")] {
        let responses = model.starts_with("gpt-");
        let server = MockServer::start().await;
        let dir = TempDir::new().unwrap();
        let mut cfg = Config::for_workspace(dir.path().into());
        cfg.llm_provider = "opencode".into();
        cfg.opencode.model = model.into();
        cfg.opencode.reasoning_effort = effort.into();
        cfg.opencode.api_key = Some("fixture-opencode-key".into());
        cfg.opencode.base_url = Some(server.uri());
        let request = if responses {
            json!({"model":model,"reasoning":{"effort":effort},"text":{"format":{"type":"json_schema","schema":schema()}}})
        } else {
            json!({"model":model,"reasoning_effort":effort,"response_format":{"type":"json_schema","json_schema":{"schema":schema()}}})
        };
        let response = if responses {
            json!({"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"{\"ok\":true}"}]}],"usage":{"input_tokens":3,"output_tokens":5}})
        } else {
            json!({"choices":[{"finish_reason":"stop","message":{"content":"{\"ok\":true}","reasoning_content":"must not appear"}}],"usage":{"prompt_tokens":3,"completion_tokens":5}})
        };
        Mock::given(method("POST"))
            .and(path(if responses {
                "/responses"
            } else {
                "/chat/completions"
            }))
            .and(header("authorization", "Bearer fixture-opencode-key"))
            .and(header("x-opencode-session", "fixture-run-session"))
            .and(body_partial_json(request))
            .respond_with(ResponseTemplate::new(200).set_body_json(response))
            .expect(1)
            .mount(&server)
            .await;
        let provider = llm::from_config(&cfg);
        let result = provider
            .for_session("fixture-run-session")
            .unwrap()
            .complete_measured_schema("Return JSON with ok true", &schema())
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&result.text).unwrap(),
            json!({"ok":true})
        );
        assert_eq!(result.usage.input_tokens, 3);
        assert_eq!(result.usage.output_tokens, 5);
        let requests = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 1, "{model}");
        assert_eq!(requests[0].headers["user-agent"], "chief-of-rust/0.1.0");
        let sent: Value = serde_json::from_slice(&requests[0].body).unwrap();
        if responses {
            assert_eq!(requests[0].url.path(), "/responses");
            assert!(sent["input"].is_string() && sent.get("messages").is_none());
        } else {
            assert_eq!(requests[0].url.path(), "/chat/completions");
            assert_eq!(sent["reasoning_effort"], effort);
            assert_eq!(sent["messages"][0]["role"], "system");
            assert_eq!(sent["messages"][1]["content"], "Return JSON with ok true");
            assert!(
                sent.get("input").is_none() && sent.get("text").is_none(),
                "{model} must not send the Responses envelope: {sent}"
            );
        }
    }
}

#[tokio::test]
async fn provider_failures_and_invalid_contracts_do_not_fallback() {
    for name in ["opencode", "zai", "ollama-cloud"] {
        for mode in ["http", "schema", "truncated", "empty"] {
            let server = MockServer::start().await;
            let dir = TempDir::new().unwrap();
            let mut cfg = Config::for_workspace(dir.path().into());
            cfg.llm_provider = name.into();
            let config = match name {
                "opencode" => &mut cfg.opencode,
                "zai" => &mut cfg.zai,
                _ => &mut cfg.ollama_cloud,
            };
            config.api_key = Some("fixture-key".into());
            config.base_url = Some(server.uri());
            let content = if mode == "empty" {
                ""
            } else {
                "{\"ok\":\"wrong type\"}"
            };
            let responses = config.model.starts_with("gpt-");
            let response = if responses {
                json!({"status":if mode=="truncated" {"incomplete"} else {"completed"},"output":[{"type":"message","content":[{"type":"output_text","text":content}]}]})
            } else {
                json!({"choices":[{"finish_reason":if mode=="truncated" {"length"} else {"stop"},"message":{"content":content}}]})
            };
            Mock::given(method("POST"))
                .respond_with(
                    ResponseTemplate::new(if mode == "http" { 401 } else { 200 })
                        .set_body_json(response),
                )
                .expect(1)
                .mount(&server)
                .await;
            let error = llm::from_config(&cfg)
                .complete_schema("Return JSON", &schema())
                .await
                .unwrap_err()
                .to_string();
            assert!(!error.contains("fixture-key"));
        }
    }
}

#[tokio::test]
async fn jev_config_uses_explicit_key_model_and_endpoint_ahead_of_legacy_settings() {
    let server = MockServer::start().await;
    let dir = TempDir::new().unwrap();
    let mut cfg = Config::for_workspace(dir.path().into());
    cfg.jev_api_key = Some("explicit-key".into());
    cfg.openrouter_api_key = Some("legacy-key".into());
    cfg.jev_base_url = Some(server.uri());
    cfg.typesafe_base_url = Some("https://unused.invalid".into());
    cfg.jev_model = "fixture-jev".into();
    Mock::given(method("POST")).and(path("/v1/systemone")).and(header("authorization","Bearer explicit-key")).and(body_partial_json(json!({"model":"fixture-jev"}))).respond_with(ResponseTemplate::new(200).set_body_json(json!({"model":"fixture-jev","answers":{"ok":{"type":"noul","noul":0.99}},"usage":{"input_tokens":2,"output_tokens":3}}))).expect(1).mount(&server).await;
    let judge = judgments::from_config(&cfg);
    judge
        .evaluate(
            json!("fixture"),
            json!({"ok":{"type":"noul","instructions":"Is this a fixture?"}}),
        )
        .await
        .unwrap();
    cfg.jev_api_key = None;
    cfg.jev_base_url = Some(server.uri());
    Mock::given(method("POST"))
        .and(header("authorization", "Bearer legacy-key"))
        .respond_with(ResponseTemplate::new(401))
        .expect(1)
        .mount(&server)
        .await;
    assert!(
        judgments::from_config(&cfg)
            .evaluate(
                json!("fixture"),
                json!({"ok":{"type":"noul","instructions":"Is this a fixture?"}})
            )
            .await
            .is_err()
    );
}

#[tokio::test]
async fn firecrawl_search_preserves_existing_evidence_limits_and_fails_on_partial_coverage() {
    let server = MockServer::start().await;
    let dir = TempDir::new().unwrap();
    let mut cfg = Config::for_workspace(dir.path().into());
    cfg.firecrawl_api_key = Some("firecrawl-fixture-key".into());
    cfg.firecrawl_base_url = Some(server.uri());
    let mut rows: Vec<Value> = (0..14).map(|i|json!({"url":format!("https://example.com/{i}"),"title":"Source","description":"x".repeat(6100)})).collect();
    rows.push(rows[0].clone());
    rows.push(json!({"url":"http://127.0.0.1/private","description":"Private"}));
    Mock::given(method("POST"))
        .and(path("/search"))
        .and(header("authorization", "Bearer firecrawl-fixture-key"))
        .and(body_partial_json(
            json!({"limit":12,"sources":["web"],"domainTools":false,"highlights":false}),
        ))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"success":true,"data":{"web":rows}})),
        )
        .expect(1)
        .mount(&server)
        .await;
    let results = integrations::firecrawl_search(&cfg, "fixture")
        .await
        .unwrap();
    assert_eq!(results.hits.len(), 12);
    assert_eq!(results.coverage.omitted, 2);
    assert_eq!(results.coverage.duplicates, 1);
    assert_eq!(results.coverage.invalid, 1);
    assert!(results.hits.iter().all(|hit| hit.content.len() == 6000));
    server.reset().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"success":true,"warning":"partial","data":{"web":[]}})),
        )
        .mount(&server)
        .await;
    assert!(
        integrations::firecrawl_search(&cfg, "fixture")
            .await
            .is_err()
    );
}

#[test]
fn all_provider_keys_are_redacted_and_invalid_endpoints_rejected() {
    let dir = TempDir::new().unwrap();
    let mut cfg = Config::for_workspace(dir.path().into());
    cfg.jev_api_key = Some("jev-secret".into());
    cfg.opencode.api_key = Some("opencode-secret".into());
    cfg.zai.api_key = Some("zai-secret".into());
    cfg.ollama_cloud.api_key = Some("ollama-secret".into());
    cfg.firecrawl_api_key = Some("firecrawl-secret".into());
    assert_eq!(
        llm::redact_error(
            "jev-secret opencode-secret zai-secret ollama-secret firecrawl-secret",
            &cfg
        ),
        "[redacted] [redacted] [redacted] [redacted] [redacted]"
    );
    for base in [
        "http://example.com",
        "https://user:pass@example.com",
        "https://example.com?key=secret",
        "https://example.com#fragment",
    ] {
        cfg.opencode.base_url = Some(base.into());
        assert!(llm::providers::LiveLlm::new("opencode", &cfg.opencode).is_err());
    }
}

async fn live_model(name: &str) {
    let mut cfg = Config::from_env();
    cfg.llm_provider = name.into();
    assert!(cfg.llm_key().is_some(), "Selected provider key is required");
    let provider = llm::from_config(&cfg);
    let text = provider
        .complete("Reply with exactly the word READY.")
        .await
        .unwrap();
    assert!(
        text.trim()
            .trim_end_matches('.')
            .eq_ignore_ascii_case("READY"),
        "Live provider did not follow the text contract"
    );
    let result = provider
        .complete_measured_schema("Return a JSON object with ok set to true.", &schema())
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&result.text).unwrap(),
        json!({"ok":true})
    );
    assert!(result.usage.input_tokens > 0 && result.usage.output_tokens > 0);
    println!(
        "{name}: text + schema passed; model={}; measured tokens={}/{}",
        cfg.llm_model(),
        result.usage.input_tokens,
        result.usage.output_tokens
    );
}

#[tokio::test]
#[ignore = "Explicit live provider request, billed to installation credentials"]
async fn live_opencode() {
    live_model("opencode").await;
}
#[tokio::test]
#[ignore = "Explicit live provider request, billed to installation credentials"]
async fn live_zai() {
    live_model("zai").await;
}
#[tokio::test]
#[ignore = "Explicit live provider request, billed to installation credentials"]
async fn live_ollama_cloud() {
    live_model("ollama-cloud").await;
}
#[tokio::test]
#[ignore = "Explicit live provider request, billed to installation credentials"]
async fn live_mistral() {
    live_model("mistral").await;
}

#[tokio::test]
#[ignore = "Explicit live provider request, billed to installation credentials"]
async fn live_jev() {
    let cfg = Config::from_env();
    let result=judgments::from_config(&cfg).evaluate(json!("Two plus two equals four."),json!({"correct":{"type":"noul","instructions":"Is the arithmetic statement correct?"}})).await.unwrap();
    assert!(judgments::probability(&result.answers["correct"]["noul"]).unwrap() > 0.9);
    println!("jev: typed judgment passed; model={}", result.model);
}

#[tokio::test]
#[ignore = "Explicit live Firecrawl search, billed to installation credentials"]
async fn live_firecrawl() {
    let dir = TempDir::new().unwrap();
    let mut cfg = Config::from_env();
    cfg.searxng_base_url = None;
    cfg.workspace_dir = dir.path().into();
    let app = chief_of_rust::Installation::for_config(cfg).unwrap().app();
    let results = integrations::search(&app, "Rust programming language official documentation")
        .await
        .unwrap();
    assert!(!results.hits.is_empty());
    assert!(
        results
            .hits
            .iter()
            .all(|hit| !hit.content.is_empty() && hit.url.starts_with("https://"))
    );
    println!(
        "firecrawl: search and evidence normalization passed; selected={}",
        results.hits.len()
    );
}

#[tokio::test]
async fn every_search_queries_both_services_and_merges_before_bounding() {
    let searx = MockServer::start().await;
    let firecrawl = MockServer::start().await;
    let dir = TempDir::new().unwrap();
    let mut cfg = Config::for_workspace(dir.path().into());
    cfg.searxng_base_url = Some(searx.uri());
    cfg.firecrawl_api_key = Some("fixture-firecrawl-key".into());
    cfg.firecrawl_base_url = Some(firecrawl.uri());
    let rows: Vec<Value> = (0..10)
        .map(
            |i| json!({"url":format!("https://example.com/searx/{i}"),"content":"SearXNG excerpt"}),
        )
        .collect();
    let mut web: Vec<Value> = (0..10).map(|i| json!({"url":format!("https://example.com/firecrawl/{i}"),"description":"Firecrawl excerpt"})).collect();
    web.insert(
        0,
        json!({"url":"https://example.com/searx/0#duplicate","description":"Duplicate"}),
    );
    Mock::given(method("GET"))
        .and(path("/search"))
        .and(wiremock::matchers::query_param("q", "shared query"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(std::time::Duration::from_millis(40))
                .set_body_json(json!({"results":rows,"unresponsive_engines":[["bing","timeout"]]})),
        )
        .expect(1)
        .mount(&searx)
        .await;
    Mock::given(method("POST"))
        .and(path("/search"))
        .and(header("authorization", "Bearer fixture-firecrawl-key"))
        .and(body_partial_json(json!({"query":"shared query"})))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"success":true,"data":{"web":web}})),
        )
        .expect(1)
        .mount(&firecrawl)
        .await;
    let app = chief_of_rust::Installation::for_config(cfg).unwrap().app();
    let results = integrations::search(&app, "shared query").await.unwrap();
    assert_eq!(
        firecrawl.received_requests().await.unwrap().len(),
        1,
        "Firecrawl must fire even when SearXNG is configured"
    );
    assert_eq!(results.hits.len(), 20);
    assert!(results.hits.iter().any(|hit| hit.url.contains("/searx/")));
    assert!(
        results
            .hits
            .iter()
            .any(|hit| hit.url.contains("/firecrawl/"))
    );
    // Round-robin interleave puts each Source first in turn, so neither
    // crowds the other out of the retained set. Firecrawl's first row
    // duplicates SearXNG's, so the second retained hit is still SearXNG's.
    assert!(results.hits[0].url.contains("/searx/"));
    assert!(results.hits[2].url.contains("/firecrawl/"));
    assert_eq!(results.coverage.providers, vec!["searxng", "firecrawl"]);
    assert_eq!(
        results.diagnostics[0].status,
        integrations::SearchProviderStatus::Warning
    );
    assert_eq!(results.diagnostics[0].result_count, Some(10));
    assert!(results.diagnostics[0].elapsed_ms.unwrap() >= 35);
    assert_eq!(results.diagnostics[1].provider, "firecrawl");
    assert_eq!(
        results.diagnostics[1].status,
        integrations::SearchProviderStatus::Succeeded
    );
    assert_eq!(results.diagnostics[1].result_count, Some(11));
    assert!(results.diagnostics[1].elapsed_ms.is_some());
    assert_eq!(results.coverage.received, 21);
    assert_eq!(results.coverage.duplicates, 1);
    assert_eq!(results.coverage.omitted, 0);
    assert_eq!(results.coverage.unresponsive_engines, vec!["bing"]);
}

#[tokio::test]
async fn combined_search_attempts_both_services_even_if_either_fails() {
    for failing in ["searxng", "firecrawl"] {
        let searx = MockServer::start().await;
        let firecrawl = MockServer::start().await;
        let dir = TempDir::new().unwrap();
        let mut cfg = Config::for_workspace(dir.path().into());
        cfg.searxng_base_url = Some(searx.uri());
        cfg.firecrawl_api_key = Some("fixture-firecrawl-key".into());
        cfg.firecrawl_base_url = Some(firecrawl.uri());
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(if failing == "searxng" { 503 } else { 200 })
                    .set_body_json(json!({"results":[]})),
            )
            .expect(1)
            .mount(&searx)
            .await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(if failing == "firecrawl" { 402 } else { 200 })
                    .set_body_json(
                        json!({"success":true,"data":{"web":[]},"error":"fixture-firecrawl-key"}),
                    ),
            )
            .expect(1)
            .mount(&firecrawl)
            .await;
        let app = chief_of_rust::Installation::for_config(cfg).unwrap().app();
        let failure = integrations::search(&app, "shared query")
            .await
            .unwrap_err();
        let diagnostics = &failure
            .downcast_ref::<integrations::SearchFailure>()
            .unwrap()
            .diagnostics;
        assert_eq!(diagnostics.len(), 2);
        for diagnostic in diagnostics {
            assert!(diagnostic.elapsed_ms.is_some());
            if diagnostic.provider == failing {
                assert_eq!(
                    diagnostic.status,
                    integrations::SearchProviderStatus::Failed
                );
                assert_eq!(diagnostic.result_count, None);
            } else {
                assert_eq!(
                    diagnostic.status,
                    integrations::SearchProviderStatus::Succeeded
                );
                assert_eq!(diagnostic.result_count, Some(0));
            }
        }
        let error = failure.to_string();
        assert!(error.contains("Search incomplete"));
        assert!(error.contains(failing));
        assert!(!error.contains("fixture-firecrawl-key"));
        assert_eq!(searx.received_requests().await.unwrap().len(), 1);
        assert_eq!(firecrawl.received_requests().await.unwrap().len(), 1);
    }
}

#[tokio::test]
async fn search_uses_only_configured_services_and_requires_one() {
    let endpoint = MockServer::start().await;
    let dir = TempDir::new().unwrap();
    let cfg = Config::for_workspace(dir.path().into());
    let mut app = chief_of_rust::Installation::for_config(cfg).unwrap().app();
    assert!(
        integrations::search(&app, "query")
            .await
            .unwrap_err()
            .to_string()
            .contains("Configure SEARXNG_BASE_URL")
    );
    let mut changed = app.cfg().clone();
    changed.searxng_base_url = Some(endpoint.uri());
    app = app.with_cfg(changed);
    let mut changed = app.cfg().clone();
    changed.firecrawl_api_key = Some("  ".into());
    app = app.with_cfg(changed);
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"results":[]})))
        .expect(1)
        .mount(&endpoint)
        .await;
    let result = integrations::search(&app, "query").await.unwrap();
    assert_eq!(result.coverage.providers, vec!["searxng"]);
    let mut changed = app.cfg().clone();
    changed.searxng_base_url = None;
    app = app.with_cfg(changed);
    let mut changed = app.cfg().clone();
    changed.firecrawl_api_key = Some("fixture-key".into());
    app = app.with_cfg(changed);
    let mut changed = app.cfg().clone();
    changed.firecrawl_base_url = Some(endpoint.uri());
    app = app.with_cfg(changed);
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"success":true,"data":{"web":[]}})),
        )
        .expect(1)
        .mount(&endpoint)
        .await;
    let result = integrations::search(&app, "query").await.unwrap();
    assert_eq!(result.coverage.providers, vec!["firecrawl"]);
    assert!(integrations::search(&app, &"q".repeat(501)).await.is_err());
    assert_eq!(endpoint.received_requests().await.unwrap().len(), 2);
}
