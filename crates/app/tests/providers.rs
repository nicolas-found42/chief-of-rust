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

#[tokio::test]
async fn selected_providers_use_their_model_reasoning_and_schema_contracts() {
    for (name, model, effort) in [
        ("opencode", "gpt-6-luna", "medium"),
        ("zai", "glm-5.3-flash", "low"),
        ("ollama-cloud", "deepseek-v4.1-flash", "high"),
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
        let request = if name == "opencode" {
            json!({"model":model,"reasoning":{"effort":effort},"text":{"format":{"type":"json_schema","schema":schema()}}})
        } else if name == "zai" {
            json!({"model":model,"reasoning_effort":effort,"thinking":{"type":"enabled"},"response_format":{"type":"json_object"}})
        } else {
            json!({"model":model,"reasoning_effort":effort,"response_format":{"type":"json_schema","json_schema":{"schema":schema()}}})
        };
        let response = if name == "opencode" {
            json!({"status":"completed","output":[{"type":"reasoning","summary":[{"text":"must not appear"}]},{"type":"message","content":[{"type":"output_text","text":"{\"ok\":true}"}]}],"usage":{"input_tokens":3,"output_tokens":5}})
        } else {
            json!({"choices":[{"finish_reason":"stop","message":{"content":"{\"ok\":true}","reasoning_content":"must not appear"}}],"usage":{"prompt_tokens":3,"completion_tokens":5}})
        };
        Mock::given(method("POST"))
            .and(path(if name == "opencode" {
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
            let response = if name == "opencode" {
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
    let mut rows: Vec<Value> = (0..10).map(|i|json!({"url":format!("https://example.com/{i}"),"title":"Source","description":"x".repeat(6100)})).collect();
    rows.push(rows[0].clone());
    rows.push(json!({"url":"http://127.0.0.1/private","description":"Private"}));
    Mock::given(method("POST"))
        .and(path("/search"))
        .and(header("authorization", "Bearer firecrawl-fixture-key"))
        .and(body_partial_json(
            json!({"limit":8,"sources":["web"],"domainTools":false,"highlights":false}),
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
    assert_eq!(results.hits.len(), 8);
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
    let app = chief_of_rust::App {
        db: chief_of_rust::db::Db::open(&cfg.db_path()).unwrap(),
        judge: judgments::from_config(&cfg),
        llm: llm::from_config(&cfg),
        cfg,
    };
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
    let app = chief_of_rust::App {
        db: chief_of_rust::db::Db::open(&cfg.db_path()).unwrap(),
        judge: judgments::from_config(&cfg),
        llm: llm::from_config(&cfg),
        cfg,
    };
    let results = integrations::search(&app, "shared query").await.unwrap();
    assert_eq!(
        firecrawl.received_requests().await.unwrap().len(),
        1,
        "Firecrawl must fire even when SearXNG is configured"
    );
    assert_eq!(results.hits.len(), 8);
    assert!(results.hits.iter().any(|hit| hit.url.contains("/searx/")));
    assert!(
        results
            .hits
            .iter()
            .any(|hit| hit.url.contains("/firecrawl/"))
    );
    assert_eq!(results.coverage.providers, vec!["searxng", "firecrawl"]);
    assert_eq!(results.diagnostics[0].provider, "searxng");
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
    assert_eq!(results.coverage.omitted, 12);
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
        let app = chief_of_rust::App {
            db: chief_of_rust::db::Db::open(&cfg.db_path()).unwrap(),
            judge: judgments::from_config(&cfg),
            llm: llm::from_config(&cfg),
            cfg,
        };
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
    let mut app = chief_of_rust::App {
        db: chief_of_rust::db::Db::open(&cfg.db_path()).unwrap(),
        judge: judgments::from_config(&cfg),
        llm: llm::from_config(&cfg),
        cfg,
    };
    assert!(
        integrations::search(&app, "query")
            .await
            .unwrap_err()
            .to_string()
            .contains("Configure SEARXNG_BASE_URL")
    );
    app.cfg.searxng_base_url = Some(endpoint.uri());
    app.cfg.firecrawl_api_key = Some("  ".into());
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"results":[]})))
        .expect(1)
        .mount(&endpoint)
        .await;
    let result = integrations::search(&app, "query").await.unwrap();
    assert_eq!(result.coverage.providers, vec!["searxng"]);
    app.cfg.searxng_base_url = None;
    app.cfg.firecrawl_api_key = Some("fixture-key".into());
    app.cfg.firecrawl_base_url = Some(endpoint.uri());
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
