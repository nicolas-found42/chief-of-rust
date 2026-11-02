//! Live collector sweep.
//!
//! The public-records collectors need no credentials, so unlike the keyed
//! providers every one of them can be exercised against its real API. Each
//! test asserts the contract the app depends on: a successful envelope with a
//! parsed payload, the provider's own count where it publishes one, and the
//! documented request URL.
//!
//! Ignored by default — they make real network calls — and run explicitly:
//!
//! ```text
//! cargo test -p chief-of-rust --test collectors -- --ignored --test-threads=1
//! ```
//!
//! Providers are public data services. A failure here means either the wire
//! contract changed upstream or the request is malformed; the assertion text
//! names which provider so the docs can be re-read.
use chief_of_rust::collect::{self, CollectorEnvelope, CollectorStatus, Pacer};
use serde_json::json;

/// The operator contact the contact-gated collectors must send.
///
/// SEC, Wikidata and Crossref ask for a reachable address and use it for their
/// polite pools; a fabricated address would be logged by those services and
/// could never receive the throttling notice they promise. The suite therefore
/// requires a real one and skips the gated tests when it is absent rather than
/// sending a placeholder.
fn live_contact() -> Option<String> {
    std::env::var("CHIEF_LIVE_CONTACT")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

/// Skip a contact-gated test when no real operator contact is configured.
macro_rules! require_contact {
    () => {
        match live_contact() {
            Some(contact) => contact,
            None => {
                eprintln!(
                    "skipped: set CHIEF_LIVE_CONTACT to a reachable address to run the \
                     contact-gated collectors (SEC, Wikidata, Crossref)"
                );
                return;
            }
        }
    };
}

/// One collector call against the live provider.
async fn collect(
    action: &str,
    args: serde_json::Value,
    contact: Option<&str>,
) -> CollectorEnvelope {
    collect::run_collector_with(&Pacer::system(), action, &args, contact)
        .await
        .unwrap_or_else(|e| panic!("{action} failed before a response: {e}"))
}

/// A successful envelope still carries provenance, so a test can never pass on
/// an empty body that happened to be HTTP 200.
fn assert_retrieved(envelope: &CollectorEnvelope, action: &str) {
    assert!(
        matches!(
            envelope.status,
            // `Truncated` and `Partial` describe bounded success: the provider
            // answered and the envelope says exactly what was withheld.
            CollectorStatus::Ok
                | CollectorStatus::Partial
                | CollectorStatus::Truncated
                | CollectorStatus::Empty
        ),
        "{action} did not retrieve: status={:?} http={:?} notes={:?}",
        envelope.status,
        envelope.http_status,
        envelope.notes
    );
    assert!(
        envelope
            .http_status
            .is_some_and(|s| (200..300).contains(&s)),
        "{action} returned HTTP {:?}",
        envelope.http_status
    );
    assert!(
        envelope.request_url.starts_with("https://"),
        "{action} did not use HTTPS: {}",
        envelope.request_url
    );
    assert!(
        !envelope.content_sha256.is_empty(),
        "{action} recorded no content hash"
    );
    assert!(
        !envelope.retrieved_at.is_empty(),
        "{action} recorded no retrieval time"
    );
}

/// A public provider may rate-limit or briefly fail: crt.sh returns 502
/// intermittently and GDELT answers 429 under sustained pacing. The collector
/// reports those as `Blocked`/`Error` with the HTTP status and a note rather
/// than pretending success, so the test accepts exactly those documented
/// transient outcomes and still proves the request was well formed.
fn assert_retrieved_or_documented_transient(envelope: &CollectorEnvelope, action: &str) {
    let transient = matches!(
        envelope.status,
        CollectorStatus::Blocked | CollectorStatus::Error
    ) && envelope
        .http_status
        .is_some_and(|s| s == 429 || (500..=599).contains(&s));
    if transient {
        eprintln!(
            "{action} answered HTTP {:?} ({:?}); the collector reported it as a coverage gap",
            envelope.http_status, envelope.notes
        );
        assert!(
            envelope.request_url.starts_with("https://"),
            "{action} did not use HTTPS: {}",
            envelope.request_url
        );
        return;
    }
    assert_retrieved(envelope, action);
}

/// SEC tickers: the company_tickers.json map, filtered by exact normalized name.
#[tokio::test]
#[ignore = "calls the live SEC API"]
async fn sec_ticker_lookup_finds_an_exact_company_name() {
    let contact = require_contact!();
    let envelope = collect("sec_tickers", json!({"query":"Apple Inc."}), Some(&contact)).await;
    assert_retrieved(&envelope, "sec_tickers");
    assert_eq!(envelope.status, CollectorStatus::Ok, "{:?}", envelope.notes);
    let records = envelope.evidence.as_object().expect("ticker map");
    assert_eq!(
        records.len(),
        1,
        "exact-name filtering must retain one record, got {:?}",
        records.keys().collect::<Vec<_>>()
    );
    let (_, record) = records.iter().next().unwrap();
    assert_eq!(record["title"], "Apple Inc.");
    // The CIK is zero-padded to ten digits for the submissions endpoint.
    let cik = record["cik_str"].as_u64().expect("a numeric CIK");
    assert!(cik > 0);
}

/// SEC submissions: the documented `CIK##########.json` company record.
#[tokio::test]
#[ignore = "calls the live SEC API"]
async fn sec_submissions_reads_the_documented_company_record() {
    let contact = require_contact!();
    let envelope = collect("sec_submissions", json!({"cik":"320193"}), Some(&contact)).await;
    assert_retrieved(&envelope, "sec_submissions");
    assert!(
        envelope
            .request_url
            .ends_with("/submissions/CIK0000320193.json"),
        "the CIK must be zero-padded to ten digits: {}",
        envelope.request_url
    );
    assert_eq!(envelope.evidence["name"], "Apple Inc.");
    assert!(
        envelope.evidence["filings"]["recent"]["form"].is_array(),
        "the recent filings table is the payload this action exists for"
    );
}

/// SEC companyfacts: the XBRL fact table for one company.
#[tokio::test]
#[ignore = "calls the live SEC API"]
async fn sec_companyfacts_returns_xbrl_facts() {
    let contact = require_contact!();
    let envelope = collect("sec_companyfacts", json!({"cik":"320193"}), Some(&contact)).await;
    assert_retrieved(&envelope, "sec_companyfacts");
    assert_eq!(envelope.evidence["entityName"], "Apple Inc.");
    assert!(
        envelope.evidence["facts"]["us-gaap"].is_object(),
        "the us-gaap fact namespace is the payload this action exists for"
    );
}

/// SEC companyconcept: one XBRL concept for one filer, the action used when a
/// companyfacts payload is too large to keep whole.
#[tokio::test]
#[ignore = "calls the live SEC API"]
async fn sec_companyconcept_returns_one_xbrl_concept() {
    let contact = require_contact!();
    let envelope = collect(
        "sec_companyconcept",
        json!({"cik":"320193","taxonomy":"us-gaap","concept":"Revenues"}),
        Some(&contact),
    )
    .await;
    assert_retrieved(&envelope, "sec_companyconcept");
    // The response is one concept document: `tag` names the requested
    // concept, `taxonomy` its namespace, and `units` carries the reported
    // values (data.sec.gov/api/xbrl/companyconcept).
    assert_eq!(
        envelope.evidence["tag"], "Revenues",
        "the concept document names the requested tag: {:?}",
        envelope.evidence
    );
    assert_eq!(
        envelope.evidence["taxonomy"], "us-gaap",
        "the concept document names its taxonomy"
    );
    assert!(
        envelope.evidence["units"].is_object(),
        "the units map carries the reported values: {:?}",
        envelope.evidence
    );
    assert!(
        envelope
            .request_url
            .contains("/api/xbrl/companyconcept/CIK0000320193/us-gaap/Revenues.json"),
        "the documented companyconcept path: {}",
        envelope.request_url
    );
}

/// GLEIF: the global legal entity identifier registry.
#[tokio::test]
#[ignore = "calls the live GLEIF API"]
async fn gleif_search_returns_legal_entity_records() {
    let contact = require_contact!();
    let envelope = collect(
        "gleif_search",
        json!({"query":"Apple Inc."}),
        Some(&contact),
    )
    .await;
    assert_retrieved(&envelope, "gleif_search");
    assert!(
        envelope.result_count.unwrap_or(0) > 0,
        "a legal-entity search for a major company returned no records: {:?}",
        envelope.notes
    );
}

/// Wikidata: the documented `wbsearchentities` search.
#[tokio::test]
#[ignore = "calls the live Wikidata API"]
async fn wikidata_search_and_entity_resolve_a_known_item() {
    let contact = require_contact!();
    let searched = collect(
        "wikidata_search",
        json!({"query":"Apple Inc."}),
        Some(&contact),
    )
    .await;
    assert_retrieved(&searched, "wikidata_search");
    // `wbsearchentities` answers with `search: [{id, label, ...}]`.
    let qid = searched.evidence["search"]
        .as_array()
        .and_then(|rows| rows.first())
        .and_then(|row| row["id"].as_str())
        .expect("the documented search[].id identifier")
        .to_owned();
    assert!(
        qid.starts_with('Q'),
        "Wikidata items are Q-identifiers: {qid}"
    );

    let entity = collect("wikidata_entity", json!({"qid": qid}), Some(&contact)).await;
    assert_retrieved(&entity, "wikidata_entity");
    // Special:EntityData answers `{entities: {Q...: {labels, claims, ...}}}`.
    let record = &entity.evidence["entities"][&qid];
    assert!(
        record["labels"].is_object() && record["claims"].is_object(),
        "the entity record must expose its labels and claims: {:?}",
        record.as_object().map(|o| o.keys().collect::<Vec<_>>())
    );
}

/// RDAP: the IANA bootstrap lookup for one domain.
#[tokio::test]
#[ignore = "calls the live RDAP service"]
async fn rdap_returns_a_registration_record() {
    let envelope = collect("rdap", json!({"domain":"example.com"}), None).await;
    assert_retrieved(&envelope, "rdap");
    assert!(
        envelope.evidence.get("ldhName").is_some() || envelope.evidence.get("events").is_some(),
        "an RDAP record must expose the domain name or its events: {:?}",
        envelope
            .evidence
            .as_object()
            .map(|o| o.keys().collect::<Vec<_>>())
    );
}

/// DNS: the documented JSON resolver response.
#[tokio::test]
#[ignore = "calls the live DNS-over-HTTPS resolver"]
async fn dns_returns_resolver_answers() {
    let envelope = collect("dns", json!({"domain":"example.com"}), None).await;
    assert_retrieved(&envelope, "dns");
    assert_eq!(envelope.evidence["Status"], 0, "NOERROR expected");
    assert!(
        envelope.evidence["Answer"].is_array(),
        "the Answer section is the payload this action exists for"
    );
}

/// crt.sh: certificate transparency log search for a domain.
#[tokio::test]
#[ignore = "calls the live certificate transparency log"]
async fn crtsh_returns_certificate_rows() {
    let envelope = collect("crtsh", json!({"domain":"example.com"}), None).await;
    assert_retrieved_or_documented_transient(&envelope, "crtsh");
    if envelope.status == CollectorStatus::Ok {
        assert!(
            envelope.result_count.unwrap_or(0) > 0,
            "certificate transparency returned no rows for example.com: {:?}",
            envelope.notes
        );
    }
}

/// GitHub: the unauthenticated repository search API.
#[tokio::test]
#[ignore = "calls the live GitHub API"]
async fn github_search_returns_repositories() {
    let envelope = collect(
        "github_search",
        json!({"query":"rust language server"}),
        None,
    )
    .await;
    assert_retrieved(&envelope, "github_search");
    assert!(
        envelope.evidence["total_count"].as_u64().unwrap_or(0) > 0,
        "the documented total_count must be present and nonzero"
    );
}

/// Hacker News: the Algolia search API.
#[tokio::test]
#[ignore = "calls the live Hacker News search API"]
async fn hackernews_search_returns_stories() {
    let envelope = collect(
        "hackernews_search",
        json!({"query":"rust programming"}),
        None,
    )
    .await;
    assert_retrieved(&envelope, "hackernews_search");
    assert!(
        envelope.result_count.unwrap_or(0) > 0,
        "no stories returned: {:?}",
        envelope.notes
    );
}

/// Stack Exchange: the documented `/2.3/search/advanced` endpoint.
#[tokio::test]
#[ignore = "calls the live Stack Exchange API"]
async fn stackexchange_search_returns_questions() {
    let envelope = collect(
        "stackexchange_search",
        json!({"query":"borrowck lifetime error"}),
        None,
    )
    .await;
    assert_retrieved(&envelope, "stackexchange_search");
    assert!(
        envelope.evidence["items"].is_array() || envelope.result_count.unwrap_or(0) > 0,
        "the items array is the payload this action exists for"
    );
}

/// GDELT: the documented article search API.
#[tokio::test]
#[ignore = "calls the live GDELT API"]
async fn gdelt_news_returns_articles() {
    let envelope = collect(
        "gdelt_news",
        json!({"query":"semiconductor manufacturing"}),
        None,
    )
    .await;
    assert_retrieved_or_documented_transient(&envelope, "gdelt_news");
}

/// Crossref: the documented works search.
#[tokio::test]
#[ignore = "calls the live Crossref API"]
async fn crossref_search_returns_works() {
    let contact = require_contact!();
    let envelope = collect(
        "crossref_search",
        json!({"query":"transformers attention is all you need"}),
        Some(&contact),
    )
    .await;
    assert_retrieved(&envelope, "crossref_search");
    assert!(
        envelope.evidence["message"]["items"].is_array(),
        "the message.items array is the documented payload"
    );
}

/// Europe PMC: the documented REST search.
#[tokio::test]
#[ignore = "calls the live Europe PMC API"]
async fn europepmc_search_returns_publications() {
    let envelope = collect(
        "europepmc_search",
        json!({"query":"CRISPR base editing"}),
        None,
    )
    .await;
    assert_retrieved(&envelope, "europepmc_search");
    assert!(
        envelope.result_count.unwrap_or(0) > 0,
        "no publications returned: {:?}",
        envelope.notes
    );
}

/// ClinicalTrials.gov: the documented v2 studies query.
#[tokio::test]
#[ignore = "calls the live ClinicalTrials.gov API"]
async fn clinicaltrials_search_returns_studies() {
    let envelope = collect(
        "clinicaltrials_search",
        json!({"query":"semaglutide"}),
        None,
    )
    .await;
    assert_retrieved(&envelope, "clinicaltrials_search");
    assert!(
        envelope.result_count.unwrap_or(0) > 0,
        "no studies returned: {:?}",
        envelope.notes
    );
}

/// openFDA: the documented drug event search.
#[tokio::test]
#[ignore = "calls the live openFDA API"]
async fn openfda_search_returns_reports() {
    let envelope = collect(
        "openfda_search",
        json!({"dataset":"drug/event","query":"metformin"}),
        None,
    )
    .await;
    assert_retrieved(&envelope, "openfda_search");
    assert!(
        envelope.evidence["results"].is_array() || envelope.result_count.unwrap_or(0) > 0,
        "the results array is the payload this action exists for"
    );
}

/// ROR: the documented research organization search.
#[tokio::test]
#[ignore = "calls the live ROR API"]
async fn ror_search_returns_organizations() {
    let envelope = collect(
        "ror_search",
        json!({"query":"Massachusetts Institute of Technology"}),
        None,
    )
    .await;
    assert_retrieved(&envelope, "ror_search");
    assert!(
        envelope.result_count.unwrap_or(0) > 0,
        "no organizations returned: {:?}",
        envelope.notes
    );
}

/// USAspending: the documented award search.
#[tokio::test]
#[ignore = "calls the live USAspending API"]
async fn usaspending_search_returns_awards() {
    let envelope = collect("usaspending_search", json!({"query":"cybersecurity"}), None).await;
    // This action queries six award groups in one call and reports each
    // group's own HTTP status, so the top-level status is derived rather than
    // copied from a single response.
    assert!(
        matches!(
            envelope.status,
            CollectorStatus::Ok
                | CollectorStatus::Partial
                | CollectorStatus::Truncated
                | CollectorStatus::Empty
        ),
        "usaspending_search did not retrieve: {:?} {:?}",
        envelope.status,
        envelope.notes
    );
    assert!(
        envelope
            .request_url
            .ends_with("/api/v2/search/spending_by_award/")
    );
    let groups = envelope.evidence["award_type_groups"]
        .as_array()
        .expect("one record per award group");
    assert_eq!(
        envelope.evidence["source_count"],
        groups.len(),
        "source_count must match the number of group records"
    );
    assert!(
        envelope.evidence["unqueried_groups"]
            .as_array()
            .is_none_or(|missing| missing.is_empty()),
        "every documented award group must be queried"
    );
    for group in groups {
        let status = group["http_status"].as_u64().unwrap_or(0);
        assert!(
            (200..300).contains(&status),
            "group {} returned HTTP {status}",
            group["group"]
        );
    }
}

/// Wayback: the availability API for one archived URL.
#[tokio::test]
#[ignore = "calls the live Wayback Machine API"]
async fn wayback_returns_a_snapshot() {
    let envelope = collect("wayback", json!({"url":"https://example.com"}), None).await;
    assert_retrieved(&envelope, "wayback");
}

/// Lever: the documented public postings API for one board.
#[tokio::test]
#[ignore = "calls the live Lever API"]
async fn lever_jobs_returns_postings() {
    let envelope = collect("lever_jobs", json!({"board":"lever"}), None).await;
    assert_retrieved(&envelope, "lever_jobs");
}

/// Greenhouse: the documented public job board API.
#[tokio::test]
#[ignore = "calls the live Greenhouse API"]
async fn greenhouse_jobs_returns_postings() {
    // Descriptions for a large board exceed the byte cap, which the action
    // documents as retry-without-content; assert that documented fallback.
    let envelope = collect(
        "greenhouse_jobs",
        json!({"board":"anthropic","include_content":false}),
        None,
    )
    .await;
    assert_retrieved(&envelope, "greenhouse_jobs");
    assert!(
        envelope.evidence["jobs"].is_array() || envelope.result_count.unwrap_or(0) > 0,
        "the jobs array is the payload this action exists for"
    );
}

/// Greenhouse single posting: the documented per-job endpoint, used when a
/// board's list payload exceeds the byte cap.
#[tokio::test]
#[ignore = "calls the live Greenhouse API"]
async fn greenhouse_job_returns_one_posting() {
    // Anthropic's public board: take an ID from the list endpoint so this test
    // does not hardcode a posting that may be withdrawn.
    let board = collect(
        "greenhouse_jobs",
        json!({"board":"anthropic","include_content":false}),
        None,
    )
    .await;
    assert_retrieved(&board, "greenhouse_jobs");
    let job_id = board.evidence["jobs"]
        .as_array()
        .and_then(|jobs| jobs.first())
        .and_then(|job| job["id"].as_u64())
        .expect("the board lists at least one posting with a numeric ID");
    let envelope = collect(
        "greenhouse_job",
        json!({"board":"anthropic","job_id":job_id}),
        None,
    )
    .await;
    assert_retrieved(&envelope, "greenhouse_job");
    assert!(
        envelope.evidence["title"].is_string() || envelope.evidence["id"].as_u64() == Some(job_id),
        "the single-posting payload identifies the job: {:?}",
        envelope.evidence
    );
    assert!(
        envelope
            .request_url
            .ends_with(&format!("/v1/boards/anthropic/jobs/{job_id}")),
        "the documented per-job path: {}",
        envelope.request_url
    );
}

/// An unconfigured provider base disables its Source instead of failing a Run,
/// and that decision is made before any network access.
#[test]
fn a_blanked_provider_base_disables_only_that_source() {
    // The contact check runs first, so isolate the base rule with an action
    // that has no contact requirement.
    unsafe { std::env::set_var("CHIEF_COLLECT_GDELT_BASE", "") };
    let disabled = collect::collector_requirement("gdelt_news", None);
    let unrelated = collect::collector_requirement("hackernews_search", None);
    unsafe { std::env::remove_var("CHIEF_COLLECT_GDELT_BASE") };
    assert_eq!(
        disabled,
        chief_of_rust::sources::SourceRequirement::NotConfigured
    );
    assert_eq!(
        unrelated,
        chief_of_rust::sources::SourceRequirement::Mandatory
    );
}

/// A contact-gated action without a contact is blocked before any network
/// access, and that takes precedence over the base check.
#[test]
fn a_missing_contact_blocks_only_the_gated_source() {
    unsafe { std::env::set_var("CHIEF_COLLECT_SEC_WWW_BASE", "") };
    let gated = collect::collector_requirement("sec_tickers", None);
    let with_contact = collect::collector_requirement("sec_tickers", Some("ops@example.com"));
    unsafe { std::env::remove_var("CHIEF_COLLECT_SEC_WWW_BASE") };
    assert_eq!(
        gated,
        chief_of_rust::sources::SourceRequirement::BlockedMissingContact
    );
    // With a contact supplied, the blanked base then disables the Source.
    assert_eq!(
        with_contact,
        chief_of_rust::sources::SourceRequirement::NotConfigured
    );
}
