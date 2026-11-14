use super::{
    CollectorEnvelope, CollectorStatus, MAX_BYTES, RawResponse, TIMEOUT_SECS,
    json::{
        apply_contact, blocked_status, count_results, enc, envelope, json_action_with, limit_arg,
        required_str, strict_json,
    },
    now_iso,
    transport::{
        Pacer, SYSTEM_PACER, bounded_body, collector_get_with, is_loopback_host, pace_key,
        pinned_addresses, provider_base, validate_target,
    },
    web::{action_discover, action_fetch, action_wayback},
};
use crate::research::{content_hash, redact_contact};
use serde_json::{Value, json};
use std::time::Duration;

/// Dispatch one collector action with validated arguments. Unknown actions
/// and unknown arguments are rejected; meaningless requests are never sent
/// just to claim an action ran.
pub async fn run_collector(
    action: &str,
    args: &Value,
    contact: Option<&str>,
) -> anyhow::Result<CollectorEnvelope> {
    run_collector_with(&SYSTEM_PACER, action, args, contact).await
}

/// Pacing-injectable form of [`run_collector`]: the whole action tree shares
/// one caller-owned [`Pacer`] instead of the process-global gate.
pub async fn run_collector_with(
    pacer: &Pacer,
    action: &str,
    args: &Value,
    contact: Option<&str>,
) -> anyhow::Result<CollectorEnvelope> {
    anyhow::ensure!(args.is_object(), "collector arguments must be an object");
    if crate::research::CONTACT_ACTIONS.contains(&action) {
        let contact = contact
            .ok_or_else(|| anyhow::anyhow!("Contact is missing; set the research operator contact in Settings before using {action}"))?;
        return run_contact_action(pacer, action, args, contact).await;
    }
    run_action(pacer, action, args, None).await
}

async fn run_contact_action(
    pacer: &Pacer,
    action: &str,
    args: &Value,
    contact: &str,
) -> anyhow::Result<CollectorEnvelope> {
    crate::research::validate_operator_contact(contact)?;
    match run_action(pacer, action, args, Some(contact)).await {
        Ok(mut envelope) => {
            let serialized = serde_json::to_string(&envelope).unwrap_or_default();
            let redacted = redact_contact(&serialized, contact);
            if redacted != serialized {
                envelope.contact_redacted = true;
            }
            Ok(envelope)
        }
        Err(error) => Err(anyhow::anyhow!(
            "{}",
            redact_contact(&error.to_string(), contact)
        )),
    }
}

pub(crate) fn normalized_company_name(value: &str) -> String {
    let mut words = value
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
        .collect::<Vec<_>>();
    while words.last().is_some_and(|word| {
        matches!(
            word.as_str(),
            "inc" | "incorporated" | "corp" | "corporation" | "llc" | "ltd" | "limited" | "plc"
        )
    }) {
        words.pop();
    }
    words.join(" ")
}

async fn run_action(
    pacer: &Pacer,
    action: &str,
    args: &Value,
    contact: Option<&str>,
) -> anyhow::Result<CollectorEnvelope> {
    let standard_delay = Duration::from_secs(1);
    match action {
        "fetch_url" => action_fetch(pacer, args).await,
        "discover_site" => action_discover(pacer, args).await,
        "wayback" => action_wayback(pacer, args).await,
        "sec_tickers" => {
            let base = provider_base("SEC_WWW", "https://www.sec.gov");
            let url = format!("{base}/files/company_tickers.json");
            let mut envelope =
                json_action_with(pacer, action, "SEC", &url, contact, None, standard_delay).await?;
            envelope.limits = json!({"bytes": MAX_BYTES});
            if let Some(query) = args.get("query").and_then(Value::as_str)
                && matches!(
                    envelope.status,
                    CollectorStatus::Ok | CollectorStatus::Partial
                )
                && let Some(records) = envelope.evidence.as_object()
            {
                let target = normalized_company_name(query);
                let selected = records
                    .iter()
                    .filter(|(_, record)| {
                        !target.is_empty()
                            && record["title"]
                                .as_str()
                                .is_some_and(|name| normalized_company_name(name) == target)
                    })
                    .map(|(key, record)| (key.clone(), record.clone()))
                    .collect::<serde_json::Map<_, _>>();
                envelope.result_count = Some(selected.len() as u64);
                envelope.total_result_count = Some(selected.len() as u64);
                envelope.notes.push(format!("Retained {} ticker records with an exact normalized company-name match from {} returned records; unrelated rows omitted. A name match is a research lead, not proof of website or legal identity.", selected.len(), records.len()));
                if selected.is_empty() && !envelope.truncated {
                    envelope.status = CollectorStatus::Empty;
                }
                envelope.evidence = Value::Object(selected);
            }
            Ok(envelope)
        }
        "sec_submissions" => {
            let cik = cik_arg(args.get("cik").and_then(Value::as_str).unwrap_or_default())?;
            let base = provider_base("SEC_DATA", "https://data.sec.gov");
            let url = format!("{base}/submissions/CIK{cik}.json");
            let mut envelope =
                json_action_with(pacer, action, "SEC", &url, contact, None, standard_delay).await?;
            if let Value::Object(map) = &envelope.evidence {
                let recent = map
                    .get("filings")
                    .and_then(|f| f.get("recent"))
                    .and_then(|r| r.get("accessionNumber"))
                    .and_then(Value::as_array)
                    .map(Vec::len)
                    .unwrap_or(0) as u64;
                let older: u64 = map
                    .get("filings")
                    .and_then(|f| f.get("files"))
                    .and_then(Value::as_array)
                    .map(|files| {
                        files
                            .iter()
                            .filter_map(|f| f.get("filingCount").and_then(Value::as_u64))
                            .sum()
                    })
                    .unwrap_or(0);
                envelope.result_count = Some(recent);
                envelope.total_result_count = Some(recent);
                envelope.limits = json!({"bytes": MAX_BYTES});
                if older > 0 {
                    envelope.notes.push(format!(
                        "Older filing shards hold {older} additional filings; recent array count is {recent}."
                    ));
                    if envelope.status == CollectorStatus::Ok {
                        envelope.status = CollectorStatus::Partial;
                    }
                }
            }
            Ok(envelope)
        }
        "sec_companyfacts" => action_companyfacts(pacer, args, contact).await,
        "sec_companyconcept" => {
            let cik = cik_arg(args.get("cik").and_then(Value::as_str).unwrap_or_default())?;
            let taxonomy = required_str(args, "taxonomy")?;
            let concept = required_str(args, "concept")?;
            anyhow::ensure!(
                taxonomy.len() <= 40
                    && taxonomy
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
                "invalid SEC taxonomy identifier"
            );
            anyhow::ensure!(
                concept.len() <= 100
                    && concept
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
                "invalid SEC concept identifier"
            );
            let base = provider_base("SEC_DATA", "https://data.sec.gov");
            let url = format!(
                "{base}/api/xbrl/companyconcept/CIK{cik}/{}/{}.json",
                enc(taxonomy),
                enc(concept)
            );
            let mut envelope =
                json_action_with(pacer, action, "SEC", &url, contact, None, standard_delay).await?;
            envelope.limits = json!({"bytes": 500_000});
            if envelope.status == CollectorStatus::Ok {
                envelope.result_count = Some(1);
                envelope.total_result_count = Some(1);
            }
            Ok(envelope)
        }
        "gleif_search" => {
            let query = required_str(args, "query")?;
            let limit = limit_arg(args, "limit", 10, 50)?;
            let page = args.get("page_number").and_then(Value::as_u64).unwrap_or(1);
            anyhow::ensure!(
                (1..=10000).contains(&page),
                "page_number must be from 1 to 10000"
            );
            let base = provider_base("GLEIF", "https://api.gleif.org");
            let url = format!(
                "{base}/api/v1/lei-records?filter[fulltext]={}&page[size]={limit}&page[number]={page}",
                enc(query)
            );
            json_action_with(
                pacer,
                action,
                "GLEIF",
                &url,
                contact,
                Some("data"),
                standard_delay,
            )
            .await
        }
        "wikidata_search" => {
            let query = required_str(args, "query")?;
            let limit = limit_arg(args, "limit", 10, 50)?;
            let base = provider_base("WIKIDATA", "https://www.wikidata.org");
            let mut url = format!(
                "{base}/w/api.php?action=wbsearchentities&search={}&language=en&format=json&limit={limit}",
                enc(query)
            );
            if let Some(token) = args.get("continue_token").and_then(Value::as_str) {
                url.push_str(&format!("&continue={}", enc(token)));
            }
            if let Some(continue_from) = args.get("search_continue").and_then(Value::as_u64) {
                url.push_str(&format!("&search-continue={continue_from}"));
            }
            json_action_with(
                pacer,
                action,
                "Wikidata",
                &url,
                contact,
                Some("search"),
                standard_delay,
            )
            .await
        }
        "wikidata_entity" => {
            let qid = required_str(args, "qid")?.to_uppercase();
            anyhow::ensure!(
                qid.len() <= 13
                    && qid.starts_with('Q')
                    && qid[1..].bytes().all(|b| b.is_ascii_digit())
                    && !qid[1..].starts_with('0'),
                "invalid Wikidata QID"
            );
            let base = provider_base("WIKIDATA", "https://www.wikidata.org");
            let url = format!("{base}/wiki/Special:EntityData/{qid}.json");
            json_action_with(
                pacer,
                action,
                "Wikidata",
                &url,
                contact,
                None,
                standard_delay,
            )
            .await
        }
        "rdap" => {
            let domain = domain_arg(required_str(args, "domain")?)?;
            let base = provider_base("RDAP", "https://rdap.org");
            let url = format!("{base}/domain/{}", enc(&domain));
            json_action_with(pacer, action, "RDAP", &url, contact, None, standard_delay).await
        }
        "dns" => {
            let domain = domain_arg(required_str(args, "domain")?)?;
            let record_type = args
                .get("record_type")
                .and_then(Value::as_str)
                .unwrap_or("A")
                .to_uppercase();
            anyhow::ensure!(
                matches!(
                    record_type.as_str(),
                    "A" | "AAAA" | "MX" | "TXT" | "NS" | "CNAME"
                ),
                "record_type must be A, AAAA, MX, TXT, NS, or CNAME"
            );
            let base = provider_base("DNS", "https://dns.google");
            let url = format!("{base}/resolve?name={}&type={record_type}", enc(&domain));
            let raw = collector_get_with(pacer, &url, contact, MAX_BYTES, standard_delay).await?;
            dns_envelope(&raw, &url, &domain, &record_type)
        }
        "crtsh" => {
            let domain = domain_arg(required_str(args, "domain")?)?;
            let base = provider_base("CRTSH", "https://crt.sh");
            let url = format!("{base}/?q=%25.{}&output=json", enc(&domain));
            let mut envelope =
                json_action_with(pacer, action, "crt.sh", &url, contact, None, standard_delay)
                    .await?;
            envelope.notes.push(
                "Certificate transparency is experimental discovery, not ownership proof.".into(),
            );
            Ok(envelope)
        }
        "github_search" => {
            let query = required_str(args, "query")?;
            let kind = args
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("repositories");
            anyhow::ensure!(
                matches!(kind, "repositories" | "users" | "commits" | "issues"),
                "kind must be repositories, users, commits, or issues"
            );
            let limit = limit_arg(args, "limit", 10, 100)?;
            let page = args.get("page").and_then(Value::as_u64).unwrap_or(1);
            anyhow::ensure!((1..=10000).contains(&page), "page must be from 1 to 10000");
            let base = provider_base("GITHUB", "https://api.github.com");
            let url = format!(
                "{base}/search/{kind}?q={}&per_page={limit}&page={page}",
                enc(query)
            );
            json_action_with(
                pacer,
                action,
                "GitHub public search",
                &url,
                contact,
                Some("items"),
                standard_delay,
            )
            .await
        }
        "hackernews_search" => {
            let query = required_str(args, "query")?;
            let limit = limit_arg(args, "limit", 20, 100)?;
            let page = args.get("page").and_then(Value::as_u64).unwrap_or(0);
            anyhow::ensure!(page <= 10000, "page must be from 0 to 10000");
            let base = provider_base("HACKERNEWS", "https://hn.algolia.com");
            let url = format!(
                "{base}/api/v1/search?query={}&hitsPerPage={limit}&page={page}",
                enc(query)
            );
            json_action_with(
                pacer,
                action,
                "Hacker News Algolia",
                &url,
                contact,
                Some("hits"),
                standard_delay,
            )
            .await
        }
        "stackexchange_search" => {
            let query = required_str(args, "query")?;
            let site = args
                .get("site")
                .and_then(Value::as_str)
                .unwrap_or("stackoverflow");
            anyhow::ensure!(
                site.len() <= 40
                    && site.bytes().all(|b| b.is_ascii_lowercase()
                        || b.is_ascii_digit()
                        || b == b'.'
                        || b == b'-'),
                "invalid StackExchange site"
            );
            let limit = limit_arg(args, "limit", 20, 100)?;
            let page = args.get("page").and_then(Value::as_u64).unwrap_or(1);
            anyhow::ensure!((1..=10000).contains(&page), "page must be from 1 to 10000");
            let base = provider_base("STACKEXCHANGE", "https://api.stackexchange.com");
            let url = format!(
                "{base}/2.3/search/advanced?order=desc&sort=relevance&q={}&site={}&pagesize={limit}&page={page}",
                enc(query),
                enc(site)
            );
            json_action_with(
                pacer,
                action,
                "Stack Exchange",
                &url,
                contact,
                Some("items"),
                standard_delay,
            )
            .await
        }
        "gdelt_news" => {
            let query = required_str(args, "query")?;
            let limit = limit_arg(args, "limit", 20, 250)?;
            let timespan = args
                .get("timespan")
                .and_then(Value::as_str)
                .unwrap_or("30d");
            anyhow::ensure!(
                timespan.len() <= 4
                    && timespan.ends_with('d')
                    && timespan[..timespan.len() - 1]
                        .parse::<u64>()
                        .is_ok_and(|n| (1..=90).contains(&n)),
                "timespan must be 1d through 90d"
            );
            let base = provider_base("GDELT", "https://api.gdeltproject.org");
            let url = format!(
                "{base}/api/v2/doc/doc?query={}&mode=artlist&format=json&sort=datedesc&maxrecords={limit}&timespan={timespan}",
                enc(query)
            );
            let mut envelope = json_action_with(
                pacer,
                action,
                "GDELT DOC",
                &url,
                contact,
                Some("articles"),
                Duration::from_secs(5),
            )
            .await?;
            if envelope.http_status == Some(429) {
                let wait = envelope.retry_after_secs.unwrap_or(5.0);
                if wait <= 30.0 {
                    pacer.sleep(Duration::from_secs_f64(wait)).await;
                    envelope = json_action_with(
                        pacer,
                        action,
                        "GDELT DOC",
                        &url,
                        contact,
                        Some("articles"),
                        Duration::from_secs(5),
                    )
                    .await?;
                    envelope.notes.push("Initial rate limit retried once after the provider delay; further rate limits remain an explicit coverage gap.".into());
                } else {
                    envelope.notes.push("Provider retry delay exceeds the bounded automatic retry window; rate-limited coverage remains unavailable.".into());
                }
            }
            envelope.limits =
                json!({"results": limit, "timespan": timespan, "request_interval_seconds": 5});
            envelope.notes.push("Recent indexed articles only. No total or cursor. Partition time/domain/query when saturated and retrieve originals.".into());
            Ok(envelope)
        }
        "lever_jobs" => {
            let board = board_slug(required_str(args, "board")?)?;
            let limit = limit_arg(args, "limit", 20, 100)?;
            let skip = args.get("skip").and_then(Value::as_u64).unwrap_or(0);
            anyhow::ensure!(skip <= 25000, "skip must be from 0 to 25000");
            let base = provider_base("LEVER", "https://api.lever.co");
            let url = format!("{base}/v0/postings/{board}?mode=json&limit={limit}&skip={skip}");
            let mut envelope = json_action_with(
                pacer,
                action,
                "Lever public postings",
                &url,
                contact,
                None,
                standard_delay,
            )
            .await?;
            envelope.notes.push("Published board postings only; resolve employer association and duplicates. Not total employment or all vacancies.".into());
            Ok(envelope)
        }
        "greenhouse_jobs" => {
            let board = board_slug(required_str(args, "board")?)?;
            let include_content = args
                .get("include_content")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let base = provider_base("GREENHOUSE", "https://boards-api.greenhouse.io");
            let url = format!("{base}/v1/boards/{board}/jobs?content={include_content}");
            let mut envelope = json_action_with(
                pacer,
                action,
                "Greenhouse public job board",
                &url,
                contact,
                Some("jobs"),
                standard_delay,
            )
            .await?;
            envelope.notes.push("Published board postings only; resolve employer association and duplicates. If descriptions exceed the byte cap, retry with include_content=false, then use greenhouse_job for selected public IDs.".into());
            Ok(envelope)
        }
        "greenhouse_job" => {
            let board = board_slug(required_str(args, "board")?)?;
            let job_id = args
                .get("job_id")
                .and_then(Value::as_u64)
                .ok_or_else(|| anyhow::anyhow!("job_id must be a positive bounded integer"))?;
            anyhow::ensure!(
                (1..=10u64.pow(15)).contains(&job_id),
                "job_id must be a positive bounded integer"
            );
            let base = provider_base("GREENHOUSE", "https://boards-api.greenhouse.io");
            let url = format!("{base}/v1/boards/{board}/jobs/{job_id}");
            let mut envelope = json_action_with(
                pacer,
                action,
                "Greenhouse public job board",
                &url,
                contact,
                None,
                standard_delay,
            )
            .await?;
            if matches!(
                envelope.status,
                CollectorStatus::Ok | CollectorStatus::Empty | CollectorStatus::Truncated
            ) && (envelope.evidence.get("id").and_then(Value::as_u64) != Some(job_id)
                || !envelope
                    .evidence
                    .get("content")
                    .is_some_and(Value::is_string))
            {
                envelope.status = CollectorStatus::Error;
                envelope.evidence =
                    json!({"shape_error": "Expected matching job ID and description"});
            }
            envelope.result_count = Some(if envelope.status == CollectorStatus::Ok {
                1
            } else {
                0
            });
            envelope.notes.push(
                "One published job only; verify employer association and listing date.".into(),
            );
            Ok(envelope)
        }
        "crossref_search" => {
            let query = required_str(args, "query")?;
            let limit = limit_arg(args, "limit", 10, 100)?;
            let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0);
            anyhow::ensure!(offset <= 1000000, "offset must be from 0 to 1000000");
            let base = provider_base("CROSSREF", "https://api.crossref.org");
            let url = format!(
                "{base}/works?query={}&rows={limit}&offset={offset}",
                enc(query)
            );
            json_action_with(
                pacer,
                action,
                "Crossref",
                &url,
                contact,
                Some("message.items"),
                standard_delay,
            )
            .await
        }
        "europepmc_search" => {
            let query = required_str(args, "query")?;
            let limit = limit_arg(args, "limit", 10, 100)?;
            let cursor = args
                .get("cursor_mark")
                .and_then(Value::as_str)
                .unwrap_or("*");
            let base = provider_base("EUROPEPMC", "https://www.ebi.ac.uk");
            let url = format!(
                "{base}/europepmc/webservices/rest/search?query={}&format=json&resultType=lite&pageSize={limit}&cursorMark={}",
                enc(query),
                enc(cursor)
            );
            let mut envelope = json_action_with(
                pacer,
                action,
                "Europe PMC",
                &url,
                contact,
                Some("resultList.result"),
                standard_delay,
            )
            .await?;
            if envelope.status == CollectorStatus::Ok
                && let Some(Value::String(mark)) =
                    envelope.evidence.pointer("/resultList/nextCursorMark")
                && !mark.is_empty()
            {
                envelope.next_cursor = Some(mark.clone());
                envelope.status = CollectorStatus::Truncated;
                envelope.truncated = true;
            }
            Ok(envelope)
        }
        "clinicaltrials_search" => {
            let query = required_str(args, "query")?;
            let limit = limit_arg(args, "limit", 10, 100)?;
            let base = provider_base("CLINICALTRIALS", "https://clinicaltrials.gov");
            let mut url = format!(
                "{base}/api/v2/studies?query.term={}&pageSize={limit}",
                enc(query)
            );
            if let Some(token) = args.get("page_token").and_then(Value::as_str) {
                url.push_str(&format!("&pageToken={}", enc(token)));
            }
            json_action_with(
                pacer,
                action,
                "ClinicalTrials.gov",
                &url,
                contact,
                Some("studies"),
                standard_delay,
            )
            .await
        }
        "openfda_search" => {
            let dataset = required_str(args, "dataset")?;
            anyhow::ensure!(
                matches!(
                    dataset,
                    "drug/enforcement"
                        | "food/enforcement"
                        | "device/enforcement"
                        | "drug/event"
                        | "device/event"
                        | "drug/label"
                ),
                "unsupported FDA dataset"
            );
            let query = required_str(args, "query")?;
            let limit = limit_arg(args, "limit", 20, 100)?;
            let skip = args.get("skip").and_then(Value::as_u64).unwrap_or(0);
            anyhow::ensure!(skip <= 25000, "skip must be from 0 to 25000");
            let base = provider_base("OPENFDA", "https://api.fda.gov");
            let url = format!(
                "{base}/{dataset}.json?search={}&limit={limit}&skip={skip}",
                enc(query)
            );
            let mut envelope = openfda_action(pacer, &url).await?;
            envelope.limits =
                json!({"results": limit, "skip": skip, "anonymous_daily_quota": 1000});
            envelope.notes.push("FDA reports/recalls are not evidence of causality, efficacy or recognized company revenue.".into());
            Ok(envelope)
        }
        "ror_search" => {
            let query = required_str(args, "query")?;
            let page = args.get("page").and_then(Value::as_u64).unwrap_or(1);
            anyhow::ensure!((1..=10000).contains(&page), "page must be from 1 to 10000");
            let base = provider_base("ROR", "https://api.ror.org");
            let url = format!("{base}/v2/organizations?query={}&page={page}", enc(query));
            let mut envelope = json_action_with(
                pacer,
                action,
                "ROR",
                &url,
                contact,
                Some("items"),
                standard_delay,
            )
            .await?;
            envelope
                .notes
                .push("Results are affiliation/entity candidates, not confirmed identity.".into());
            Ok(envelope)
        }
        "usaspending_search" => action_usaspending(pacer, args).await,
        _ => Err(anyhow::anyhow!("unknown collector action: {action}")),
    }
}

pub(super) fn cik_arg(value: &str) -> anyhow::Result<String> {
    let digits: String = value
        .trim()
        .to_uppercase()
        .trim_start_matches("CIK")
        .trim_start_matches('0')
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let digits = if digits.is_empty() {
        "0".into()
    } else {
        digits
    };
    anyhow::ensure!(
        digits.bytes().all(|b| b.is_ascii_digit()) && digits != "0" && digits.len() <= 10,
        "invalid CIK"
    );
    Ok(format!("{:0>10}", digits))
}

fn domain_arg(value: &str) -> anyhow::Result<String> {
    let domain = value.trim().to_lowercase().trim_end_matches('.').to_owned();
    anyhow::ensure!(
        domain.len() <= 253
            && domain.split('.').count() >= 2
            && domain
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
            && !domain.starts_with('.')
            && !domain.starts_with("localhost"),
        "invalid domain"
    );
    Ok(domain)
}

pub(super) fn board_slug(value: &str) -> anyhow::Result<String> {
    anyhow::ensure!(
        !value.is_empty()
            && value.len() <= 100
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
        "invalid public board slug"
    );
    Ok(value.to_owned())
}

fn dns_envelope(
    raw: &RawResponse,
    request_url: &str,
    domain: &str,
    record_type: &str,
) -> anyhow::Result<CollectorEnvelope> {
    let text = String::from_utf8_lossy(&raw.body).into_owned();
    let parsed = if raw.status < 400 {
        strict_json(&text).unwrap_or(json!({"parse_error": "response is not JSON"}))
    } else {
        json!({"body_excerpt": text.chars().take(2000).collect::<String>()})
    };
    let answer_count = parsed
        .get("Answer")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0) as u64;
    let status = if blocked_status(raw.status) {
        CollectorStatus::Blocked
    } else if raw.status >= 400 || parsed.get("Status") == Some(&json!(2)) {
        CollectorStatus::Error
    } else if parsed.get("Status") == Some(&json!(3)) {
        CollectorStatus::Empty
    } else {
        CollectorStatus::Ok
    };
    let mut envelope = envelope(
        "dns",
        "Google Public DNS",
        request_url,
        raw,
        status,
        parsed.clone(),
    );
    envelope.result_count = Some(answer_count);
    envelope.limits = json!({"record_types": 1, "domain": domain, "record_type": record_type});
    Ok(envelope)
}

async fn openfda_action(pacer: &Pacer, url: &str) -> anyhow::Result<CollectorEnvelope> {
    let mut envelope = json_action_with(
        pacer,
        "openfda_search",
        "openFDA",
        url,
        None,
        Some("results"),
        Duration::from_secs(1),
    )
    .await?;
    if envelope.http_status == Some(404)
        && envelope.evidence.get("error").and_then(|e| e.get("code")) == Some(&json!("NOT_FOUND"))
    {
        envelope.status = CollectorStatus::Empty;
        envelope.result_count = Some(0);
    }
    Ok(envelope)
}

pub(crate) const SEC_FINANCIAL_CONCEPTS: &[&str] = &[
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "SalesRevenueServicesNet",
    "SalesRevenueGoodsNet",
    "Revenues",
    "SalesRevenueNet",
    "NetIncomeLoss",
    "OperatingIncomeLoss",
    "Assets",
    "StockholdersEquity",
    "CashAndCashEquivalentsAtCarryingValue",
    "NetCashProvidedByUsedInOperatingActivities",
    "PaymentsToAcquirePropertyPlantAndEquipment",
];

async fn action_companyfacts(
    pacer: &Pacer,
    args: &Value,
    contact: Option<&str>,
) -> anyhow::Result<CollectorEnvelope> {
    let cik = cik_arg(args.get("cik").and_then(Value::as_str).unwrap_or_default())?;
    let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0);
    anyhow::ensure!(offset <= 1000000, "offset must be from 0 to 1000000");
    let limit = limit_arg(args, "limit", 20, 100)?;
    let base = provider_base("SEC_DATA", "https://data.sec.gov");
    let url = format!("{base}/api/xbrl/companyfacts/CIK{cik}.json");
    let raw = collector_get_with(pacer, &url, contact, 20_000_000, Duration::from_secs(1)).await?;
    let text = String::from_utf8_lossy(&raw.body).into_owned();
    let parsed = if raw.status < 400 {
        strict_json(&text)
            .unwrap_or(json!({"parse_error": "successful SEC response was not valid JSON"}))
    } else {
        json!({"body_excerpt": text.chars().take(2000).collect::<String>()})
    };
    let status = if blocked_status(raw.status) {
        CollectorStatus::Blocked
    } else if raw.status >= 400 || parsed.get("parse_error").is_some() {
        CollectorStatus::Error
    } else if raw.truncated {
        CollectorStatus::Partial
    } else {
        CollectorStatus::Ok
    };
    let Some(facts) = parsed.get("facts").and_then(Value::as_object) else {
        let mut envelope = envelope("sec_companyfacts", "SEC", &url, &raw, status, parsed);
        envelope.limits = json!({"bytes": 20_000_000});
        apply_contact(&mut envelope, contact);
        return Ok(envelope);
    };
    let mut concepts: Vec<(String, String)> = facts
        .iter()
        .filter_map(|(tax, group)| {
            group.as_object().map(|metrics| {
                metrics
                    .keys()
                    .map(|name| (tax.clone(), name.clone()))
                    .collect::<Vec<_>>()
            })
        })
        .flatten()
        .collect();
    if args["prioritize_financials"].as_bool() == Some(true) {
        concepts.sort_by_key(|(tax, name)| {
            (
                if tax == "us-gaap" {
                    SEC_FINANCIAL_CONCEPTS
                        .iter()
                        .position(|key| *key == name)
                        .unwrap_or(SEC_FINANCIAL_CONCEPTS.len())
                } else {
                    SEC_FINANCIAL_CONCEPTS.len()
                },
                tax.clone(),
                name.clone(),
            )
        });
    }
    let total = concepts.len() as u64;
    let mut compact =
        json!({"cik": parsed.get("cik"), "entityName": parsed.get("entityName"), "facts": {}});
    let output_cap = 500_000usize;
    let mut returned = 0u64;
    let mut consumed = 0u64;
    let mut omitted = Vec::new();
    for (tax, name) in concepts.iter().skip(offset as usize).take(limit as usize) {
        let item = &facts[tax][name];
        compact["facts"][tax][name] = item.clone();
        let size = serde_json::to_vec(&compact)
            .map(|v| v.len())
            .unwrap_or(usize::MAX);
        if size > output_cap {
            compact["facts"][tax]
                .as_object_mut()
                .map(|m| m.remove(name));
            if compact["facts"][tax]
                .as_object()
                .is_some_and(|m| m.is_empty())
            {
                compact["facts"].as_object_mut().map(|m| m.remove(tax));
            }
            if returned == 0 {
                omitted.push(json!({"taxonomy": tax, "concept": name, "reason": "single concept exceeds output byte cap; retrieve with sec_companyconcept"}));
                consumed += 1;
                continue;
            }
            break;
        }
        returned += 1;
        consumed += 1;
    }
    let more = offset + consumed < total;
    let was_truncated = more || !omitted.is_empty() || raw.truncated;
    let status = if blocked_status(raw.status) {
        CollectorStatus::Blocked
    } else if raw.status >= 400 {
        CollectorStatus::Error
    } else if was_truncated {
        CollectorStatus::Truncated
    } else {
        CollectorStatus::Ok
    };
    let mut envelope = envelope("sec_companyfacts", "SEC", &url, &raw, status, compact);
    envelope.result_count = Some(returned);
    envelope.total_result_count = Some(total);
    if more {
        envelope.next_cursor = Some((offset + consumed).to_string());
    }
    envelope.limits = json!({"bytes": 20_000_000, "concepts": limit, "output_bytes": output_cap, "offset": offset});
    if !omitted.is_empty() {
        envelope.notes.push(format!(
            "{} oversized concept(s) omitted; retrieve with sec_companyconcept.",
            omitted.len()
        ));
    }
    if was_truncated {
        envelope.notes.push(
            "Oversized XBRL concepts page by concept; use the offset cursor for the next slice."
                .into(),
        );
    }
    apply_contact(&mut envelope, contact);
    Ok(envelope)
}

async fn action_usaspending(pacer: &Pacer, args: &Value) -> anyhow::Result<CollectorEnvelope> {
    let query = required_str(args, "query")?;
    let limit = limit_arg(args, "limit", 10, 100)?;
    let page = args.get("page").and_then(Value::as_u64).unwrap_or(1);
    anyhow::ensure!((1..=10000).contains(&page), "page must be from 1 to 10000");
    let base = provider_base("USASPENDING", "https://api.usaspending.gov");
    let url = format!("{base}/api/v2/search/spending_by_award/");
    let groups: [(&str, &[&str]); 6] = [
        ("contracts", &["A", "B", "C", "D"]),
        ("loans", &["07", "08", "F003", "F004"]),
        (
            "idvs",
            &[
                "IDV_A", "IDV_B", "IDV_B_A", "IDV_B_B", "IDV_B_C", "IDV_C", "IDV_D", "IDV_E",
            ],
        ),
        ("grants", &["02", "03", "04", "05", "F001", "F002"]),
        ("other_financial_assistance", &["06", "10", "F006", "F007"]),
        (
            "direct_payments",
            &["09", "11", "F005", "-1", "F008", "F009", "F010"],
        ),
    ];
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let mut responses = Vec::new();
    for (group, codes) in groups {
        let (fields, sort) = if group == "loans" {
            (
                vec![
                    "Award ID",
                    "Recipient Name",
                    "Start Date",
                    "End Date",
                    "Awarding Agency",
                    "Award Type",
                    "Description",
                    "Loan Value",
                ],
                "Loan Value",
            )
        } else {
            (
                vec![
                    "Award ID",
                    "Recipient Name",
                    "Start Date",
                    "End Date",
                    "Awarding Agency",
                    "Award Type",
                    "Description",
                    "Award Amount",
                ],
                "Award Amount",
            )
        };
        let payload = json!({
            "filters": {"recipient_search_text": [query], "award_type_codes": codes},
            "fields": fields,
            "page": page,
            "limit": limit,
            "sort": sort,
            "order": "desc",
            "subawards": false,
        });
        let parsed_url = validate_target(&url)?;
        let host = parsed_url.host_str().unwrap_or_default().to_owned();
        if !is_loopback_host(&host) {
            pinned_addresses(&host, 443).await?;
        }
        pacer
            .pace(&pace_key(&parsed_url), Duration::from_secs(1))
            .await;
        let response = client
            .post(url.clone())
            .header("Content-Type", "application/json")
            .header(
                "User-Agent",
                "chief-of-rust-terminal/0.1 (public research retrieval)",
            )
            .body(serde_json::to_vec(&payload)?)
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("USAspending request failed or timed out"))?;
        let status = response.status().as_u16();
        let (body, truncated) = bounded_body(response, MAX_BYTES).await?;
        let text = String::from_utf8_lossy(&body).into_owned();
        let parsed = if status < 400 {
            strict_json(&text)
                .unwrap_or(json!({"parse_error": "successful HTTP response was not valid JSON"}))
        } else {
            json!({"body_excerpt": text.chars().take(2000).collect::<String>()})
        };
        let group_status = if blocked_status(status) {
            "blocked"
        } else if status >= 400 || parsed.get("parse_error").is_some() {
            "error"
        } else if truncated {
            "truncated"
        } else if count_results(&parsed) == Some(0) {
            "empty"
        } else {
            "ok"
        };
        let rows = parsed
            .get("results")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0) as u64;
        let has_next = parsed
            .get("page_metadata")
            .and_then(|m| m.get("hasNext"))
            .is_some_and(|v| v == &json!(true));
        responses.push(json!({
            "group": group,
            "http_status": status,
            "content_sha256": content_hash(&body),
            "status": if has_next && group_status == "ok" { "truncated" } else { group_status },
            "truncated": truncated || has_next,
            "result_count": rows,
            "evidence": parsed,
        }));
        if group_status == "blocked" {
            break;
        }
    }
    let states: Vec<&str> = responses
        .iter()
        .filter_map(|r| r.get("status").and_then(Value::as_str))
        .collect();
    let overall = if states.contains(&"blocked") {
        CollectorStatus::Blocked
    } else if states.iter().all(|s| *s == "error") {
        CollectorStatus::Error
    } else if states.iter().any(|s| *s == "error" || *s == "partial") {
        CollectorStatus::Partial
    } else if states.contains(&"truncated") {
        CollectorStatus::Truncated
    } else if states.iter().all(|s| *s == "empty") {
        CollectorStatus::Empty
    } else {
        CollectorStatus::Ok
    };
    let queried: std::collections::HashSet<&str> = responses
        .iter()
        .filter_map(|r| r.get("group").and_then(Value::as_str))
        .collect();
    let unqueried: Vec<&str> = groups
        .iter()
        .map(|(name, _)| *name)
        .filter(|name| !queried.contains(name))
        .collect();
    let total: u64 = responses
        .iter()
        .filter_map(|r| r.get("result_count").and_then(Value::as_u64))
        .sum();
    let truncated = responses
        .iter()
        .any(|r| r.get("truncated").is_some_and(|t| t == &json!(true)));
    let mut envelope = CollectorEnvelope {
        action: "usaspending_search".into(),
        source: "USAspending".into(),
        request_url: url,
        retrieved_at: now_iso(),
        http_status: None,
        final_url: None,
        content_type: None,
        content_sha256: content_hash(
            serde_json::to_vec(&responses)
                .unwrap_or_default()
                .as_slice(),
        ),
        status: overall,
        truncated,
        retry_after_secs: None,
        evidence: json!({
            "award_type_groups": responses,
            "source_count": responses.len(),
            "successful_source_count": responses.iter().filter(|r| matches!(r.get("status").and_then(Value::as_str), Some("ok" | "empty" | "truncated"))).count(),
            "unqueried_groups": unqueried,
        }),
        result_count: Some(total),
        total_result_count: None,
        next_cursor: if truncated {
            Some((page + 1).to_string())
        } else {
            None
        },
        // A fan-out over award groups has no single transport time; the
        // per-group timings stay in the evidence payload.
        elapsed_ms: None,
        limits: json!({"results_per_award_type_group": limit, "award_type_groups": 6, "page": page}),
        notes: if unqueried.is_empty() {
            Vec::new()
        } else {
            vec![format!(
                "Unqueried award groups after a blocked response: {}.",
                unqueried.join(", ")
            )]
        },
        contact_redacted: false,
    };
    if truncated {
        envelope.notes.push(
            "Award groups page independently; use the page cursor for the next slice.".into(),
        );
    }
    Ok(envelope)
}
