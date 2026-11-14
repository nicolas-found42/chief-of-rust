use super::*;

mod contract_tests {
    use super::*;

    #[derive(Clone)]
    struct FakeSource {
        label: &'static str,
        requirement: SourceRequirement,
        query_capable: bool,
        candidates: Vec<SourceCandidate>,
        error: Option<&'static str>,
    }

    impl FakeSource {
        fn query(label: &'static str, candidates: Vec<SourceCandidate>) -> Self {
            Self {
                label,
                requirement: SourceRequirement::Mandatory,
                query_capable: true,
                candidates,
                error: None,
            }
        }

        fn failing(label: &'static str, error: &'static str) -> Self {
            Self {
                label,
                requirement: SourceRequirement::Mandatory,
                query_capable: true,
                candidates: Vec::new(),
                error: Some(error),
            }
        }

        fn unconfigured(label: &'static str, candidates: Vec<SourceCandidate>) -> Self {
            Self {
                label,
                requirement: SourceRequirement::NotConfigured,
                query_capable: true,
                candidates,
                error: None,
            }
        }

        fn blocked(label: &'static str) -> Self {
            Self {
                label,
                requirement: SourceRequirement::BlockedMissingContact,
                query_capable: true,
                candidates: Vec::new(),
                error: None,
            }
        }

        fn retrieval(label: &'static str, candidates: Vec<SourceCandidate>) -> Self {
            Self {
                label,
                requirement: SourceRequirement::Mandatory,
                query_capable: false,
                candidates,
                error: None,
            }
        }
    }

    #[async_trait]
    impl Source for FakeSource {
        fn label(&self) -> &'static str {
            self.label
        }

        fn capabilities(&self) -> &'static [SourceCapability] {
            if self.query_capable {
                &[SourceCapability::Query]
            } else {
                &[SourceCapability::Retrieval]
            }
        }

        fn requirement(&self) -> SourceRequirement {
            self.requirement
        }

        async fn collect(&self, _request: &SourceRequest) -> SourceOutcome {
            if let Some(error) = self.error {
                return SourceOutcome::Failed(error.to_owned());
            }
            SourceOutcome::Candidates(self.candidates.clone())
        }
    }

    fn candidate(url: &str, title: &str, content: &str) -> SourceCandidate {
        SourceCandidate {
            title: title.to_owned(),
            url: url.to_owned(),
            content: content.to_owned(),
        }
    }

    fn query_hit(source: &str, n: usize) -> SourceCandidate {
        candidate(
            &format!("https://example.com/{source}/{n}"),
            &format!("{source} {n}"),
            &format!("Snippet {n} from {source}"),
        )
    }

    fn registry_with(sources: Vec<FakeSource>, limits: SourceLimits) -> SourceRegistry {
        SourceRegistry::new(
            sources
                .into_iter()
                .map(|s| Arc::new(s) as Arc<dyn Source>)
                .collect(),
            limits,
        )
    }

    fn registry(sources: Vec<FakeSource>) -> SourceRegistry {
        registry_with(sources, SourceLimits::default())
    }

    fn query() -> SourceRequest {
        SourceRequest::Query("rust".into())
    }
    fn retrieval_request(action: &str, args: serde_json::Value) -> RetrievalRequest {
        RetrievalRequest {
            action: action.to_owned(),
            args,
        }
    }

    /// Collector bases resolve through process-global env, so the tests
    /// that repoint them at wiremock serialize on this lock. The guard
    /// spans `.await`, so this is an async lock.
    static COLLECTOR_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    fn retrieval_pacer() -> Arc<crate::collect::Pacer> {
        Arc::new(crate::collect::Pacer::system())
    }

    /// One hermetic provider: collectors resolve their base through the
    /// same `CHIEF_COLLECT_*_BASE` seam the integration tests use. The
    /// caller sets the override to the mock URI and removes it afterwards;
    /// no other lib test reads these variables.
    async fn mock_base(env_key: &str) -> wiremock::MockServer {
        let provider = wiremock::MockServer::start().await;
        unsafe { std::env::set_var(format!("CHIEF_COLLECT_{env_key}_BASE"), provider.uri()) };
        provider
    }

    fn unmock_base(env_key: &str) {
        unsafe { std::env::remove_var(format!("CHIEF_COLLECT_{env_key}_BASE")) };
    }

    #[tokio::test]
    async fn retrieval_runs_each_action_once_with_source_labels() {
        let _guard = COLLECTOR_ENV_LOCK.lock().await;
        let provider = mock_base("DNS").await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(
                serde_json::json!({"Status": 0, "Answer": [{"name": "example.com.", "type": 1, "data": "93.184.216.34"}]}),
            ))
            .mount(&provider)
            .await;
        let collection = SourceRegistry::collect_retrieval(
            &retrieval_pacer(),
            None,
            vec![retrieval_request(
                "dns",
                serde_json::json!({"domain": "example.com", "record_type": "A"}),
            )],
        )
        .await
        .expect("retrieval runs the action");
        unmock_base("DNS");
        assert_eq!(collection.runs.len(), 1);
        assert_eq!(collection.runs[0].action, "dns");
        assert_eq!(collection.runs[0].envelope.action, "dns");
        assert_eq!(collection.diagnostics.len(), 1);
        assert_eq!(collection.diagnostics[0].label, "dns");
        assert_eq!(collection.diagnostics[0].status, SourceStatus::Succeeded);
        assert_eq!(collection.diagnostics[0].received, 1);
        assert_eq!(collection.diagnostics[0].invalid, 0);
        assert_eq!(collection.diagnostics[0].empty, 0);
        assert_eq!(collection.diagnostics[0].selected, 1);
    }

    #[tokio::test]
    async fn retrieval_failure_keeps_diagnostics_and_fails() {
        let _guard = COLLECTOR_ENV_LOCK.lock().await;
        let error = SourceRegistry::collect_retrieval(
            &retrieval_pacer(),
            None,
            vec![retrieval_request("gleif_search", serde_json::json!({}))],
        )
        .await
        .expect_err("a missing required argument fails the retrieval");
        let failure = error
            .downcast_ref::<SourceFailure>()
            .expect("failure carries diagnostics");
        assert_eq!(failure.diagnostics.len(), 1);
        assert_eq!(failure.diagnostics[0].label, "gleif_search");
        assert_eq!(failure.diagnostics[0].status, SourceStatus::Failed);
        assert!(failure.diagnostics[0].error.is_some());
        assert!(failure.to_string().contains("gleif_search"));
    }

    #[tokio::test]
    async fn retrieval_blocked_contact_does_not_fail() {
        let collection = SourceRegistry::collect_retrieval(
            &retrieval_pacer(),
            None,
            vec![retrieval_request("sec_tickers", serde_json::json!({}))],
        )
        .await
        .expect("a blocked prerequisite is not a failure");
        assert!(collection.runs.is_empty());
        assert_eq!(collection.diagnostics.len(), 1);
        assert_eq!(collection.diagnostics[0].label, "sec_tickers");
        assert_eq!(collection.diagnostics[0].status, SourceStatus::Blocked);
    }

    #[tokio::test]
    async fn retrieval_not_configured_does_not_fail() {
        let _guard = COLLECTOR_ENV_LOCK.lock().await;
        unsafe { std::env::set_var("CHIEF_COLLECT_GLEIF_BASE", "") };
        let collection = SourceRegistry::collect_retrieval(
            &retrieval_pacer(),
            None,
            vec![retrieval_request(
                "gleif_search",
                serde_json::json!({"query": "Acme", "limit": 1}),
            )],
        )
        .await
        .expect("an unconfigured Source is not a failure");
        unmock_base("GLEIF");
        assert!(collection.runs.is_empty());
        assert_eq!(collection.diagnostics.len(), 1);
        assert_eq!(
            collection.diagnostics[0].status,
            SourceStatus::NotConfigured
        );
    }

    #[tokio::test]
    async fn retrieval_empty_envelope_counts_empty_not_selected() {
        let _guard = COLLECTOR_ENV_LOCK.lock().await;
        let provider = mock_base("GLEIF").await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(
                serde_json::json!({"data": [], "meta": {"pagination": {"total": 0}}}),
            ))
            .mount(&provider)
            .await;
        let collection = SourceRegistry::collect_retrieval(
            &retrieval_pacer(),
            None,
            vec![retrieval_request(
                "gleif_search",
                serde_json::json!({"query": "Acme", "limit": 1}),
            )],
        )
        .await
        .expect("an empty provider response still succeeds");
        unmock_base("GLEIF");
        assert_eq!(collection.runs.len(), 1);
        assert_eq!(collection.diagnostics[0].received, 1);
        assert_eq!(collection.diagnostics[0].empty, 1);
        assert_eq!(collection.diagnostics[0].selected, 0);
    }

    #[tokio::test]
    async fn ordering_and_round_robin_interleave() {
        let collection = registry(vec![
            FakeSource::query(
                "alpha",
                vec![
                    query_hit("alpha", 1),
                    query_hit("alpha", 2),
                    query_hit("alpha", 3),
                ],
            ),
            FakeSource::query("beta", vec![query_hit("beta", 1), query_hit("beta", 2)]),
        ])
        .collect(query())
        .await
        .expect("fakes succeed");
        let urls: Vec<&str> = collection.hits.iter().map(|h| h.url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "https://example.com/alpha/1",
                "https://example.com/beta/1",
                "https://example.com/alpha/2",
                "https://example.com/beta/2",
                "https://example.com/alpha/3",
            ]
        );
        assert_eq!(collection.hits[0].source, "alpha");
        assert_eq!(collection.hits[1].source, "beta");
        let labels: Vec<&str> = collection
            .diagnostics
            .iter()
            .map(|d| d.label.as_str())
            .collect();
        assert_eq!(labels, vec!["alpha", "beta"]);
    }

    #[tokio::test]
    async fn dedupe_strips_fragments_and_keeps_first() {
        let collection = registry(vec![
            FakeSource::query(
                "alpha",
                vec![
                    candidate("https://example.com/x#f1", "X", "Shared snippet"),
                    query_hit("alpha", 2),
                ],
            ),
            FakeSource::query(
                "beta",
                vec![
                    candidate("https://example.com/x#f2", "X copy", "Shared snippet"),
                    query_hit("beta", 2),
                ],
            ),
        ])
        .collect(query())
        .await
        .expect("fakes succeed");
        let urls: Vec<&str> = collection.hits.iter().map(|h| h.url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "https://example.com/x",
                "https://example.com/alpha/2",
                "https://example.com/beta/2",
            ]
        );
        assert_eq!(collection.hits[0].source, "alpha");
        assert_eq!(collection.coverage.duplicates, 1);
        assert_eq!(collection.diagnostics[0].duplicate, 0);
        assert_eq!(collection.diagnostics[1].duplicate, 0);
        assert_eq!(collection.selection.cross_provider_duplicates, 1);
    }

    #[tokio::test]
    async fn per_source_max_caps_with_omitted() {
        let collection = registry_with(
            vec![FakeSource::query(
                "alpha",
                (1..=5).map(|n| query_hit("alpha", n)).collect(),
            )],
            SourceLimits::clamped(0, 3, 50),
        )
        .collect(query())
        .await
        .expect("fakes succeed");
        assert_eq!(collection.hits.len(), 3);
        assert_eq!(collection.diagnostics[0].selected, 3);
        assert_eq!(collection.diagnostics[0].omitted, 2);
        assert_eq!(collection.coverage.omitted, 2);
    }

    #[tokio::test]
    async fn total_max_caps_across_sources() {
        let collection = registry_with(
            vec![
                FakeSource::query("alpha", (1..=3).map(|n| query_hit("alpha", n)).collect()),
                FakeSource::query("beta", (1..=3).map(|n| query_hit("beta", n)).collect()),
            ],
            SourceLimits::clamped(0, 12, 4),
        )
        .collect(query())
        .await
        .expect("fakes succeed");
        let urls: Vec<&str> = collection.hits.iter().map(|h| h.url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "https://example.com/alpha/1",
                "https://example.com/beta/1",
                "https://example.com/alpha/2",
                "https://example.com/beta/2",
            ]
        );
        assert_eq!(collection.coverage.omitted, 2);
        assert_eq!(collection.diagnostics[0].selected, 2);
        assert_eq!(collection.diagnostics[1].selected, 2);
    }

    #[tokio::test]
    async fn short_count_is_honest_with_gap() {
        let collection = registry(vec![FakeSource::query(
            "alpha",
            (1..=3).map(|n| query_hit("alpha", n)).collect(),
        )])
        .collect(query())
        .await
        .expect("a short Source still succeeds");
        assert_eq!(collection.hits.len(), 3);
        assert_eq!(collection.diagnostics[0].received, 3);
        assert_eq!(collection.diagnostics[0].selected, 3);
        assert_eq!(collection.coverage.selected, 3);
        assert_eq!(
            collection.coverage.gaps,
            vec!["alpha: 3 of 8 minimum results"]
        );
    }

    #[tokio::test]
    async fn empty_source_records_zero_with_gap() {
        let collection = registry(vec![FakeSource::query("alpha", Vec::new())])
            .collect(query())
            .await
            .expect("an empty Source still succeeds");
        assert!(collection.hits.is_empty());
        assert_eq!(collection.diagnostics[0].selected, 0);
        assert_eq!(
            collection.coverage.gaps,
            vec!["alpha: 0 of 8 minimum results"]
        );
    }

    #[tokio::test]
    async fn selection_is_deterministic() {
        let registry = registry(vec![
            FakeSource::query("alpha", (1..=4).map(|n| query_hit("alpha", n)).collect()),
            FakeSource::query("beta", (1..=4).map(|n| query_hit("beta", n)).collect()),
        ]);
        let first = registry.collect(query()).await.expect("fakes succeed");
        let second = registry.collect(query()).await.expect("fakes succeed");
        assert_eq!(first.hits, second.hits);
        let summary = |collection: &SourceCollection| {
            collection
                .diagnostics
                .iter()
                .map(|d| {
                    (
                        d.label.clone(),
                        d.status,
                        d.received,
                        d.invalid,
                        d.empty,
                        d.duplicate,
                        d.omitted,
                        d.truncated,
                        d.selected,
                        d.error.clone(),
                    )
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(summary(&first), summary(&second));
    }

    #[tokio::test]
    async fn diagnostic_accounting() {
        let collection = registry(vec![FakeSource::query(
            "alpha",
            vec![
                candidate("https://example.com/good1", "Good one", "Snippet one"),
                candidate("https://example.com/good2", "Good two", "Snippet two"),
                candidate("javascript:alert(1)", "Bad", "x"),
                candidate("https://example.com/empty", "Empty", "   "),
                candidate("ftp://example.com/file", "Ftp", "x"),
                candidate(
                    "https://example.com/long",
                    &"t".repeat(600),
                    &"y".repeat(7000),
                ),
            ],
        )])
        .collect(query())
        .await
        .expect("fakes succeed");
        let diagnostic = &collection.diagnostics[0];
        assert_eq!(diagnostic.received, 6);
        assert_eq!(diagnostic.invalid, 2);
        assert_eq!(diagnostic.empty, 1);
        assert_eq!(diagnostic.truncated, 1);
        assert_eq!(diagnostic.selected, 3);
        let long = collection
            .hits
            .iter()
            .find(|h| h.url == "https://example.com/long")
            .expect("long row is kept truncated, not dropped");
        assert_eq!(long.title.chars().count(), 500);
        assert_eq!(long.content.chars().count(), 6000);
    }

    #[tokio::test]
    async fn public_web_policy_at_registry_boundary() {
        let collection = registry(vec![FakeSource::query(
            "alpha",
            vec![
                candidate("https://example.com/ok", "Ok", "Snippet"),
                candidate("http://localhost/x", "Local", "Snippet"),
                candidate("http://app.localhost/x", "Local", "Snippet"),
                candidate("http://intranet.local/y", "Local", "Snippet"),
                candidate("https://user@example.com/", "Creds", "Snippet"),
                candidate("https://user:pass@example.com/", "Creds", "Snippet"),
                candidate("ftp://example.com/file", "Ftp", "Snippet"),
                candidate("http://93.184.216.34/", "Public literal", "Snippet"),
                candidate("http://10.0.0.1/", "Private", "Snippet"),
                candidate("http://169.254.169.254/", "Link-local", "Snippet"),
            ],
        )])
        .collect(query())
        .await
        .expect("policy rejects rows, not the Run");
        let urls: Vec<&str> = collection.hits.iter().map(|h| h.url.as_str()).collect();
        assert_eq!(
            urls,
            vec!["https://example.com/ok", "http://93.184.216.34/"]
        );
        assert_eq!(collection.diagnostics[0].received, 10);
        assert_eq!(collection.diagnostics[0].invalid, 8);
        assert_eq!(collection.diagnostics[0].selected, 2);
    }

    #[tokio::test]
    async fn failure_keeps_every_diagnostic_and_fails() {
        let error = registry(vec![
            FakeSource::query("alpha", (1..=3).map(|n| query_hit("alpha", n)).collect()),
            FakeSource::failing("beta", "connection refused"),
        ])
        .collect(query())
        .await
        .expect_err("a mandatory failure fails the Run");
        let failure = error
            .downcast_ref::<SourceFailure>()
            .expect("failure carries diagnostics");
        assert!(failure.to_string().contains("beta: connection refused"));
        assert_eq!(failure.diagnostics.len(), 2);
        assert_eq!(failure.diagnostics[0].status, SourceStatus::Succeeded);
        assert_eq!(failure.diagnostics[0].selected, 3);
        assert_eq!(failure.diagnostics[1].status, SourceStatus::Failed);
        assert_eq!(
            failure.diagnostics[1].error.as_deref(),
            Some("connection refused")
        );
    }

    #[tokio::test]
    async fn not_configured_does_not_fail() {
        let collection = registry(vec![
            FakeSource::query("alpha", (1..=8).map(|n| query_hit("alpha", n)).collect()),
            FakeSource::unconfigured("beta", (1..=3).map(|n| query_hit("beta", n)).collect()),
        ])
        .collect(query())
        .await
        .expect("unconfigured is not a failure");
        assert_eq!(collection.hits.len(), 8);
        assert!(collection.hits.iter().all(|h| h.source == "alpha"));
        assert_eq!(
            collection.diagnostics[1].status,
            SourceStatus::NotConfigured
        );
        assert_eq!(collection.diagnostics[1].error, None);
        assert!(collection.coverage.gaps.is_empty());
    }

    #[tokio::test]
    async fn blocked_contact_does_not_fail() {
        let collection = registry(vec![
            FakeSource::query("alpha", (1..=8).map(|n| query_hit("alpha", n)).collect()),
            FakeSource::blocked("beta"),
        ])
        .collect(query())
        .await
        .expect("a blocked prerequisite is not a failure");
        assert_eq!(collection.hits.len(), 8);
        assert_eq!(collection.diagnostics[1].status, SourceStatus::Blocked);
        assert!(collection.coverage.gaps.is_empty());
    }

    #[tokio::test]
    async fn retrieval_source_below_minimum_has_no_gap() {
        let collection = registry(vec![FakeSource::retrieval(
            "alpha",
            (1..=2).map(|n| query_hit("alpha", n)).collect(),
        )])
        .collect(query())
        .await
        .expect("retrieval Sources succeed short");
        assert_eq!(collection.hits.len(), 2);
        assert!(collection.coverage.gaps.is_empty());
    }

    #[test]
    fn limits_clamp_to_safe_bounds() {
        assert_eq!(
            SourceLimits::clamped(8, 12, 50),
            SourceLimits {
                per_source_min: 8,
                per_source_max: 12,
                total_max: 50,
            }
        );
        assert_eq!(
            SourceLimits::clamped(100, 5, 5000),
            SourceLimits {
                per_source_min: 5,
                per_source_max: 5,
                total_max: 200,
            }
        );
        assert_eq!(
            SourceLimits::clamped(0, 0, 0),
            SourceLimits {
                per_source_min: 0,
                per_source_max: 1,
                total_max: 1,
            }
        );
    }

    /// Overrides enter through the environment (issue #53): unset keeps the
    /// defaults, values outside safe bounds clamp, and every deviation from
    /// a default or requested value is recorded for Run diagnostics.
    #[test]
    fn env_overrides_keep_defaults_clamp_and_record_deviations() {
        let defaults = SourceLimits::default();
        let mut env = std::collections::BTreeMap::new();
        let lookup = |key: &str| env.get(key).map(|v: &&str| (*v).to_string());
        let (limits, notes) = SourceLimits::from_env_map(&lookup);
        assert_eq!(limits, defaults);
        assert!(
            notes.is_empty(),
            "unset overrides record nothing: {notes:?}"
        );

        env.insert("CHIEF_SOURCE_MIN_PER_SOURCE", "10");
        env.insert("CHIEF_SOURCE_MAX_PER_SOURCE", "20");
        env.insert("CHIEF_SOURCE_MAX_TOTAL", "80");
        let lookup = |key: &str| env.get(key).map(|v: &&str| (*v).to_string());
        let (limits, notes) = SourceLimits::from_env_map(&lookup);
        assert_eq!(
            limits,
            SourceLimits {
                per_source_min: 10,
                per_source_max: 20,
                total_max: 80,
            }
        );
        assert!(
            notes.is_empty(),
            "in-bounds overrides record nothing: {notes:?}"
        );

        // Unsafe and unparseable values clamp into bounds; each deviation is
        // named so Run diagnostics can show the effective configuration.
        env.insert("CHIEF_SOURCE_MIN_PER_SOURCE", "0");
        env.insert("CHIEF_SOURCE_MAX_PER_SOURCE", "500");
        env.insert("CHIEF_SOURCE_MAX_TOTAL", "bogus");
        let lookup = |key: &str| env.get(key).map(|v: &&str| (*v).to_string());
        let (limits, notes) = SourceLimits::from_env_map(&lookup);
        assert_eq!(
            limits,
            SourceLimits {
                per_source_min: 0,
                per_source_max: 50,
                total_max: 50,
            }
        );
        assert_eq!(
            notes,
            vec![
                "CHIEF_SOURCE_MAX_PER_SOURCE (per-source maximum) 500 clamped to 50",
                "CHIEF_SOURCE_MAX_TOTAL (total maximum) unparseable, kept default 50",
            ],
            "deviations recorded: {notes:?}"
        );

        // The minimum can never exceed the (clamped) maximum.
        env.insert("CHIEF_SOURCE_MIN_PER_SOURCE", "60");
        env.insert("CHIEF_SOURCE_MAX_TOTAL", "80");
        let lookup = |key: &str| env.get(key).map(|v: &&str| (*v).to_string());
        let (limits, notes) = SourceLimits::from_env_map(&lookup);
        assert_eq!(
            limits,
            SourceLimits {
                per_source_min: 50,
                per_source_max: 50,
                total_max: 80,
            }
        );
        assert!(notes.iter().any(|n| n.contains("clamped to 50")));
    }

    /// A MAX override below the default minimum lowers the effective
    /// minimum as a side effect. With MIN unset the note pass would skip
    /// it entirely, so the derived clamp is recorded on its own (issue #53:
    /// every deviation from a default or requested value is recorded).
    #[test]
    fn env_override_max_without_min_records_the_lowered_minimum() {
        let mut env = std::collections::BTreeMap::new();
        env.insert("CHIEF_SOURCE_MAX_PER_SOURCE", "5");
        let lookup = |key: &str| env.get(key).map(|v: &&str| (*v).to_string());
        let (limits, notes) = SourceLimits::from_env_map(&lookup);
        assert_eq!(
            limits,
            SourceLimits {
                per_source_min: 5,
                per_source_max: 5,
                total_max: 50,
            }
        );
        assert_eq!(
            notes,
            vec!["CHIEF_SOURCE_MIN_PER_SOURCE (per-source minimum) default 8 clamped to 5 by CHIEF_SOURCE_MAX_PER_SOURCE".to_string()],
            "the lowered minimum is recorded: {notes:?}"
        );
    }

    #[test]
    fn canonical_identity_keeps_query_drops_fragment() {
        assert_eq!(
            canonical_identity("https://example.com/a?q=1#frag"),
            "https://example.com/a?q=1"
        );
        assert_eq!(canonical_identity("not a url"), "not a url");
    }
}
