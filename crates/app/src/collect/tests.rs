use crate::collect::{
    CRAWLER_IDENTITY, Clock, Pacer,
    actions::{board_slug, cik_arg},
    run_collector, validate_target,
    web::{
        RobotsRules, extract_page, financial_table_snapshot, parse_robots, robots_allowed,
        robots_match, sitemap_urls,
    },
};
use serde_json::json;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

// Unit tests

/// Records waits and advances virtual time; proves `Pacer` arithmetic
/// without spending the delay.
struct TestClock {
    base: Instant,
    waits: std::sync::Mutex<Vec<Duration>>,
    elapsed: std::sync::Mutex<Duration>,
}

#[async_trait::async_trait]
impl Clock for TestClock {
    fn now(&self) -> Instant {
        self.base + *self.elapsed.lock().unwrap()
    }
    async fn sleep(&self, wait: Duration) {
        self.waits.lock().unwrap().push(wait);
        *self.elapsed.lock().unwrap() += wait;
    }
}

#[tokio::test]
async fn pacing_waits_are_per_origin_and_serialized() {
    let clock = Arc::new(TestClock {
        base: Instant::now(),
        waits: std::sync::Mutex::new(Vec::new()),
        elapsed: std::sync::Mutex::new(Duration::ZERO),
    });
    let pacer = Pacer::with_clock(clock.clone());
    let delay = Duration::from_secs(1);
    pacer.pace("https://a.example:443", delay).await;
    pacer.pace("https://a.example:443", delay).await;
    pacer.pace("https://b.example:443", delay).await;
    // First request to an origin has no prior request; the second waits
    // the full delay; a different origin is independent.
    assert_eq!(
        clock.waits.lock().unwrap().clone(),
        vec![delay],
        "only the repeat on the same origin waits"
    );
    // The deadline is stored before sleeping, so the next same-origin
    // request also waits the full interval.
    pacer.pace("https://a.example:443", delay).await;
    assert_eq!(
        clock.waits.lock().unwrap().clone(),
        vec![delay, delay],
        "serialized callers each observe the interval"
    );
}

#[tokio::test]
async fn explicit_retry_wait_is_recorded_even_when_zero() {
    let clock = Arc::new(TestClock {
        base: Instant::now(),
        waits: std::sync::Mutex::new(Vec::new()),
        elapsed: std::sync::Mutex::new(Duration::ZERO),
    });
    let pacer = Pacer::with_clock(clock.clone());
    pacer.sleep(Duration::ZERO).await;
    assert_eq!(clock.waits.lock().unwrap().clone(), vec![Duration::ZERO]);
}

#[test]
fn page_extraction_retains_main_evidence_before_slicing() {
    let html = format!(
        "<html><head><script>{}</script></head><body><nav>Menu</nav><main><h1>Acme leadership</h1><p>Jane &amp; Sam lead Acme.</p><script>ignore code</script><a href='/report.pdf'>Annual report</a></main><footer>Footer</footer></body></html>",
        "boilerplate".repeat(6000)
    );
    let page = extract_page(&html);
    assert_eq!(
        page.text,
        "Acme leadership Jane & Sam lead Acme. Annual report"
    );
    assert_eq!(page.links, vec!["/report.pdf"]);
}

#[test]
fn credential_bearing_and_private_targets_are_rejected() {
    assert!(validate_target("https://user:pass@example.com/").is_err());
    assert!(validate_target("http://example.com/").is_err());
    assert!(validate_target("https://example.com/?api_key=secret").is_err());
    assert!(validate_target("https://example.com:8443/").is_err());
    assert!(validate_target("https://localhost/").is_err());
    assert!(validate_target("https://example.com./search?API_KEY=x").is_err());
}

#[test]
fn robots_identity_group_wins_over_wildcard() {
    let rules = parse_robots(
        "User-agent: *\nDisallow: /\n\nUser-agent: chief-of-rust-terminal\nDisallow: /private\nAllow: /private/preview\nCrawl-delay: 2\nSitemap: https://example.com/sitemap.xml\n",
        CRAWLER_IDENTITY,
    )
    .expect("identity group applies");
    assert_eq!(rules.crawl_delay_secs, Some(2.0));
    assert_eq!(rules.sitemaps, vec!["https://example.com/sitemap.xml"]);
    assert!(robots_allowed(Some(&rules), "/about"));
    assert!(!robots_allowed(Some(&rules), "/private/pricing"));
    assert!(robots_allowed(Some(&rules), "/private/preview"));
}

#[test]
fn robots_wildcard_fallback_merges_star_groups() {
    let rules = parse_robots(
        "User-agent: otherbot\nDisallow: /other\n\nUser-agent: *\nDisallow: /admin\n",
        CRAWLER_IDENTITY,
    )
    .expect("wildcard fallback applies");
    assert!(!robots_allowed(Some(&rules), "/admin/users"));
    assert!(robots_allowed(Some(&rules), "/other"));
    assert!(robots_allowed(None, "/anything"));
}

#[test]
fn robots_pattern_matching_covers_prefix_star_and_anchor() {
    assert!(robots_match("/private", "/private/pricing"));
    assert!(!robots_match("/private", "/public"));
    assert!(robots_match("/files/*.pdf", "/files/report.pdf"));
    assert!(!robots_match("/files/*.pdf", "/files/report.html"));
    assert!(robots_match("/*.pdf$", "/files/report.pdf"));
    assert!(!robots_match("/*.pdf$", "/files/report.pdf?download=1"));
    // Longest rule wins; ties favor allow.
    let rules = RobotsRules {
        disallow: vec!["/x".into()],
        allow: vec!["/x".into()],
        crawl_delay_secs: None,
        sitemaps: Vec::new(),
    };
    assert!(robots_allowed(Some(&rules), "/x/y"));
}

#[test]
fn sitemap_loc_scan_keeps_absolute_urls_only() {
    let urls = sitemap_urls(
        "<urlset><url><loc>https://example.com/about</loc></url><url><loc>/relative</loc></url></urlset>",
    );
    assert_eq!(urls, vec!["https://example.com/about"]);
}

#[test]
fn collector_argument_validation_rejects_unknown_actions() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let result = runtime.block_on(run_collector("not_a_collector", &json!({}), None));
    assert!(result.is_err());
}

#[test]
fn contact_action_without_contact_fails_before_network_access() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let result = runtime.block_on(run_collector("sec_tickers", &json!({}), None));
    assert!(result.unwrap_err().to_string().contains("operator contact"));
}

#[test]
fn cik_and_board_validation_reject_malformed_identifiers() {
    assert!(cik_arg("0000320193").unwrap() == "0000320193");
    assert!(cik_arg("CIK320193").unwrap() == "0000320193");
    assert!(cik_arg("not-a-cik").is_err());
    assert!(board_slug("acme-corp_1").is_ok());
    assert!(board_slug("../escape").is_err());
}
#[test]
fn financial_columns_remain_attached_to_original_values_and_undated_ttm() {
    let input = "Currency in USD All numbers in thousands Annual Quarterly Breakdown TTM 12/31/2025 12/31/2024 Total Revenue 687,173 624,018 543,676 Basic EPS -.53 -.83 -1.14 Net Income Common Stockholders -81,103 -121,677 -158,058";
    let snapshot = financial_table_snapshot(input).unwrap();
    assert_eq!(snapshot["scale"], "thousands");
    assert_eq!(
        snapshot["concepts"].as_array().unwrap().len(),
        2,
        "Per-share figures must not inherit the monetary scale"
    );
    let entries = snapshot["concepts"][0]["units"]["USD thousands"]
        .as_array()
        .unwrap();
    assert_eq!(entries[0]["column"], "TTM");
    assert!(entries[0]["end"].is_null());
    assert_eq!(entries[1]["end"], "2025-12-31");
    assert_eq!(entries[1]["val"], "624,018");
    assert_eq!(entries[2]["end"], "2024-12-31");
    assert_eq!(entries[2]["val"], "543,676");
    assert_eq!(
        snapshot["concepts"][1]["units"]["USD thousands"][1]["val"],
        "-121,677"
    );
    let decimals =
        financial_table_snapshot("Units USD millions Columns: 2025-12-31 2024-12-31 Revenue .5 .4")
            .unwrap();
    assert_eq!(
        decimals["concepts"][0]["units"]["USD millions"][0]["val"],
        ".5"
    );
    assert!(
        financial_table_snapshot("Unknown units Breakdown TTM 12/31/2025 Revenue 687 624")
            .is_none()
    );
    assert!(
        financial_table_snapshot(
            "Currency in USD All numbers in thousands Breakdown TTM 12/31/2025 Revenue 687 624 543"
        )
        .is_none(),
        "An extra cell must not shift the table mapping"
    );
}
