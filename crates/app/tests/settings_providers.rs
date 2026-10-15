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
