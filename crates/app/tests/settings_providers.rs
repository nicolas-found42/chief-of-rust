use axum_test::TestServer;
use chief_of_rust::{App, Config, db::Db, llm, settings::providers};
use serde_json::{Value, json};
use tempfile::TempDir;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{body_partial_json, method, path},
};

fn setup(dir: &TempDir, endpoint: &str) -> App {
    let mut cfg = Config::for_workspace(dir.path().into());
    cfg.mistral.api_key = Some("fixture-mistral-key".into());
    cfg.mistral.base_url = Some(endpoint.into());
    for provider in [&mut cfg.opencode, &mut cfg.zai, &mut cfg.ollama_cloud] {
        provider.api_key = Some("fixture-model-key".into());
        provider.base_url = Some(endpoint.into());
    }
    cfg.searxng_base_url = Some(endpoint.into());
    cfg.firecrawl_api_key = Some("fixture-search-key".into());
    cfg.firecrawl_base_url = Some(endpoint.into());
    cfg.jev_api_key = Some("fixture-jev-key".into());
    cfg.jev_base_url = Some(endpoint.into());
    chief_of_rust::Installation::for_config(cfg).unwrap().app()
}
fn server(app: &App) -> TestServer {
    TestServer::new(chief_of_rust::routes::router(app.clone()))
}
async fn choose(server: &TestServer, revision: u64, generation: &str, search: &str) {
    server
        .post("/settings/providers")
        .form(&[
            ("revision", revision.to_string()),
            ("generation", generation.into()),
            ("search", search.into()),
        ])
        .await
        .assert_status_see_other();
}
/// Mirror the adapter's verified split: OpenCode serves GPT models over the
/// Responses API and every other model over Chat Completions.
fn responses(model: &str) -> bool {
    model.starts_with("gpt-")
}
fn answer(model: &str) -> Value {
    if responses(model) {
        json!({"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"READY"}]}]})
    } else {
        json!({"choices":[{"finish_reason":"stop","message":{"content":"READY"}}]})
    }
}

#[tokio::test]
async fn switches_all_models_in_one_router_and_persists_without_secrets() {
    let endpoint = MockServer::start().await;
    let dir = TempDir::new().unwrap();
    let app = setup(&dir, &endpoint.uri());
    let server = server(&app);
    for (revision, name, model) in [
        (0, "mistral", "mistral-large-4"),
        (1, "opencode", "beam-free"),
        (2, "zai", "glm-5.3-flash"),
        (3, "ollama-cloud", "deepseek-v4.1-flash:1017"),
    ] {
        Mock::given(method("POST"))
            .and(path(if responses(model) {
                "/responses"
            } else {
                "/chat/completions"
            }))
            .and(body_partial_json(json!({"model":model})))
            .respond_with(ResponseTemplate::new(200).set_body_json(answer(model)))
            .expect(1)
            .mount(&endpoint)
            .await;
        choose(&server, revision, name, "searxng").await;
        let page = server.get("/settings").await;
        assert!(page.text().contains(&format!("value=\"{name}\" selected")));
        let result = server.post("/llm").form(&[("prompt", "Reply READY")]).await;
        result.assert_status_ok();
        assert!(result.text().contains(&format!("<strong>{name}</strong>")));
        assert!(result.text().contains(model));
        assert_eq!(
            app.db().stats().await.unwrap().last_call.unwrap().provider,
            name
        );
    }
    assert_eq!(
        app.llm().name(),
        "mock",
        "The original app snapshot is unchanged"
    );
    let reopened = setup(&dir, &endpoint.uri());
    let saved = providers::load(reopened.db()).await.unwrap();
    assert_eq!(saved.generation.as_deref(), Some("ollama-cloud"));
    let raw = reopened
        .db()
        .get::<Value>("settings", "providers")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(raw, json!({"revision":4,"generation":"ollama-cloud"}));
    assert!(
        server
            .get("/settings")
            .await
            .text()
            .contains("deepseek-v4.1-flash")
    );
    assert_eq!(
        providers::resolve(&reopened).await.unwrap().llm().name(),
        "ollama-cloud"
    );
    choose(&server, 4, "", "").await;
    let result = server.post("/llm").form(&[("prompt", "hello")]).await;
    assert!(result.text().contains("[mock] you said: hello"));
    assert_eq!(
        providers::resolve(&app)
            .await
            .unwrap()
            .cfg()
            .searxng_base_url
            .as_deref(),
        Some(endpoint.uri().as_str())
    );
}

#[tokio::test]
async fn invalid_missing_key_and_stale_choices_preserve_independent_preferences() {
    let endpoint = MockServer::start().await;
    let dir = TempDir::new().unwrap();
    let mut app = setup(&dir, &endpoint.uri());
    let mut changed = app.cfg().clone();
    changed.opencode.api_key = None;
    changed.firecrawl_api_key = None;
    app = app.with_cfg(changed);
    let server = server(&app);
    for (generation, search) in [("unknown", ""), ("mock", ""), ("opencode", "")] {
        server
            .post("/settings/providers")
            .form(&[
                ("revision", "0"),
                ("generation", generation),
                ("search", search),
            ])
            .await
            .assert_status_bad_request();
    }
    assert_eq!(providers::load(app.db()).await.unwrap().revision, 0);
    let (first, second) = tokio::join!(
        server.post("/settings/providers").form(&[
            ("revision", "0"),
            ("generation", "zai"),
            ("search", "")
        ]),
        server.post("/settings/providers").form(&[
            ("revision", "0"),
            ("generation", "ollama-cloud"),
            ("search", "")
        ])
    );
    let statuses = [first.status_code().as_u16(), second.status_code().as_u16()];
    assert!(statuses.contains(&303) && statuses.contains(&409));
    let selected = providers::load(app.db()).await.unwrap().generation;
    server
        .post("/settings")
        .form(&[
            ("revision", "0"),
            ("owner_name", "Provider tester"),
            ("timezone", "UTC"),
            ("calendar_id", "primary"),
        ])
        .await
        .assert_status_see_other();
    assert_eq!(
        providers::load(app.db()).await.unwrap().generation,
        selected
    );
    choose(&server, 1, "zai", "").await;
    assert_eq!(
        chief_of_rust::settings::load(app.db())
            .await
            .unwrap()
            .owner_name,
        "Provider tester"
    );
}

#[tokio::test]
async fn in_flight_diagnostic_keeps_its_provider_while_next_test_uses_new_choice() {
    let endpoint = MockServer::start().await;
    let dir = TempDir::new().unwrap();
    let app = setup(&dir, &endpoint.uri());
    let server = server(&app);
    Mock::given(method("POST"))
        .and(body_partial_json(json!({"model":"glm-5.3-flash"})))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(std::time::Duration::from_millis(150))
                .set_body_json(answer("glm-5.3-flash")),
        )
        .expect(1)
        .mount(&endpoint)
        .await;
    Mock::given(method("POST"))
        .and(body_partial_json(
            json!({"model":"deepseek-v4.1-flash:1017"}),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(answer("deepseek-v4.1-flash:1017")))
        .expect(1)
        .mount(&endpoint)
        .await;
    choose(&server, 0, "zai", "").await;
    let (result, ()) = tokio::join!(
        server.post("/llm").form(&[("prompt", "Reply READY")]),
        async {
            tokio::time::timeout(std::time::Duration::from_secs(3), async {
                while endpoint.received_requests().await.unwrap().is_empty() {
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            choose(&server, 1, "ollama-cloud", "").await;
        }
    );
    assert!(result.text().contains("<strong>zai</strong>"));
    let next = server.post("/llm").form(&[("prompt", "Reply READY")]).await;
    assert!(next.text().contains("<strong>ollama-cloud</strong>"));
}

#[tokio::test]
async fn selected_search_and_judgment_tests_render_results_and_provider_failures() {
    let endpoint = MockServer::start().await;
    let dir = TempDir::new().unwrap();
    let app = setup(&dir, &endpoint.uri());
    let server = server(&app);
    Mock::given(method("GET")).and(path("/search"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"results":[{"url":"https://example.org/searx","title":"SearXNG result","content":"SearXNG excerpt"}],"unresponsive_engines":[["bing","timeout"]]})))
        .expect(1).mount(&endpoint).await;
    Mock::given(method("POST")).and(path("/search")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"success":true,"data":{"web":[{"url":"https://example.com/","title":"<script>title</script>","description":"Source excerpt"}]}}))).expect(1).mount(&endpoint).await;
    Mock::given(method("POST"))
        .and(path("/v1/systemone"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({"model":"fixture-jev","answers":{"correct":{"type":"noul","noul":0.99}}}),
        ))
        .expect(1)
        .mount(&endpoint)
        .await;
    choose(&server, 0, "zai", "firecrawl").await;
    let result = server
        .post("/settings/providers/search-test")
        .form(&[("query", "official documentation")])
        .await;
    result.assert_status_ok();
    assert!(result.text().contains("searxng + firecrawl"));
    assert!(result.text().contains("SearXNG excerpt"));
    assert!(result.text().contains("Succeeded with warnings"));
    assert!(result.text().contains("&lt;script&gt;title&lt;/script&gt;"));
    server
        .post("/settings/providers/judgment-test")
        .await
        .assert_status_ok();
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(
            ResponseTemplate::new(401).set_body_json(json!({"error":"fixture-model-key"})),
        )
        .expect(1)
        .mount(&endpoint)
        .await;
    let failure = server.post("/llm").form(&[("prompt", "hello")]).await;
    failure.assert_status_internal_server_error();
    assert!(failure.text().contains("401"));
    assert!(failure.text().contains("Return to Settings"));
    assert!(!failure.text().contains("fixture-model-key"));
    assert_eq!(
        providers::load(app.db())
            .await
            .unwrap()
            .generation
            .as_deref(),
        Some("zai")
    );
}

/// The installation defaults are the product's default generation choice, so
/// assert them on a configuration built from the environment alone rather than
/// from a Settings selection. nextest gives each test its own process, so
/// clearing these variables cannot reach another test.
#[test]
fn fresh_installation_resolves_the_opencode_beam_free_model() {
    for key in [
        "LLM_PROVIDER",
        "OPENCODE_MODEL",
        "OPENCODE_REASONING_EFFORT",
        "OPENCODE_API_KEY",
        "OPENCODE_BASE_URL",
    ] {
        unsafe { std::env::remove_var(key) };
    }
    let cfg = Config::from_env();
    assert_eq!(cfg.llm_provider, "opencode");
    assert_eq!(cfg.llm_model(), "beam-free");
    assert_eq!(cfg.llm_effort(), "medium");
}

#[tokio::test]
async fn model_and_effort_changes_reconfigure_the_same_provider_and_survive_switching() {
    let endpoint = MockServer::start().await;
    let dir = TempDir::new().unwrap();
    let app = setup(&dir, &endpoint.uri());
    let server = server(&app);
    for (provider, model, effort) in [
        ("mistral", "mistral-medium-3-5", "high"),
        ("opencode", "gpt-5.6-luna", "high"),
        ("zai", "glm-5.3", "max"),
        ("ollama-cloud", "deepseek-v4-pro:0813", "low"),
    ] {
        let revision = providers::load(app.db()).await.unwrap().revision;
        choose(&server, revision, provider, "firecrawl").await;
        let revision = providers::load(app.db()).await.unwrap().revision;
        server
            .post("/settings/providers/models")
            .form(&[
                ("revision", revision.to_string()),
                ("provider", provider.into()),
                ("model", model.into()),
                ("reasoning_effort", effort.into()),
            ])
            .await
            .assert_status_see_other();
        let expected = if provider == "opencode" && responses(model) {
            json!({"model":model,"reasoning":{"effort":effort}})
        } else {
            json!({"model":model,"reasoning_effort":effort})
        };
        Mock::given(method("POST"))
            .and(body_partial_json(expected))
            .respond_with(ResponseTemplate::new(200).set_body_json(answer(model)))
            .expect(1)
            .mount(&endpoint)
            .await;
        let reply = server.post("/llm").form(&[("prompt", "Reply READY")]).await;
        reply.assert_status_ok();
        assert!(reply.text().contains(model));
        assert!(reply.text().contains(&format!("reasoning {effort}")));
        let resolved = providers::resolve(&app).await.unwrap();
        assert_eq!(resolved.cfg().llm_model(), model);
        assert_eq!(resolved.cfg().llm_effort(), effort);
    }
    let reopened = setup(&dir, &endpoint.uri());
    let profiles = providers::load(reopened.db()).await.unwrap();
    assert_eq!(profiles.models.len(), 4);
    let raw = reopened
        .db()
        .get::<Value>("settings", "providers")
        .await
        .unwrap()
        .unwrap()
        .to_string();
    assert!(!raw.contains("fixture-model-key"));
    let revision = profiles.revision;
    choose(&server, revision, "opencode", "firecrawl").await;
    let resolved = providers::resolve(&reopened).await.unwrap();
    assert_eq!(resolved.cfg().llm_model(), "gpt-5.6-luna");
    assert_eq!(resolved.cfg().llm_effort(), "high");
    let revision = providers::load(app.db()).await.unwrap().revision;
    server
        .post("/settings/providers/models")
        .form(&[
            ("revision", revision.to_string()),
            ("provider", "opencode".into()),
            ("model", "".into()),
            ("reasoning_effort", "".into()),
        ])
        .await
        .assert_status_see_other();
    let restored = providers::resolve(&app).await.unwrap();
    assert_eq!(restored.cfg().llm_model(), "beam-free");
    assert_eq!(restored.cfg().llm_effort(), "medium");
    assert!(restored.cfg().firecrawl_api_key.is_some());
    assert!(restored.cfg().searxng_base_url.is_some());
}

#[tokio::test]
async fn invalid_model_effort_combinations_and_stale_model_forms_do_not_overwrite_profiles() {
    let endpoint = MockServer::start().await;
    let dir = TempDir::new().unwrap();
    let app = setup(&dir, &endpoint.uri());
    let server = server(&app);
    for (provider, model, effort) in [
        ("zai", "glm-5.3", "medium"),
        ("zai", "glm-5.3", "none"),
        ("mistral", "mistral-large-4", "low"),
        ("opencode", "gpt-6-luna", "max"),
        // beam-free reaches max but still rejects an effort outside the catalog.
        ("opencode", "beam-free", "none"),
        ("ollama-cloud", "glm-5.3-flash", "none"),
        ("zai", "gpt-6-luna", "high"),
        ("unknown", "glm-5.3", "high"),
    ] {
        server
            .post("/settings/providers/models")
            .form(&[
                ("revision", "0"),
                ("provider", provider),
                ("model", model),
                ("reasoning_effort", effort),
            ])
            .await
            .assert_status_bad_request();
    }
    assert_eq!(providers::load(app.db()).await.unwrap().revision, 0);
    let body = [
        ("revision", "0"),
        ("provider", "zai"),
        ("model", "glm-5.3"),
        ("reasoning_effort", "max"),
    ];
    server
        .post("/settings/providers/models")
        .form(&body)
        .await
        .assert_status_see_other();
    server
        .post("/settings/providers/models")
        .form(&body)
        .await
        .assert_status_conflict();
    assert_eq!(
        providers::load(app.db()).await.unwrap().models["zai"]
            .reasoning_effort
            .as_deref(),
        Some("max")
    );
}

#[tokio::test]
async fn changing_model_and_effort_does_not_reconfigure_an_in_flight_request() {
    let endpoint = MockServer::start().await;
    let dir = TempDir::new().unwrap();
    let app = setup(&dir, &endpoint.uri());
    let server = server(&app);
    Mock::given(method("POST"))
        .and(body_partial_json(
            json!({"model":"glm-5.3-flash","reasoning_effort":"low"}),
        ))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(std::time::Duration::from_millis(150))
                .set_body_json(answer("glm-5.3-flash")),
        )
        .expect(1)
        .mount(&endpoint)
        .await;
    Mock::given(method("POST"))
        .and(body_partial_json(
            json!({"model":"glm-5.3","reasoning_effort":"max"}),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(answer("glm-5.3")))
        .expect(1)
        .mount(&endpoint)
        .await;
    choose(&server, 0, "zai", "").await;
    let (old, ()) = tokio::join!(
        server.post("/llm").form(&[("prompt", "Reply READY")]),
        async {
            tokio::time::timeout(std::time::Duration::from_secs(3), async {
                while endpoint.received_requests().await.unwrap().is_empty() {
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            server
                .post("/settings/providers/models")
                .form(&[
                    ("revision", "1"),
                    ("provider", "zai"),
                    ("model", "glm-5.3"),
                    ("reasoning_effort", "max"),
                ])
                .await
                .assert_status_see_other();
        }
    );
    assert!(old.text().contains("glm-5.3-flash</code> · reasoning low"));
    let new = server.post("/llm").form(&[("prompt", "Reply READY")]).await;
    assert!(new.text().contains("glm-5.3</code> · reasoning max"));
}

#[tokio::test]
#[ignore = "Explicit live model/effort override acceptance; billed to installation credentials"]
async fn live_model_effort_overrides_use_valid_schema_output() {
    let dir = TempDir::new().unwrap();
    let mut cfg = Config::from_env();
    cfg.workspace_dir = dir.path().into();
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        Db::open(&cfg.db_path()).unwrap(),
        llm::from_config(&cfg),
        chief_of_rust::judgments::from_config(&cfg),
        std::sync::Arc::new(chief_of_rust::collect::Pacer::system()),
    )
    .app();
    let server = server(&app);
    for (provider, model, effort) in [
        ("mistral", "mistral-medium-3-5", "high"),
        ("opencode", "gpt-5.6-luna", "high"),
        ("zai", "glm-5.3", "max"),
        ("ollama-cloud", "deepseek-v4-pro:0813", "low"),
    ] {
        let revision = providers::load(app.db()).await.unwrap().revision;
        choose(&server, revision, provider, "").await;
        let revision = providers::load(app.db()).await.unwrap().revision;
        server
            .post("/settings/providers/models")
            .form(&[
                ("revision", revision.to_string()),
                ("provider", provider.into()),
                ("model", model.into()),
                ("reasoning_effort", effort.into()),
            ])
            .await
            .assert_status_see_other();
        let selected = providers::resolve(&app).await.unwrap();
        let completion=selected.llm().complete_measured_schema("Return a JSON object with ok set to true.",&json!({"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false})).await.unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&completion.text).unwrap(),
            json!({"ok":true})
        );
        assert_eq!(selected.cfg().llm_model(), model);
        assert_eq!(selected.cfg().llm_effort(), effort);
        println!("{provider}: model={model}, effort={effort}, schema output passed");
    }
}

#[tokio::test]
async fn legacy_search_choice_cannot_disable_a_configured_service() {
    let endpoint = MockServer::start().await;
    let dir = TempDir::new().unwrap();
    let app = setup(&dir, &endpoint.uri());
    app.db()
        .put(
            "settings",
            "providers",
            json!({"revision":7,"generation":"zai","search":"firecrawl"}),
        )
        .await
        .unwrap();
    let server = server(&app);
    let page = server.get("/settings").await.text();
    assert!(!page.contains("name=\"search\""));
    assert!(page.contains("searxng + firecrawl"));
    choose(&server, 7, "mistral", "searxng").await;
    let saved = app
        .db()
        .get::<Value>("settings", "providers")
        .await
        .unwrap()
        .unwrap();
    assert!(saved.get("search").is_none());
    assert_eq!(saved["generation"], "mistral");
    let resolved = providers::resolve(&app).await.unwrap();
    assert!(resolved.cfg().searxng_base_url.is_some());
    assert!(resolved.cfg().firecrawl_api_key.is_some());
}

#[tokio::test]
async fn search_diagnostic_shows_each_service_on_success_failure_and_missing_configuration() {
    for mode in ["success", "failure", "unconfigured"] {
        let endpoint = MockServer::start().await;
        let dir = TempDir::new().unwrap();
        let mut app = setup(&dir, &endpoint.uri());
        if mode == "unconfigured" {
            let mut changed = app.cfg().clone();
            changed.firecrawl_api_key = None;
            app = app.with_cfg(changed);
        }
        Mock::given(method("GET"))
            .and(path("/search"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(std::time::Duration::from_millis(40))
                    .set_body_json(json!({"results":[]})),
            )
            .expect(1)
            .mount(&endpoint)
            .await;
        if mode != "unconfigured" {
            Mock::given(method("POST")).and(path("/search"))
                .respond_with(ResponseTemplate::new(if mode=="failure" {402} else {200})
                    .set_body_json(json!({"success":true,"error":"fixture-search-key","data":{"web":[{"url":"https://example.com/a","description":"A"},{"url":"https://example.com/a#duplicate","description":"A"}]}})))
                .expect(1).mount(&endpoint).await;
        }
        let server = server(&app);
        let response = server
            .post("/settings/providers/search-test")
            .form(&[("query", "fixture")])
            .await;
        if mode == "failure" {
            response.assert_status_internal_server_error();
        } else {
            response.assert_status_ok();
        }
        let html = response.text();
        assert!(html.contains("Search provider diagnostics"));
        assert!(html.contains("Results returned"));
        assert!(html.contains("Elapsed"));
        let row = |name: &str| {
            html.split("<tr>")
                .find(|row| row.contains(&format!(">{name}</th>")))
                .unwrap()
        };
        assert!(row("SearXNG").contains("Succeeded</td><td>0</td><td>"));
        assert!(row("SearXNG").contains(" ms</td>"));
        let firecrawl = row("Firecrawl");
        match mode {
            "failure" => {
                assert!(firecrawl.contains("Failed"));
                assert!(firecrawl.contains("HTTP 402"));
                assert!(firecrawl.contains("<td>—</td>"));
                assert!(firecrawl.contains(" ms</td>"));
                assert!(!html.contains("fixture-search-key"));
                assert!(html.contains("Search incomplete"));
            }
            "unconfigured" => {
                assert!(firecrawl.contains("Not configured</td><td>—</td><td>—</td>"))
            }
            _ => {
                assert!(firecrawl.contains("Succeeded</td><td>2</td><td>"));
                assert!(firecrawl.contains(" ms</td>"));
                assert!(html.contains("returned 1 usable results"));
            }
        }
    }
}

/// Source admin surface (issue #53): the Settings page shows the effective
/// query-Source limits and any override deviations, and the search-test
/// diagnostics list each Source's status, returned/selected counts and
/// elapsed time so a failing configured Source is identifiable.
#[tokio::test]
async fn source_limits_and_per_source_diagnostics_are_visible() {
    let endpoint = MockServer::start().await;
    let dir = TempDir::new().unwrap();
    let app = setup(&dir, &endpoint.uri());
    let mut cfg = app.cfg().clone();
    cfg.source_limits = chief_of_rust::sources::SourceLimits::clamped(2, 4, 6);
    cfg.source_limit_notes = vec![
        "CHIEF_SOURCE_MAX_PER_SOURCE (per-source maximum) 500 clamped to 50".to_string(),
        "CHIEF_SOURCE_MAX_TOTAL (total maximum) unparseable, kept default 50".to_string(),
    ];
    let app = app.with_cfg(cfg);
    let server = server(&app);
    // The Settings page shows the effective limits and the recorded
    // deviations before any test runs.
    let page = server.get("/settings").await.text();
    assert!(page.contains("Source limits"), "limits section: {page}");
    assert!(
        page.contains("at least 2 and at most 4 per Source, 6 in total across one search"),
        "effective limits: {page}"
    );
    assert!(
        page.contains("CHIEF_SOURCE_MAX_PER_SOURCE (per-source maximum) 500 clamped to 50"),
        "deviation recorded: {page}"
    );
    assert!(
        page.contains("CHIEF_SOURCE_MAX_TOTAL (total maximum) unparseable, kept default 50"),
        "unparseable override recorded: {page}"
    );
    // Five rows per Source: the effective 4-per-Source cap selects 4 each and
    // the 6-total cap selects 6 across both, with honest omitted counts.
    Mock::given(method("GET"))
        .and(path("/search"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "results": (0..5).map(|i| json!({
                "url": format!("https://example.com/searx/{i}"),
                "title": format!("SearXNG {i}"),
                "content": format!("SearXNG excerpt {i}"),
            })).collect::<Vec<_>>(),
            "unresponsive_engines": [],
        })))
        .expect(1)
        .mount(&endpoint)
        .await;
    Mock::given(method("POST"))
        .and(path("/search"))
        .and(body_partial_json(json!({"limit": 4})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "success": true,
            "data": {"web": (0..5).map(|i| json!({
                "url": format!("https://example.com/firecrawl/{i}"),
                "title": format!("Firecrawl {i}"),
                "description": format!("Firecrawl excerpt {i}"),
            })).collect::<Vec<_>>()},
        })))
        .expect(1)
        .mount(&endpoint)
        .await;
    let response = server
        .post("/settings/providers/search-test")
        .form(&[("query", "fixture")])
        .await;
    response.assert_status_ok();
    let html = response.text();
    assert!(html.contains("Search provider diagnostics"));
    // Per-Source status, returned count, selected count and elapsed time.
    assert!(html.contains("Selected"), "selected column: {html}");
    let row = |name: &str| {
        html.split("<tr>")
            .find(|row| row.contains(&format!(">{name}</th>")))
            .unwrap()
            .to_string()
    };
    // Round-robin interleave: searxng takes rows 1, 3, 5 of the 6-total cap
    // (its own 4-per-source cap never binds first).
    let searx = row("SearXNG");
    assert!(searx.contains("Succeeded"), "searxng status: {searx}");
    assert!(
        searx.contains("<td>5</td>"),
        "searxng returned count: {searx}"
    );
    assert!(
        searx.contains("<td>3</td>"),
        "searxng selected count: {searx}"
    );
    assert!(searx.contains(" ms</td>"), "searxng elapsed: {searx}");
    let firecrawl = row("Firecrawl");
    assert!(
        firecrawl.contains("<td>5</td>"),
        "firecrawl returned: {firecrawl}"
    );
    assert!(
        firecrawl.contains("<td>3</td>"),
        "firecrawl selected (total cap 6): {firecrawl}"
    );
    // The effective limits and the override deviations render beside the
    // diagnostics, and the coverage note names the effective per-source cap.
    assert!(
        html.contains("Source limits:</strong> at least 2 and at most 4 per Source, 6 in total across one search"),
        "effective limits on diagnostic page: {html}"
    );
    assert!(
        html.contains("Source limit override: CHIEF_SOURCE_MAX_PER_SOURCE (per-source maximum) 500 clamped to 50"),
        "deviation on diagnostic page: {html}"
    );
    assert!(
        html.contains("4-per-source limit"),
        "coverage names the effective cap: {html}"
    );
    // 4 + 2 selected across both Sources under the 6-total cap.
    assert!(html.contains("returned 6 usable results"), "total: {html}");
}

/// A failing configured Source is identifiable in the diagnostics: its row
/// keeps the measured elapsed time and redacted error beside the surviving
/// Source's counts, and the effective limits still render (issue #53).
#[tokio::test]
async fn failing_configured_source_is_identifiable_in_diagnostics() {
    let endpoint = MockServer::start().await;
    let dir = TempDir::new().unwrap();
    let app = setup(&dir, &endpoint.uri());
    let mut cfg = app.cfg().clone();
    cfg.source_limits = chief_of_rust::sources::SourceLimits::clamped(1, 3, 10);
    cfg.source_limit_notes =
        vec!["CHIEF_SOURCE_MAX_PER_SOURCE (per-source maximum) 500 clamped to 50".to_string()];
    let app = app.with_cfg(cfg);
    let server = server(&app);
    Mock::given(method("GET"))
        .and(path("/search"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(std::time::Duration::from_millis(40))
                .set_body_json(json!({
                    "results": (0..5).map(|i| json!({
                        "url": format!("https://example.com/searx/{i}"),
                        "title": format!("SearXNG {i}"),
                        "content": format!("SearXNG excerpt {i}"),
                    })).collect::<Vec<_>>(),
                    "unresponsive_engines": [],
                })),
        )
        .expect(1)
        .mount(&endpoint)
        .await;
    Mock::given(method("POST"))
        .and(path("/search"))
        .respond_with(
            ResponseTemplate::new(402)
                .set_body_json(json!({"success": false, "error": "fixture-search-key"})),
        )
        .expect(1)
        .mount(&endpoint)
        .await;
    let response = server
        .post("/settings/providers/search-test")
        .form(&[("query", "fixture")])
        .await;
    response.assert_status_internal_server_error();
    let html = response.text();
    let row = |name: &str| {
        html.split("<tr>")
            .find(|row| row.contains(&format!(">{name}</th>")))
            .unwrap()
            .to_string()
    };
    let searx = row("SearXNG");
    assert!(searx.contains("Succeeded"), "searxng kept its row: {searx}");
    assert!(searx.contains("<td>5</td>"), "searxng returned: {searx}");
    assert!(
        searx.contains("<td>3</td>"),
        "searxng selected under cap 3: {searx}"
    );
    assert!(searx.contains(" ms</td>"), "searxng elapsed: {searx}");
    let firecrawl = row("Firecrawl");
    assert!(
        firecrawl.contains("Failed"),
        "firecrawl identified: {firecrawl}"
    );
    assert!(
        firecrawl.contains("HTTP 402"),
        "firecrawl error: {firecrawl}"
    );
    assert!(!html.contains("fixture-search-key"), "key redacted: {html}");
    assert!(
        html.contains("Source limits:</strong> at least 1 and at most 3 per Source, 10 in total across one search"),
        "effective limits on failure page: {html}"
    );
    assert!(
        html.contains("Source limit override: CHIEF_SOURCE_MAX_PER_SOURCE (per-source maximum) 500 clamped to 50"),
        "deviation on failure page: {html}"
    );
}
