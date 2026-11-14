use super::routes::install_google_token;
use super::*;

/// Normalization unit tests below feed rows through the Registry path: one
/// unnamed legacy Source at default limits keeps row-level behavior (invalid,
/// empty, fragment-dedupe) pinned without the removed eight-cap.
fn search_results(result: &Value) -> anyhow::Result<SearchResults> {
    let hits = result["results"].as_array().ok_or_else(|| {
        anyhow::anyhow!("Search service returned no result list; enable JSON output in SearXNG")
    })?;
    struct LegacySource {
        rows: Vec<crate::sources::SourceCandidate>,
    }
    #[async_trait::async_trait]
    impl crate::sources::Source for LegacySource {
        fn label(&self) -> &'static str {
            "legacy"
        }
        fn capabilities(&self) -> &'static [crate::sources::SourceCapability] {
            &[crate::sources::SourceCapability::Query]
        }
        fn requirement(&self) -> crate::sources::SourceRequirement {
            crate::sources::SourceRequirement::Mandatory
        }
        async fn collect(
            &self,
            _: &crate::sources::SourceRequest,
        ) -> crate::sources::SourceOutcome {
            crate::sources::SourceOutcome::Candidates(self.rows.clone())
        }
    }
    let rows = hits
        .iter()
        .map(|hit| crate::sources::SourceCandidate {
            title: hit["title"].as_str().unwrap_or("Source").to_owned(),
            url: hit["url"].as_str().unwrap_or_default().to_owned(),
            content: hit["content"].as_str().unwrap_or_default().to_owned(),
        })
        .collect();
    let registry = crate::sources::SourceRegistry::new(
        vec![std::sync::Arc::new(LegacySource { rows })
            as std::sync::Arc<dyn crate::sources::Source>],
        crate::sources::SourceLimits::default(),
    );
    let collection = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(registry.collect(crate::sources::SourceRequest::Query(String::new())))?;
    // Keep #11's source evidence inspectable without exposing diagnostic bodies
    // (teardown F3); only bounded
    // engine names are useful to explain search coverage to the operator.
    let unresponsive_engines: Vec<String> = result["unresponsive_engines"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| e.get(0).and_then(Value::as_str))
        .take(40)
        .map(|s| s.chars().take(100).collect())
        .collect();
    let mut mapped =
        search_results_from_registry(&collection, &[], &crate::sources::SourceLimits::default());
    mapped.coverage.unresponsive_engines = unresponsive_engines;
    Ok(mapped)
}

mod search_tests {
    use super::*;

    #[test]
    fn unusable_rows_do_not_hide_later_sources_and_queries_remain_distinct() {
        let mut rows = vec![json!({"url":"javascript:alert(1)","content":"ignore"}); 12];
        rows.extend([
            json!({"url":"https://example.com/article?q=1#intro","content":"One"}),
            json!({"url":"https://example.com/article?q=2#intro","content":"Two"}),
            json!({"url":"https://example.com/article?q=1#conclusion","content":"One"}),
        ]);
        let result = search_results(&json!({"results":rows})).unwrap();
        assert_eq!(result.hits.len(), 2);
        assert_eq!(result.hits[0].url, "https://example.com/article?q=1");
        assert_eq!(result.hits[1].url, "https://example.com/article?q=2");
        assert_eq!(result.coverage.invalid, 12);
        assert_eq!(result.coverage.duplicates, 1);
        assert_eq!(result.coverage.omitted, 0);
    }

    #[test]
    fn blank_first_result_does_not_mask_a_later_usable_duplicate() {
        let result = search_results(&json!({"results":[
            {"url":"https://example.com/","content":"  "},
            {"url":"https://example.com/","content":"Useful later snippet"}
        ]}))
        .unwrap();
        assert_eq!(result.hits[0].content, "Useful later snippet");
        assert_eq!(result.coverage.empty, 1);
        assert_eq!(result.coverage.duplicates, 0);
    }

    #[test]
    fn valid_empty_collections_keep_coverage_but_malformed_collections_fail() {
        for result in [
            json!({"results":[]}),
            json!({"results":[{"url":"https://example.com/"}]}),
            json!({"results":[{"url":"https://example.com/","content":42}]}),
        ] {
            let result = search_results(&result).unwrap();
            assert!(result.hits.is_empty());
            assert_eq!(result.coverage.selected, 0);
        }
        for result in [json!({}), json!({"results":"wrong shape"})] {
            assert!(
                search_results(&result)
                    .unwrap_err()
                    .to_string()
                    .contains("no result list")
            );
        }
    }

    #[test]
    fn coverage_diagnostics_are_bounded_without_provider_error_bodies() {
        let result = search_results(&json!({"results":[{"url":"https://example.com/","content":"Exact text"}],"unresponsive_engines":[["<script>engine</script>","private error body"],["e".repeat(1000),"secret"]]})).unwrap();
        let html = crate::web::search_coverage(&result.coverage);
        assert!(!html.contains("<script>"));
        assert!(html.contains("&lt;script&gt;"));
        assert!(!html.contains("private error body"));
        assert!(!html.contains("secret"));
        assert_eq!(result.coverage.unresponsive_engines[1].len(), 100);
    }
}

// Unit tests
#[tokio::test]
async fn late_oauth_exchange_cannot_restore_a_disconnected_token() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = crate::Config::for_workspace(dir.path().to_path_buf());
    let app = crate::Installation::for_config(cfg).unwrap().app();
    let starting = GoogleBinding::default();
    let disconnected = GoogleBinding {
        generation: 1,
        subject: None,
    };
    app.db()
        .put("google_connection", "current", disconnected.clone())
        .await
        .unwrap();
    let token = GoogleToken {
        access_token: "fixture-access".into(),
        refresh_token: Some("fixture-refresh".into()),
        expires_at: crate::now_ms() + 3_600_000,
        email: "owner@example.test".into(),
        binding: GoogleBinding {
            generation: 1,
            subject: Some("owner-A".into()),
        },
    };
    assert!(
        install_google_token(&app, starting, token)
            .await
            .unwrap_err()
            .to_string()
            .contains("connection changed")
    );
    assert!(!app.cfg().google_token_path.exists());
    assert_eq!(
        app.db()
            .get::<GoogleBinding>("google_connection", "current")
            .await
            .unwrap()
            .unwrap(),
        disconnected
    );
}
#[test]
fn public_sources_cannot_target_local_or_reserved_networks() {
    for ip in [
        "127.0.0.1",
        "10.0.0.1",
        "169.254.169.254",
        "100.64.0.1",
        "192.168.1.1",
        "::1",
        "fc00::1",
        "::ffff:127.0.0.1",
    ] {
        assert!(!public_ip(ip.parse().unwrap()), "{ip}");
    }
    assert!(public_ip("8.8.8.8".parse().unwrap()));
}
/// Provider bases are process-global, so every test that reads them takes
/// this lock; otherwise a parallel test's override leaks into the allowlist
/// assertions.
static PROVIDER_ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn provider_credentials_only_go_to_provider_hosts() {
    let _guard = PROVIDER_ENV.lock().unwrap_or_else(|e| e.into_inner());
    assert!(provider_url("https://www.googleapis.com/calendar/v3/calendars", "google").is_ok());
    for url in [
        "https://googleapis.com.evil.test/",
        "http://www.googleapis.com/",
        "https://user:secret@www.googleapis.com/",
    ] {
        assert!(provider_url(url, "google").is_err());
    }
    // Asana and HubSpot carry installation tokens on bearer auth, so their
    // allowlist is the same boundary as Google's.
    assert!(provider_url("https://app.asana.com/api/1.0/tasks", "asana").is_ok());
    assert!(
        provider_url(
            "https://api.hubapi.com/crm/v3/objects/contacts/search",
            "hubspot"
        )
        .is_ok()
    );
    for (url, service) in [
        ("https://evil.example/api/1.0/tasks", "asana"),
        ("http://app.asana.com/api/1.0/tasks", "asana"),
        ("https://app.asana.com/api/1.0/tasks", "google"),
        (
            "https://evil.example/crm/v3/objects/contacts/search",
            "hubspot",
        ),
        (
            "https://api.hubapi.com/crm/v3/objects/contacts/search",
            "asana",
        ),
    ] {
        assert!(provider_url(url, service).is_err(), "{service} {url}");
    }
}
/// An override must not widen what a provider client will talk to: the
/// destination is checked against the selected provider's allowlist before
/// the override applies, so an off-host or cross-provider URL still fails.
#[test]
fn allowlist_still_rejects_foreign_hosts_while_an_override_is_active() {
    let _guard = PROVIDER_ENV.lock().unwrap_or_else(|e| e.into_inner());
    unsafe { std::env::set_var("CHIEF_COLLECT_GOOGLE_BASE", "http://127.0.0.1:9101") };
    let rewritten =
        provider_url("https://www.googleapis.com/youtube/v3/channels", "google").unwrap();
    let rejected = [
        ("https://evil.example/youtube/v3/channels", "google"),
        ("https://app.asana.com/api/1.0/tasks", "google"),
        ("https://www.googleapis.com/youtube/v3/channels", "asana"),
        (
            "https://user:pass@www.googleapis.com/youtube/v3/channels",
            "google",
        ),
    ]
    .map(|(url, service)| provider_url(url, service));
    unsafe { std::env::remove_var("CHIEF_COLLECT_GOOGLE_BASE") };
    assert_eq!(
        rewritten.as_str(),
        "http://127.0.0.1:9101/youtube/v3/channels"
    );
    for result in rejected {
        assert!(result.is_err(), "{result:?} passed the allowlist");
    }
}
/// The OAuth token endpoint is not operator-overridable: a refreshed access
/// token and its refresh token only ever leave for Google's own host.
#[test]
fn oauth_token_refresh_is_not_redirectable() {
    let _guard = PROVIDER_ENV.lock().unwrap_or_else(|e| e.into_inner());
    for key in ["GOOGLE", "ASANA", "HUBSPOT"] {
        unsafe { std::env::set_var(format!("CHIEF_COLLECT_{key}_BASE"), "http://127.0.0.1:9102") };
    }
    let token_url = provider_url("https://oauth2.googleapis.com/token", "google");
    for key in ["GOOGLE", "ASANA", "HUBSPOT"] {
        unsafe { std::env::remove_var(format!("CHIEF_COLLECT_{key}_BASE")) };
    }
    assert_eq!(
        token_url.unwrap().as_str(),
        "https://oauth2.googleapis.com/token",
        "the token endpoint must never resolve through a provider override"
    );
}
/// A malformed override fails loudly instead of silently redirecting
/// provider traffic to an unexpected scheme or a credential-bearing URL.
#[test]
fn malformed_provider_overrides_fail_instead_of_redirecting() {
    let _guard = PROVIDER_ENV.lock().unwrap_or_else(|e| e.into_inner());
    for override_value in ["ftp://example.test", "https://user:pass@example.test"] {
        unsafe { std::env::set_var("CHIEF_COLLECT_ASANA_BASE", override_value) };
        let error = provider_url("https://app.asana.com/api/1.0/projects/project-7", "asana")
            .unwrap_err()
            .to_string();
        unsafe { std::env::remove_var("CHIEF_COLLECT_ASANA_BASE") };
        assert!(
            !error.contains("pass"),
            "{override_value} leaked credentials"
        );
    }
}
/// A loopback override is the supported way to point a provider at a local
/// proxy; it rewrites only the origin and keeps the provider's path.
#[test]
fn loopback_overrides_rewrite_the_origin_and_keep_the_provider_path() {
    let _guard = PROVIDER_ENV.lock().unwrap_or_else(|e| e.into_inner());
    unsafe { std::env::set_var("CHIEF_COLLECT_HUBSPOT_BASE", "http://127.0.0.1:9100") };
    let url = provider_url(
        "https://api.hubapi.com/crm/v3/objects/contacts/search?limit=5",
        "hubspot",
    )
    .unwrap();
    unsafe { std::env::remove_var("CHIEF_COLLECT_HUBSPOT_BASE") };
    assert_eq!(
        url.as_str(),
        "http://127.0.0.1:9100/crm/v3/objects/contacts/search?limit=5"
    );
}
