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
    cfg.mistral_api_key = Some("fixture-mistral-key".into());
    cfg.mistral_base_url = Some(endpoint.into());
    for provider in [&mut cfg.opencode, &mut cfg.zai, &mut cfg.ollama_cloud] {
        provider.api_key = Some("fixture-model-key".into());
        provider.base_url = Some(endpoint.into());
    }
    cfg.firecrawl_api_key = Some("fixture-search-key".into());
    cfg.firecrawl_base_url = Some(endpoint.into());
    cfg.jev_api_key = Some("fixture-jev-key".into());
    cfg.jev_base_url = Some(endpoint.into());
    App {
        db: Db::open(&cfg.db_path()).unwrap(),
        judge: chief_of_rust::judgments::from_config(&cfg),
        llm: llm::from_config(&cfg),
        cfg,
    }
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
fn answer(name: &str) -> Value {
    if name == "opencode" {
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
        (1, "opencode", "gpt-6-luna"),
        (2, "zai", "glm-5.3-flash"),
        (3, "ollama-cloud", "deepseek-v4.1-flash"),
    ] {
        Mock::given(method("POST"))
            .and(path(if name == "opencode" {
                "/responses"
            } else {
                "/chat/completions"
            }))
            .and(body_partial_json(json!({"model":model})))
            .respond_with(ResponseTemplate::new(200).set_body_json(answer(name)))
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
            app.db.stats().await.unwrap().last_call.unwrap().provider,
            name
        );
    }
    assert_eq!(
        app.llm.name(),
        "mock",
        "The original app snapshot is unchanged"
    );
    let reopened = setup(&dir, &endpoint.uri());
    let saved = providers::load(&reopened.db).await.unwrap();
    assert_eq!(saved.generation.as_deref(), Some("ollama-cloud"));
    let raw = reopened
        .db
        .get::<Value>("settings", "providers")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        raw,
        json!({"revision":4,"generation":"ollama-cloud","search":"searxng"})
    );
    assert!(
        server
            .get("/settings")
            .await
            .text()
            .contains("deepseek-v4.1-flash")
    );
    assert_eq!(
        providers::resolve(&reopened).await.unwrap().llm.name(),
        "ollama-cloud"
    );
    choose(&server, 4, "", "").await;
    let result = server.post("/llm").form(&[("prompt", "hello")]).await;
    assert!(result.text().contains("[mock] you said: hello"));
    assert_eq!(
        providers::resolve(&app).await.unwrap().cfg.search_provider,
        "searxng"
    );
}

#[tokio::test]
async fn invalid_missing_key_and_stale_choices_preserve_independent_preferences() {
    let endpoint = MockServer::start().await;
    let dir = TempDir::new().unwrap();
    let mut app = setup(&dir, &endpoint.uri());
    app.cfg.opencode.api_key = None;
    app.cfg.firecrawl_api_key = None;
    let server = server(&app);
    for (generation, search) in [
        ("unknown", ""),
        ("mock", ""),
        ("opencode", ""),
        ("zai", "unknown"),
        ("zai", "firecrawl"),
    ] {
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
    assert_eq!(providers::load(&app.db).await.unwrap().revision, 0);
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
    let selected = providers::load(&app.db).await.unwrap().generation;
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
    assert_eq!(providers::load(&app.db).await.unwrap().generation, selected);
    choose(&server, 1, "zai", "").await;
    assert_eq!(
        chief_of_rust::settings::load(&app.db)
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
                .set_body_json(answer("zai")),
        )
        .expect(1)
        .mount(&endpoint)
        .await;
    Mock::given(method("POST"))
        .and(body_partial_json(json!({"model":"deepseek-v4.1-flash"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(answer("ollama-cloud")))
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
    assert!(result.text().contains("firecrawl"));
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
        providers::load(&app.db)
            .await
            .unwrap()
            .generation
            .as_deref(),
        Some("zai")
    );
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
        let revision = providers::load(&app.db).await.unwrap().revision;
        choose(&server, revision, provider, "firecrawl").await;
        let revision = providers::load(&app.db).await.unwrap().revision;
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
        let expected = if provider == "opencode" {
            json!({"model":model,"reasoning":{"effort":effort}})
        } else {
            json!({"model":model,"reasoning_effort":effort})
        };
        Mock::given(method("POST"))
            .and(body_partial_json(expected))
            .respond_with(ResponseTemplate::new(200).set_body_json(answer(provider)))
            .expect(1)
            .mount(&endpoint)
            .await;
        let reply = server.post("/llm").form(&[("prompt", "Reply READY")]).await;
        reply.assert_status_ok();
        assert!(reply.text().contains(model));
        assert!(reply.text().contains(&format!("reasoning {effort}")));
        let resolved = providers::resolve(&app).await.unwrap();
        assert_eq!(resolved.cfg.llm_model(), model);
        assert_eq!(resolved.cfg.llm_effort(), effort);
    }
    let reopened = setup(&dir, &endpoint.uri());
    let profiles = providers::load(&reopened.db).await.unwrap();
    assert_eq!(profiles.models.len(), 4);
    let raw = reopened
        .db
        .get::<Value>("settings", "providers")
        .await
        .unwrap()
        .unwrap()
        .to_string();
    assert!(!raw.contains("fixture-model-key"));
    let revision = profiles.revision;
    choose(&server, revision, "opencode", "firecrawl").await;
    let resolved = providers::resolve(&reopened).await.unwrap();
    assert_eq!(resolved.cfg.llm_model(), "gpt-5.6-luna");
    assert_eq!(resolved.cfg.llm_effort(), "high");
    let revision = providers::load(&app.db).await.unwrap().revision;
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
    assert_eq!(restored.cfg.llm_model(), "gpt-6-luna");
    assert_eq!(restored.cfg.llm_effort(), "medium");
    assert_eq!(restored.cfg.search_provider, "firecrawl");
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
    assert_eq!(providers::load(&app.db).await.unwrap().revision, 0);
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
        providers::load(&app.db).await.unwrap().models["zai"]
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
                .set_body_json(answer("zai")),
        )
        .expect(1)
        .mount(&endpoint)
        .await;
    Mock::given(method("POST"))
        .and(body_partial_json(
            json!({"model":"glm-5.3","reasoning_effort":"max"}),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(answer("zai")))
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
    let app = App {
        db: Db::open(&cfg.db_path()).unwrap(),
        judge: chief_of_rust::judgments::from_config(&cfg),
        llm: llm::from_config(&cfg),
        cfg,
    };
    let server = server(&app);
    for (provider, model, effort) in [
        ("mistral", "mistral-medium-3-5", "high"),
        ("opencode", "gpt-5.6-luna", "high"),
        ("zai", "glm-5.3", "max"),
        ("ollama-cloud", "deepseek-v4-pro:0813", "low"),
    ] {
        let revision = providers::load(&app.db).await.unwrap().revision;
        choose(&server, revision, provider, "").await;
        let revision = providers::load(&app.db).await.unwrap().revision;
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
        let completion=selected.llm.complete_measured_schema("Return a JSON object with ok set to true.",&json!({"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false})).await.unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&completion.text).unwrap(),
            json!({"ok":true})
        );
        assert_eq!(selected.cfg.llm_model(), model);
        assert_eq!(selected.cfg.llm_effort(), effort);
        println!("{provider}: model={model}, effort={effort}, schema output passed");
    }
}
