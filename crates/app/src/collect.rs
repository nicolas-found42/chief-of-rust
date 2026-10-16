//! Rust-native public-records collectors behind one evidence envelope.
//!
//! Ports the plugin's 26 collector actions (`research.py` + `extensions.py`)
//! without a subprocess: every action returns a [`CollectorEnvelope`] with
//! request/final URL, retrieval time, HTTP status, content hash, transport
//! status and applicable counts/cursors. Transport honors the public-network
//! perimeter (HTTPS-only, per-request DNS safety, redirect revalidation,
//! credential-bearing URL rejection), per-host pacing and Retry-After.
//!
//! Provider API endpoints are operator-configurable through
//! `CHIEF_COLLECT_<PROVIDER>_BASE` environment overrides (the same seam as
//! `SEARXNG_BASE_URL`): a loopback endpoint is only reachable when it matches
//! a configured provider base, never for arbitrary collected targets.

use crate::research::{AccessState, content_hash, redact_contact};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    time::{Duration, Instant},
};

pub const TIMEOUT_SECS: u64 = 18;
pub const MAX_BYTES: usize = 2_000_000;
pub const MAX_REDIRECTS: usize = 5;
pub const TEXT_SLICE_CHARS: usize = 30_000;
pub const LINK_SLICE: usize = 500;
pub const JSON_LD_SLICE: usize = 100;

/// Envelope status. `truncated`/`partial` describe bounded success, never a
/// claim of completeness; `empty` only follows a successful empty response.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CollectorStatus {
    Ok,
    Empty,
    Blocked,
    Error,
    Partial,
    Truncated,
}

impl CollectorStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Empty => "empty",
            Self::Blocked => "blocked",
            Self::Error => "error",
            Self::Partial => "partial",
            Self::Truncated => "truncated",
        }
    }

    pub fn access_state(self) -> AccessState {
        match self {
            Self::Ok => AccessState::Retrieved,
            Self::Empty => AccessState::Empty,
            Self::Blocked => AccessState::Blocked,
            Self::Error => AccessState::Error,
            Self::Partial | Self::Truncated => AccessState::Partial,
        }
    }
}

#[derive(Clone, Debug)]
pub struct RawResponse {
    pub final_url: String,
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
    pub truncated: bool,
    pub retry_after_secs: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CollectorEnvelope {
    pub action: String,
    pub source: String,
    pub request_url: String,
    pub retrieved_at: String,
    pub http_status: Option<u16>,
    pub final_url: Option<String>,
    pub content_type: Option<String>,
    pub content_sha256: String,
    pub status: CollectorStatus,
    pub truncated: bool,
    pub retry_after_secs: Option<f64>,
    pub evidence: Value,
    #[serde(default)]
    pub result_count: Option<u64>,
    #[serde(default)]
    pub total_result_count: Option<u64>,
    #[serde(default)]
    pub next_cursor: Option<String>,
    #[serde(default)]
    pub limits: Value,
    #[serde(default)]
    pub notes: Vec<String>,
    #[serde(default)]
    pub contact_redacted: bool,
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Operator-configured provider base URL, or the production default. The same
/// seam as `SEARXNG_BASE_URL`: tests point providers at wiremock.
pub fn provider_base(env_key: &str, default: &str) -> String {
    let name = format!("CHIEF_COLLECT_{env_key}_BASE");
    std::env::var(&name)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(|v| v.trim_end_matches('/').to_owned())
        .unwrap_or_else(|| default.to_owned())
}

fn configured_bases() -> Vec<String> {
    std::env::vars()
        .filter(|(k, _)| k.starts_with("CHIEF_COLLECT_") && k.ends_with("_BASE"))
        .map(|(_, v)| v.trim_end_matches('/').to_owned())
        .collect()
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
        || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// A loopback target is only reachable when the operator configured that
/// exact host:port as a provider endpoint. Arbitrary collected links never
/// qualify.
fn loopback_allowed(url: &url::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    if !is_loopback_host(host) {
        return false;
    }
    let port = url.port_or_known_default().unwrap_or(80);
    configured_bases().iter().any(|base| {
        url::Url::parse(base).is_ok_and(|b| {
            b.host_str() == Some(host) && b.port_or_known_default().unwrap_or(80) == port
        })
    })
}

fn credential_like_param(key: &str) -> bool {
    matches!(
        key.to_lowercase().as_str(),
        "api_key"
            | "apikey"
            | "access_token"
            | "token"
            | "password"
            | "passwd"
            | "secret"
            | "authorization"
            | "session"
            | "sessionid"
            | "auth"
    ) || key.to_lowercase().contains("api_key")
        || key.to_lowercase().contains("api-key")
        || key.to_lowercase().contains("access_token")
        || key.to_lowercase().contains("access-token")
}

/// Public-HTTPS-only perimeter for collected targets: credential-free URLs on
/// port 443 resolving to global addresses. Provider endpoints keep the same
/// checks except that an operator-configured loopback base is reachable.
pub fn validate_target(url: &str) -> anyhow::Result<url::Url> {
    anyhow::ensure!(
        url.len() <= 8192,
        "URL must be no longer than 8192 characters"
    );
    let parsed = url::Url::parse(url).map_err(|_| anyhow::anyhow!("URL is invalid"))?;
    anyhow::ensure!(
        parsed.username().is_empty() && parsed.password().is_none(),
        "Credential-bearing URLs are not collected"
    );
    if loopback_allowed(&parsed) {
        return Ok(parsed);
    }
    anyhow::ensure!(
        parsed.scheme() == "https" && parsed.port().is_none(),
        "Collected targets must use credential-free HTTPS on port 443"
    );
    let host = parsed
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("URL has no host"))?;
    anyhow::ensure!(
        !host.eq_ignore_ascii_case("localhost")
            && !host.ends_with(".local")
            && !host.ends_with(".localhost"),
        "Local network targets are not collected"
    );
    for (key, _) in parsed.query_pairs() {
        anyhow::ensure!(
            !credential_like_param(&key),
            "Credential-like URL parameters are not collected"
        );
    }
    Ok(parsed)
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let b = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.is_unspecified()
                || ip.is_multicast()
                || b[0] == 0
                || b[0] >= 240
                || (b[0] == 100 && (64..=127).contains(&b[1]))
                || (b[0] == 198 && (b[1] == 18 || b[1] == 19))
                || (b[0] == 192 && b[1] == 0 && b[2] == 0))
        }
        IpAddr::V6(ip) => {
            if let Some(ip) = ip.to_ipv4_mapped() {
                return public_ip(IpAddr::V4(ip));
            }
            let s = ip.segments();
            s[0] & 0xe000 == 0x2000 && !(s[0] == 0x2001 && (s[1] == 0x0db8 || s[1] < 0x0200))
        }
    }
}

async fn pinned_addresses(host: &str, port: u16) -> anyhow::Result<Vec<SocketAddr>> {
    let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| anyhow::anyhow!("Source DNS lookup failed; no unchecked address was used"))?
        .collect();
    anyhow::ensure!(
        !addresses.is_empty() && addresses.iter().all(|a| public_ip(a.ip())),
        "Local, private and reserved network sources are not allowed"
    );
    Ok(addresses)
}

static PACING: std::sync::LazyLock<tokio::sync::Mutex<HashMap<String, Instant>>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(HashMap::new()));

async fn pace(host: &str, delay: Duration) {
    let wait = {
        let mut pacing = PACING.lock().await;
        let now = Instant::now();
        let wait = pacing
            .get(host)
            .and_then(|last| delay.checked_sub(now.duration_since(*last)))
            .unwrap_or_default();
        pacing.insert(host.to_owned(), now + wait);
        wait
    };
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
    }
}

fn retry_after_secs(headers: &reqwest::header::HeaderMap, body_len: usize) -> Option<f64> {
    let _ = body_len;
    let value = headers.get("retry-after")?.to_str().ok()?;
    if let Ok(seconds) = value.trim().parse::<f64>()
        && seconds.is_finite()
    {
        return Some(seconds.max(0.0));
    }
    chrono::DateTime::parse_from_rfc2822(value)
        .ok()
        .map(|date| {
            (date.timestamp_millis() - chrono::Utc::now().timestamp_millis()) as f64 / 1000.0
        })
        .map(|seconds| seconds.max(0.0))
}

async fn bounded_body(
    mut response: reqwest::Response,
    limit: usize,
) -> anyhow::Result<(Vec<u8>, bool)> {
    anyhow::ensure!(
        response.content_length().is_none_or(|n| n <= limit as u64),
        "Provider response exceeds the size limit"
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow::anyhow!("Provider response interrupted"))?
    {
        if bytes.len() + chunk.len() > limit {
            let remaining = limit.saturating_sub(bytes.len());
            bytes.extend_from_slice(&chunk[..remaining]);
            return Ok((bytes, true));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((bytes, false))
}

/// Bounded HTTPS GET with DNS pinning, redirect revalidation and per-host
/// pacing. Used for every collector; arbitrary targets stay inside the
/// public perimeter.
pub async fn collector_get(
    url: &str,
    contact: Option<&str>,
    limit: usize,
    delay: Duration,
) -> anyhow::Result<RawResponse> {
    let mut current = validate_target(url)?.to_string();
    if let Some(contact) = contact {
        crate::research::validate_operator_contact(contact)?;
    }
    for _ in 0..=MAX_REDIRECTS {
        let parsed = validate_target(&current)?;
        let host = parsed.host_str().unwrap_or_default().to_owned();
        let port = parsed.port_or_known_default().unwrap_or(443);
        pace(&host, delay).await;
        let mut client_builder = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(TIMEOUT_SECS))
            .redirect(reqwest::redirect::Policy::none());
        if !is_loopback_host(&host) {
            let addresses = pinned_addresses(&host, port).await?;
            client_builder = client_builder.resolve_to_addrs(&host, &addresses);
        }
        let client = client_builder.build()?;
        let mut request = client.get(current.clone()).header(
            "Accept",
            "application/json, text/html, application/xml, text/xml, */*",
        );
        if let Some(contact) = contact {
            request = request.header(
                "User-Agent",
                format!("chief-of-rust-terminal/0.1 (public research retrieval; {contact})"),
            );
            if host == "api.crossref.org" {
                request =
                    request.header("Agent", format!("chief-of-rust-terminal/0.1 ({contact})"));
            }
        } else {
            request = request.header(
                "User-Agent",
                "chief-of-rust-terminal/0.1 (public research retrieval)",
            );
        }
        let response = request
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Provider request failed or timed out"))?;
        let status = response.status().as_u16();
        let headers = response.headers().clone();
        if (300..400).contains(&status) {
            let location = headers
                .get("location")
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| anyhow::anyhow!("Source redirect has no valid location"))?;
            let next = parsed
                .join(location)
                .map_err(|_| anyhow::anyhow!("Source redirect target is invalid"))?
                .to_string();
            validate_target(&next)?;
            current = next;
            continue;
        }
        let content_type = headers
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let retry_after_secs = retry_after_secs(&headers, 0);
        let (body, truncated) = bounded_body(response, limit).await?;
        return Ok(RawResponse {
            final_url: current,
            status,
            content_type,
            body,
            truncated,
            retry_after_secs,
        });
    }
    anyhow::bail!("Source redirected too many times")
}

fn envelope(
    action: &str,
    source: &str,
    request_url: &str,
    raw: &RawResponse,
    status: CollectorStatus,
    evidence: Value,
) -> CollectorEnvelope {
    CollectorEnvelope {
        action: action.into(),
        source: source.into(),
        request_url: request_url.into(),
        retrieved_at: now_iso(),
        http_status: Some(raw.status),
        final_url: Some(raw.final_url.clone()),
        content_type: Some(raw.content_type.clone()),
        content_sha256: content_hash(&raw.body),
        status,
        truncated: raw.truncated,
        retry_after_secs: raw.retry_after_secs,
        evidence,
        result_count: None,
        total_result_count: None,
        next_cursor: None,
        limits: json!({}),
        notes: Vec::new(),
        contact_redacted: false,
    }
}

fn blocked_status(status: u16) -> bool {
    matches!(status, 401 | 403 | 429)
}

fn strict_json(text: &str) -> anyhow::Result<Value> {
    let value: Value = serde_json::from_str(text)
        .map_err(|_| anyhow::anyhow!("Provider returned an invalid JSON response"))?;
    reject_nonfinite(&value)?;
    Ok(value)
}

fn reject_nonfinite(value: &Value) -> anyhow::Result<()> {
    match value {
        Value::Number(n) => {
            anyhow::ensure!(
                n.as_f64().is_some_and(|f| f.is_finite()),
                "Provider JSON contains a non-finite number"
            );
            Ok(())
        }
        Value::Array(items) => items.iter().try_for_each(reject_nonfinite),
        Value::Object(map) => map.values().try_for_each(reject_nonfinite),
        _ => Ok(()),
    }
}

pub fn count_results(value: &Value) -> Option<u64> {
    count_results_depth(value, 0)
}

fn count_results_depth(value: &Value, depth: usize) -> Option<u64> {
    if let Value::Array(items) = value {
        return Some(items.len() as u64);
    }
    let Value::Object(map) = value else {
        return None;
    };
    if depth > 5 {
        return None;
    }
    for key in [
        "results", "items", "data", "features", "hits", "records", "search", "studies", "result",
        "list",
    ] {
        if let Some(Value::Array(items)) = map.get(key) {
            return Some(items.len() as u64);
        }
    }
    for key in [
        "message",
        "resultList",
        "response",
        "result",
        "meta",
        "pagination",
    ] {
        if let Some(nested) = map.get(key)
            && let Some(n) = count_results_depth(nested, depth + 1)
        {
            return Some(n);
        }
    }
    for key in [
        "total-results",
        "totalResultCount",
        "totalCount",
        "total_count",
        "nbHits",
        "total",
    ] {
        if let Some(Value::Number(n)) = map.get(key)
            && n.as_u64() == Some(0)
        {
            return Some(0);
        }
    }
    None
}

/// Generic JSON API call: strict finite JSON, API/shape error detection,
/// and the plugin's status vocabulary (blocked/error/partial/truncated/
/// empty/ok). Never treats a failed response as a successful empty search.
pub async fn json_action(
    action: &str,
    source: &str,
    url: &str,
    contact: Option<&str>,
    expected_collection: Option<&str>,
    delay: Duration,
) -> anyhow::Result<CollectorEnvelope> {
    let raw = collector_get(url, contact, MAX_BYTES, delay).await?;
    let text = String::from_utf8_lossy(&raw.body).into_owned();
    let mut parsed = if raw.status < 400 {
        match strict_json(&text) {
            Ok(value) => value,
            Err(_) => {
                let mut envelope = envelope(
                    action,
                    source,
                    url,
                    &raw,
                    if raw.truncated {
                        CollectorStatus::Partial
                    } else {
                        CollectorStatus::Error
                    },
                    json!({"parse_error": "successful HTTP response was not valid JSON", "body_excerpt": text.chars().take(2000).collect::<String>()}),
                );
                apply_contact(&mut envelope, contact);
                return Ok(envelope);
            }
        }
    } else {
        json!({"body_excerpt": text.chars().take(2000).collect::<String>()})
    };
    let api_error = parsed.get("error").is_some_and(|e| !e.is_null())
        || parsed.get("errors").is_some_and(|e| !e.is_null())
        || parsed.get("error_id").is_some_and(|e| !e.is_null())
        || (action == "dns" && parsed.get("Status") == Some(&json!(2)));
    let shape_error = match expected_collection {
        Some(path) => {
            let mut current = &parsed;
            let mut missing = false;
            for key in path.split('.') {
                match current.get(key) {
                    Some(next) => current = next,
                    None => {
                        missing = true;
                        break;
                    }
                }
            }
            missing || !current.is_array()
        }
        None => false,
    };
    let result_count = count_results(&parsed);
    let total_count = total_results(&parsed);
    let source_truncated = has_more(&parsed) || next_cursor_value(&parsed).is_some();
    let status = if blocked_status(raw.status) {
        CollectorStatus::Blocked
    } else if raw.status >= 400 || api_error || shape_error {
        CollectorStatus::Error
    } else if raw.truncated || source_truncated {
        CollectorStatus::Truncated
    } else if result_count == Some(0)
        || (action == "dns" && parsed.get("Status") == Some(&json!(3)))
    {
        CollectorStatus::Empty
    } else {
        CollectorStatus::Ok
    };
    if shape_error && raw.status < 400 && !api_error {
        parsed = json!({
            "shape_error": "Expected public result collection is absent or malformed",
            "result_count": result_count,
        });
    }
    let mut envelope = envelope(action, source, url, &raw, status, parsed);
    envelope.result_count = result_count;
    envelope.total_result_count = total_count;
    envelope.next_cursor = next_cursor_value(envelope.evidence());
    apply_contact(&mut envelope, contact);
    Ok(envelope)
}

fn total_results(value: &Value) -> Option<u64> {
    let Value::Object(map) = value else {
        return None;
    };
    for key in [
        "total",
        "total_count",
        "totalCount",
        "totalResultCount",
        "total-results",
        "number_of_results",
        "nbHits",
    ] {
        if let Some(Value::Number(n)) = map.get(key)
            && let Some(n) = n.as_u64()
        {
            return Some(n);
        }
    }
    for key in ["meta", "page_metadata", "message", "resultList", "response"] {
        if let Some(nested) = map.get(key)
            && let Some(n) = total_results(nested)
        {
            return Some(n);
        }
    }
    if let Some(Value::Object(meta)) = map.get("meta")
        && let Some(Value::Object(results)) = meta.get("results")
        && let Some(Value::Number(n)) = results.get("total")
    {
        return n.as_u64();
    }
    None
}

fn has_more(value: &Value) -> bool {
    let Value::Object(map) = value else {
        return false;
    };
    for key in ["has_more", "hasMore", "incomplete_results"] {
        if map.get(key) == Some(&json!(true)) {
            return true;
        }
    }
    if let Some(Value::Object(links)) = map.get("links")
        && links.get("next").is_some()
    {
        return true;
    }
    if let Some(Value::Object(page)) = map.get("page_metadata")
        && page.get("hasNext") == Some(&json!(true))
    {
        return true;
    }
    if let (Some(Value::Number(page)), Some(Value::Number(pages))) =
        (map.get("page"), map.get("nbPages"))
        && let (Some(page), Some(pages)) = (page.as_u64(), pages.as_u64())
    {
        return page + 1 < pages;
    }
    false
}

fn next_cursor_value(value: &Value) -> Option<String> {
    let Value::Object(map) = value else {
        return None;
    };
    for key in [
        "nextCursor",
        "nextPageToken",
        "nextCursorMark",
        "next_cursor",
        "cursor",
        "search-continue",
        "nextcursormark",
    ] {
        match map.get(key) {
            Some(Value::String(s)) if !s.is_empty() => return Some(s.clone()),
            Some(Value::Number(n)) => return Some(n.to_string()),
            _ => {}
        }
    }
    None
}

impl CollectorEnvelope {
    fn evidence(&self) -> &Value {
        &self.evidence
    }
}

fn apply_contact(envelope: &mut CollectorEnvelope, contact: Option<&str>) {
    let Some(contact) = contact else { return };
    let serialized = serde_json::to_string(&envelope.evidence).unwrap_or_default();
    let redacted = redact_contact(&serialized, contact);
    if redacted != serialized {
        envelope.evidence = serde_json::from_str(&redacted).unwrap_or(Value::Null);
        envelope.contact_redacted = true;
    }
}

fn enc(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn limit_arg(args: &Value, key: &str, default: u64, maximum: u64) -> anyhow::Result<u64> {
    let n = args
        .get(key)
        .map(|v| {
            v.as_u64()
                .ok_or_else(|| anyhow::anyhow!("{key} must be an integer from 1 to {maximum}"))
        })
        .transpose()?
        .unwrap_or(default);
    anyhow::ensure!(
        n >= 1 && n <= maximum,
        "{key} must be an integer from 1 to {maximum}"
    );
    Ok(n)
}

fn required_str<'a>(args: &'a Value, key: &str) -> anyhow::Result<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty() && s.len() <= 2000)
        .ok_or_else(|| anyhow::anyhow!("{key} must be a nonempty bounded string"))
}

/// Dispatch one collector action with validated arguments. Unknown actions
/// and unknown arguments are rejected; meaningless requests are never sent
/// just to claim an action ran.
pub async fn run_collector(
    action: &str,
    args: &Value,
    contact: Option<&str>,
) -> anyhow::Result<CollectorEnvelope> {
    anyhow::ensure!(args.is_object(), "collector arguments must be an object");
    if crate::research::CONTACT_ACTIONS.contains(&action) {
        let contact = contact
            .ok_or_else(|| anyhow::anyhow!("Contact is missing; set the research operator contact in Settings before using {action}"))?;
        return run_contact_action(action, args, contact).await;
    }
    run_action(action, args, None).await
}

async fn run_contact_action(
    action: &str,
    args: &Value,
    contact: &str,
) -> anyhow::Result<CollectorEnvelope> {
    crate::research::validate_operator_contact(contact)?;
    match run_action(action, args, Some(contact)).await {
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
    action: &str,
    args: &Value,
    contact: Option<&str>,
) -> anyhow::Result<CollectorEnvelope> {
    let standard_delay = Duration::from_secs(1);
    match action {
        "fetch_url" => action_fetch(args).await,
        "discover_site" => action_discover(args).await,
        "wayback" => action_wayback(args).await,
        "sec_tickers" => {
            let base = provider_base("SEC_WWW", "https://www.sec.gov");
            let url = format!("{base}/files/company_tickers.json");
            let mut envelope =
                json_action(action, "SEC", &url, contact, None, standard_delay).await?;
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
                json_action(action, "SEC", &url, contact, None, standard_delay).await?;
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
        "sec_companyfacts" => action_companyfacts(args, contact).await,
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
                json_action(action, "SEC", &url, contact, None, standard_delay).await?;
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
            json_action(action, "GLEIF", &url, contact, Some("data"), standard_delay).await
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
            json_action(
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
            json_action(action, "Wikidata", &url, contact, None, standard_delay).await
        }
        "rdap" => {
            let domain = domain_arg(required_str(args, "domain")?)?;
            let base = provider_base("RDAP", "https://rdap.org");
            let url = format!("{base}/domain/{}", enc(&domain));
            json_action(action, "RDAP", &url, contact, None, standard_delay).await
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
            let raw = collector_get(&url, contact, MAX_BYTES, standard_delay).await?;
            dns_envelope(&raw, &url, &domain, &record_type)
        }
        "crtsh" => {
            let domain = domain_arg(required_str(args, "domain")?)?;
            let base = provider_base("CRTSH", "https://crt.sh");
            let url = format!("{base}/?q=%25.{}&output=json", enc(&domain));
            let mut envelope =
                json_action(action, "crt.sh", &url, contact, None, standard_delay).await?;
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
            json_action(
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
            json_action(
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
            json_action(
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
            let mut envelope = json_action(
                action,
                "GDELT DOC",
                &url,
                contact,
                None,
                Duration::from_secs(5),
            )
            .await?;
            if envelope.http_status == Some(429) {
                let wait = envelope.retry_after_secs.unwrap_or(5.0);
                if wait <= 30.0 {
                    tokio::time::sleep(Duration::from_secs_f64(wait)).await;
                    envelope = json_action(
                        action,
                        "GDELT DOC",
                        &url,
                        contact,
                        None,
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
            let mut envelope = json_action(
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
            let mut envelope = json_action(
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
            let mut envelope = json_action(
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
            json_action(
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
            let mut envelope = json_action(
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
            json_action(
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
            let mut envelope = openfda_action(&url).await?;
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
            let mut envelope =
                json_action(action, "ROR", &url, contact, Some("items"), standard_delay).await?;
            envelope
                .notes
                .push("Results are affiliation/entity candidates, not confirmed identity.".into());
            Ok(envelope)
        }
        "usaspending_search" => action_usaspending(args).await,
        _ => Err(anyhow::anyhow!("unknown collector action: {action}")),
    }
}

fn cik_arg(value: &str) -> anyhow::Result<String> {
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

fn board_slug(value: &str) -> anyhow::Result<String> {
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
/// Parsed `/robots.txt` rules for one crawler identity. Port of the plugin's
/// Protego behavior at the boundary the app needs: per-path allow/disallow
/// longest-prefix match, `*`/`$` wildcards, crawl-delay, sitemap discovery.
/// Anything unparseable or oversized withholds crawling; only a missing
/// file (404/410) means no restrictions.
#[derive(Clone, Debug, Default)]
struct RobotsRules {
    disallow: Vec<String>,
    allow: Vec<String>,
    crawl_delay_secs: Option<f64>,
    sitemaps: Vec<String>,
}

pub const CRAWLER_IDENTITY: &str = "chief-of-rust-terminal";
const ROBOTS_MAX_BYTES: usize = 100_000;

/// Parse robots.txt for `agent` with `*` fallback. Groups are `user-agent`
/// sections; only the first matching group (exact identity, then wildcard)
/// applies. Returns `None` when no group mentions the agent or `*`.
fn parse_robots(text: &str, agent: &str) -> Option<RobotsRules> {
    let mut groups: Vec<(Vec<String>, RobotsRules)> = Vec::new();
    let mut current_agents: Vec<String> = Vec::new();
    let mut current_rules = RobotsRules::default();
    let mut has_rules = false;
    for raw_line in text.lines() {
        let line = raw_line.split('#').next().unwrap_or_default().trim();
        if line.is_empty() {
            continue;
        }
        let Some((field, value)) = line.split_once(':') else {
            continue;
        };
        let field = field.trim().to_ascii_lowercase();
        let value = value.trim().to_owned();
        match field.as_str() {
            "user-agent" => {
                if has_rules || !current_agents.is_empty() {
                    groups.push((
                        std::mem::take(&mut current_agents),
                        std::mem::take(&mut current_rules),
                    ));
                    has_rules = false;
                }
                current_agents.push(value.to_ascii_lowercase());
            }
            "disallow" | "allow" | "crawl-delay" | "sitemap" => {
                has_rules = true;
                match field.as_str() {
                    "disallow" if !value.is_empty() => current_rules.disallow.push(value),
                    "allow" if !value.is_empty() => current_rules.allow.push(value),
                    "crawl-delay" => {
                        if let Ok(secs) = value.parse::<f64>()
                            && secs.is_finite()
                            && secs >= 0.0
                        {
                            current_rules.crawl_delay_secs = Some(secs);
                        }
                    }
                    "sitemap" if !value.is_empty() => current_rules.sitemaps.push(value),
                    _ => {}
                }
            }
            _ => {}
        }
    }
    if has_rules || !current_agents.is_empty() {
        groups.push((current_agents, current_rules));
    }
    let agent = agent.to_ascii_lowercase();
    if let Some((_, rules)) = groups
        .iter()
        .find(|(agents, _)| agents.iter().any(|a| a == &agent))
    {
        return Some(rules.clone());
    }
    let mut fallback = RobotsRules::default();
    let mut matched = false;
    for (agents, rules) in &groups {
        if agents.iter().any(|a| a == "*") {
            matched = true;
            fallback.disallow.extend(rules.disallow.iter().cloned());
            fallback.allow.extend(rules.allow.iter().cloned());
            fallback.sitemaps.extend(rules.sitemaps.iter().cloned());
            fallback.crawl_delay_secs = fallback.crawl_delay_secs.or(rules.crawl_delay_secs);
        }
    }
    matched.then_some(fallback)
}

/// `*`/`$` robots path matcher: `*` spans any run, a trailing `$` anchors
/// the end, otherwise the pattern is a path prefix. Paths are short;
/// clarity beats cleverness here.
fn robots_match(pattern: &str, path: &str) -> bool {
    let anchored = pattern.strip_suffix('$');
    let needs_end = anchored.is_some();
    let pattern = anchored.unwrap_or(pattern);
    let pat: Vec<u8> = pattern.bytes().collect();
    let text: Vec<u8> = path.bytes().collect();
    let mut stack = vec![(0usize, 0usize)];
    while let Some((p, s)) = stack.pop() {
        if p == pat.len() {
            if !needs_end || s == text.len() {
                return true;
            }
            continue;
        }
        if pat[p] == b'*' {
            stack.push((p + 1, s));
            if s < text.len() {
                stack.push((p, s + 1));
            }
        } else if s < text.len() && pat[p] == text[s] {
            stack.push((p + 1, s + 1));
        }
    }
    false
}

/// Longest matching rule wins; a tie favors allow. No rules means allowed.
fn robots_allowed(rules: Option<&RobotsRules>, path: &str) -> bool {
    let Some(rules) = rules else {
        return true;
    };
    let best_allow = rules
        .allow
        .iter()
        .filter(|p| robots_match(p, path))
        .map(|p| p.len())
        .max();
    let best_disallow = rules
        .disallow
        .iter()
        .filter(|p| robots_match(p, path))
        .map(|p| p.len())
        .max();
    match (best_allow, best_disallow) {
        (Some(a), Some(d)) => a >= d,
        (Some(_), None) => true,
        (None, Some(_)) => false,
        (None, None) => true,
    }
}
// Preserve financial column/value associations before generic text slicing.
// No date is assigned to TTM, and numbers/units are copied without conversion.
pub(crate) fn financial_table_snapshot(text: &str) -> Option<Value> {
    let (start, marker) = ["Breakdown", "Columns:"]
        .into_iter()
        .filter_map(|marker| text.find(marker).map(|start| (start, marker)))
        .min_by_key(|(start, _)| *start)?;
    let context = &text[..start];
    let context_words = context
        .split_whitespace()
        .map(|word| word.trim_matches(|value: char| !value.is_ascii_alphanumeric()))
        .collect::<Vec<_>>();
    let currency = context_words
        .windows(3)
        .find_map(|words| {
            (words[0].eq_ignore_ascii_case("Currency") && words[1].eq_ignore_ascii_case("in"))
                .then_some(words[2])
        })
        .or_else(|| {
            context_words
                .windows(2)
                .find_map(|words| words[0].eq_ignore_ascii_case("Units").then_some(words[1]))
        })?;
    if currency.len() != 3 || !currency.bytes().all(|value| value.is_ascii_uppercase()) {
        return None;
    }
    let scale = context_words
        .windows(4)
        .find_map(|words| {
            (words[..3]
                .iter()
                .zip(["all", "numbers", "in"])
                .all(|(word, expected)| word.eq_ignore_ascii_case(expected)))
            .then_some(words[3])
        })
        .or_else(|| {
            context_words.windows(3).find_map(|words| {
                (words[0].eq_ignore_ascii_case("Units") && words[1] == currency).then_some(words[2])
            })
        })?
        .to_lowercase();
    if !["thousands", "millions", "billions"].contains(&scale.as_str()) {
        return None;
    }
    let tail = text[start + marker.len()..].replace("(end not stated)", "");
    let words = tail
        .split_whitespace()
        .map(|word| word.trim_matches('|'))
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    let date = |word: &str| {
        let word = word.trim_end_matches('.');
        chrono::NaiveDate::parse_from_str(word, "%m/%d/%Y")
            .or_else(|_| chrono::NaiveDate::parse_from_str(word, "%Y-%m-%d"))
            .ok()
    };
    let mut columns = Vec::new();
    let mut index = 0;
    while let Some(word) = words.get(index) {
        if *word == "TTM" {
            columns.push(json!({"column":word,"end":null,"period":"trailing twelve months; end not supplied"}));
        } else if let Some(end) = date(word) {
            columns.push(json!({"column":word,"end":end.to_string()}));
        } else {
            break;
        }
        index += 1;
    }
    if !(2..=8).contains(&columns.len()) {
        return None;
    }
    let numeric = |word: &str| {
        if word == "-" {
            return true;
        }
        let unsigned = word.strip_prefix('-').unwrap_or(word);
        let (integer, fraction) = unsigned
            .split_once('.')
            .map_or((unsigned, None), |(integer, fraction)| {
                (integer, Some(fraction))
            });
        if fraction.is_some_and(|fraction| {
            fraction.is_empty() || !fraction.bytes().all(|value| value.is_ascii_digit())
        }) {
            return false;
        }
        let groups = integer.split(',').collect::<Vec<_>>();
        if integer.is_empty() {
            return fraction.is_some();
        }
        !integer.is_empty()
            && groups
                .iter()
                .all(|group| !group.is_empty() && group.bytes().all(|value| value.is_ascii_digit()))
            && (groups.len() == 1
                || (groups[0].len() <= 3 && groups[1..].iter().all(|group| group.len() == 3)))
    };
    let mut concepts = Vec::new();
    while index < words.len() && concepts.len() < 60 {
        let label_start = index;
        while index < words.len() && !numeric(words[index]) {
            index += 1;
        }
        let label = words[label_start..index]
            .join(" ")
            .trim_end_matches(':')
            .to_owned();
        if label.is_empty()
            || label.len() > 120
            || !label.chars().any(char::is_alphabetic)
            || index + columns.len() > words.len()
        {
            break;
        }
        let values = &words[index..index + columns.len()];
        if !values.iter().all(|word| numeric(word)) {
            break;
        }
        if index + columns.len() < words.len() && numeric(words[index + columns.len()]) {
            break;
        }
        let entries = columns
            .iter()
            .zip(values)
            .map(|(column, value)| {
                let mut entry = column.clone();
                entry["val"] = json!(value);
                entry
            })
            .collect::<Vec<_>>();
        concepts.push(json!({"concept":label,"units":{format!("{currency} {scale}"):entries}}));
        index += columns.len();
    }
    if concepts.is_empty() {
        return None;
    }
    const PRIORITY: &[&str] = &[
        "totalrevenue",
        "revenue",
        "netincomecommonstockholders",
        "totaloperatingincomeasreported",
        "operatingincome",
        "totalassets",
        "stockholdersequity",
        "operatingcashflow",
    ];
    // EPS, rates and share counts do not inherit the table's monetary scale.
    // Retain only explicitly supported monetary row types in this snapshot.
    concepts.retain(|concept| {
        let key = concept["concept"]
            .as_str()
            .unwrap_or_default()
            .chars()
            .filter(|value| value.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect::<String>();
        PRIORITY.contains(&key.as_str())
    });
    if concepts.is_empty() {
        return None;
    }
    concepts.sort_by_key(|concept| {
        let key = concept["concept"]
            .as_str()
            .unwrap_or_default()
            .chars()
            .filter(|value| value.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect::<String>();
        PRIORITY
            .iter()
            .position(|name| *name == key)
            .unwrap_or(PRIORITY.len())
    });
    let mut snapshot = json!({"financial_snapshot":true,"provider_format":"explicit financial table columns","source_context":context.chars().take(700).collect::<String>(),"currency":currency,"scale":scale,"concepts":concepts,"selection":"Selected monetary table rows with original header/value pairs, without numerical conversion. EPS, ratios, rates and share counts are omitted. Dated columns specify period end only; no period end is inferred for TTM. Other rows and page content may be omitted."});
    loop {
        if snapshot.to_string().chars().count() <= 6000 {
            return Some(snapshot);
        }
        let rows = snapshot["concepts"].as_array_mut()?;
        if rows.len() <= 1 {
            return None;
        }
        rows.pop();
    }
}

async fn action_fetch(args: &Value) -> anyhow::Result<CollectorEnvelope> {
    let url = args.get("url").and_then(Value::as_str).unwrap_or_default();
    let limit = args
        .get("max_bytes")
        .and_then(Value::as_u64)
        .map(|kilobytes| (kilobytes as usize).clamp(1, MAX_BYTES / 1024) * 1024)
        .unwrap_or(MAX_BYTES);
    let raw = collector_get(url, None, limit, Duration::from_secs(1)).await?;
    if raw.content_type.contains("pdf") || raw.body.starts_with(b"%PDF-") {
        return action_fetch_pdf(url, args, &raw).await;
    }
    let raw_text = String::from_utf8_lossy(&raw.body).into_owned();
    let mut text = if raw.content_type.contains("html")
        || raw_text
            .trim_start()
            .to_ascii_lowercase()
            .starts_with("<!doctype html")
        || raw_text
            .trim_start()
            .to_ascii_lowercase()
            .starts_with("<html")
    {
        extract_page(&raw_text).text
    } else {
        raw_text
    };
    let original_body_chars = text.chars().count();
    let table_snapshot = financial_table_snapshot(&text);
    let selected_table = table_snapshot.is_some();
    if let Some(snapshot) = table_snapshot {
        text = snapshot.to_string();
    }
    let evidence = json!({
        "text_excerpt": text.chars().take(TEXT_SLICE_CHARS).collect::<String>(),
        "body_chars": original_body_chars,
        "selected_financial_table":selected_table,
        "links_omitted": true,
        "note": "single-page fetch; use discover_site for multi-page robots-gated crawls",
    });
    let status = if blocked_status(raw.status) {
        CollectorStatus::Blocked
    } else if raw.status >= 400 {
        CollectorStatus::Error
    } else if raw.truncated || selected_table {
        CollectorStatus::Truncated
    } else if text.trim().is_empty() {
        CollectorStatus::Empty
    } else {
        CollectorStatus::Ok
    };
    let mut envelope = envelope("fetch_url", "web", url, &raw, status, evidence);
    envelope.limits = json!({"bytes": limit});
    Ok(envelope)
}

/// PDF responses never slice raw bytes as text. Selectable text comes from
/// the isolated worker with page locators; nonzero page offsets are
/// hash-guarded so slices from changed content restart instead of mixing.
async fn action_fetch_pdf(
    url: &str,
    args: &Value,
    raw: &RawResponse,
) -> anyhow::Result<CollectorEnvelope> {
    let (page_offset, max_pages, expected_sha256) = crate::pdf::pdf_args(args);
    let actual_sha256 = content_hash(&raw.body);
    if page_offset > 0 {
        let expected = expected_sha256.as_deref().unwrap_or_default();
        crate::research::check_continuation(
            (!expected.is_empty()).then_some(expected),
            &actual_sha256,
            &[page_offset],
        )?;
    }
    let output = crate::pdf::extract_isolated(&raw.body, page_offset, max_pages).await?;
    let status = if blocked_status(raw.status) {
        CollectorStatus::Blocked
    } else if raw.status >= 400 || output.error.is_some() {
        CollectorStatus::Error
    } else if output.pages.is_empty() {
        CollectorStatus::Empty
    } else if output.truncated || raw.truncated {
        CollectorStatus::Partial
    } else {
        CollectorStatus::Ok
    };
    let mut evidence = json!({
        "pages": output.pages.iter().map(|p| json!({
            "page": p.page,
            "locator": format!("page {}", p.page),
            "text_excerpt": p.text.chars().take(TEXT_SLICE_CHARS).collect::<String>(),
            "page_truncated": p.truncated,
        })).collect::<Vec<_>>(),
        "total_pages": output.total_pages,
        "extraction": "selectable text only; no OCR, no rendered content",
    });
    if let Some(error) = output.error {
        evidence["extraction_error"] = json!(error);
    }
    if !output.notes.is_empty() {
        evidence["extraction_notes"] = json!(output.notes);
    }
    let mut envelope = envelope("fetch_url", "web", url, raw, status, evidence);
    envelope.limits = json!({
        "bytes": raw.body.len(),
        "page_offset": page_offset,
        "max_pages": max_pages,
        "chars_per_page": crate::pdf::PAGE_MAX_CHARS,
    });
    envelope.result_count = Some(output.pages.len() as u64);
    envelope.total_result_count = Some(output.total_pages);
    envelope.notes.push(
        "PDF text extracted in an isolated worker (8 s wall timeout, 2 MB input cap); Unix CPU rlimits are not applied by this build.".into(),
    );
    Ok(envelope)
}

/// Robots-gated same-host discovery crawl. Reads `/robots.txt` for the
/// crawler identity (`*` fallback), honors crawl-delay through the per-host
/// pacing seam, then crawls same-host pages within `max_pages` (1–50) and a
/// 120 s deadline: sitemap URLs seed the queue, feeds and page links extend
/// it, relevant paths go first. Robots withheld (unavailable/oversized
/// except 404/410) blocks the crawl with frontier notes instead of
/// crawling blind. Bounded batches are never completion: the envelope
/// reports visited and remaining queues honestly.
async fn action_discover(args: &Value) -> anyhow::Result<CollectorEnvelope> {
    let url = args.get("url").and_then(Value::as_str).unwrap_or_default();
    let max_pages = args
        .get("max_pages")
        .and_then(Value::as_u64)
        .unwrap_or(20)
        .clamp(1, 50);
    let seed = validate_target(url)?;
    let origin = match seed.port() {
        Some(port) => format!(
            "{}://{}:{port}",
            seed.scheme(),
            seed.host_str().unwrap_or_default()
        ),
        None => format!(
            "{}://{}",
            seed.scheme(),
            seed.host_str().unwrap_or_default()
        ),
    };
    let robots_url = format!("{origin}/robots.txt");
    let robots_raw = collector_get(&robots_url, None, ROBOTS_MAX_BYTES, Duration::from_secs(1))
        .await
        .ok();
    let (robots_rules, robots_note) = match robots_raw.as_ref() {
        None => (
            None,
            Some("robots.txt unreachable; crawling withheld rather than bypassing access controls"),
        ),
        Some(raw) if raw.status == 404 || raw.status == 410 => (None, None),
        Some(raw) if raw.status >= 400 || raw.truncated => (
            None,
            Some(
                "robots.txt unavailable or oversized; crawling withheld rather than bypassing access controls",
            ),
        ),
        Some(raw) => (
            parse_robots(&String::from_utf8_lossy(&raw.body), CRAWLER_IDENTITY),
            None,
        ),
    };
    if let Some(note) = robots_note {
        let raw = RawResponse {
            final_url: url.into(),
            status: 200,
            content_type: String::new(),
            body: Vec::new(),
            truncated: false,
            retry_after_secs: None,
        };
        let mut envelope = envelope(
            "discover_site",
            "web",
            url,
            &raw,
            CollectorStatus::Blocked,
            json!({
                "pages": [],
                "errors": [note],
                "visited_urls": [],
                "remaining_queue_urls": [url],
            }),
        );
        envelope.limits = json!({"pages": max_pages, "origin": origin});
        envelope.notes.push(note.into());
        return Ok(envelope);
    }
    let rules = robots_rules;
    let crawl_delay = rules
        .as_ref()
        .and_then(|r| r.crawl_delay_secs)
        .unwrap_or(1.0)
        .clamp(1.0, 30.0);
    let pace_delay = Duration::from_secs_f64(crawl_delay);
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut queue: std::collections::VecDeque<String> =
        std::collections::VecDeque::from([url.to_owned()]);
    if let Some(rules) = rules.as_ref() {
        for sitemap_url in &rules.sitemaps {
            if queue.len() < 500 && validate_target(sitemap_url).is_ok() {
                queue.push_back(sitemap_url.clone());
            }
        }
    }
    let sitemap_queue = format!("{origin}/sitemap.xml");
    if validate_target(&sitemap_queue).is_ok() {
        queue.push_back(sitemap_queue);
    }
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut pages = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let mut visited = Vec::new();
    while let Some(next) = queue.pop_front() {
        if pages.len() as u64 >= max_pages || Instant::now() >= deadline {
            queue.push_front(next);
            break;
        }
        if !seen.insert(next.clone()) {
            continue;
        }
        let parsed = match validate_target(&next) {
            Ok(parsed) => parsed,
            Err(error) => {
                errors.push(format!("{next}: skipped ({error})"));
                continue;
            }
        };
        if parsed.host_str() != seed.host_str() {
            continue;
        }
        let path = parsed.path().to_owned();
        if !robots_allowed(rules.as_ref(), &path) {
            errors.push(format!("{next}: disallowed by robots.txt"));
            continue;
        }
        let raw = match collector_get(&next, None, MAX_BYTES, pace_delay).await {
            Ok(raw) => raw,
            Err(error) => {
                errors.push(format!("{next}: {error}"));
                continue;
            }
        };
        visited.push(raw.final_url.clone());
        let content_type = raw.content_type.clone();
        if content_type.contains("xml") || next.ends_with(".xml") {
            let text = String::from_utf8_lossy(&raw.body).into_owned();
            let mut found = sitemap_urls(&text);
            found.sort_by_key(|u| (path_priority(u), u.clone()));
            for found_url in found {
                if queue.len() >= 500 {
                    break;
                }
                if seen.contains(&found_url) {
                    continue;
                }
                queue.push_back(found_url);
            }
            continue;
        }
        if !content_type.contains("text")
            && !content_type.contains("html")
            && !content_type.is_empty()
        {
            continue;
        }
        let text = String::from_utf8_lossy(&raw.body).into_owned();
        let page_url: url::Url = raw.final_url.parse().unwrap_or_else(|_| parsed.clone());
        let extracted = extract_page(&text);
        let mut links = extracted.links;
        links.sort_by_key(|u| (path_priority(u), u.clone()));
        for href in links {
            if queue.len() >= 500 {
                break;
            }
            let Ok(resolved) = page_url.join(&href) else {
                continue;
            };
            let link = resolved.to_string();
            let Ok(link_parsed) = validate_target(&link) else {
                continue;
            };
            if link_parsed.host_str() != seed.host_str() {
                continue;
            }
            if !robots_allowed(rules.as_ref(), link_parsed.path()) {
                continue;
            }
            if seen.contains(&link) || queue.contains(&link) {
                continue;
            }
            queue.push_back(link);
        }
        pages.push(json!({
            "url": raw.final_url,
            "text_excerpt": extracted.text.chars().take(TEXT_SLICE_CHARS).collect::<String>(),
            "body_chars": extracted.text.chars().count(),
            "truncated": raw.truncated,
        }));
    }
    let remaining: Vec<String> = queue.into_iter().take(200).collect();
    let status = if pages.is_empty() && !errors.is_empty() {
        CollectorStatus::Error
    } else if !remaining.is_empty() {
        CollectorStatus::Partial
    } else {
        CollectorStatus::Ok
    };
    let evidence = json!({
        "pages": pages,
        "errors": errors,
        "visited_urls": visited,
        "remaining_queue_urls": remaining,
    });
    let evidence_bytes = serde_json::to_vec(&evidence).unwrap_or_default();
    let seed_raw = RawResponse {
        final_url: url.into(),
        status: 200,
        content_type: String::new(),
        body: evidence_bytes,
        truncated: false,
        retry_after_secs: None,
    };
    let mut envelope = envelope("discover_site", "web", url, &seed_raw, status, evidence);
    envelope.limits = json!({"pages": max_pages, "origin": origin});
    envelope.result_count = Some(pages.len() as u64);
    if !remaining.is_empty() {
        envelope.notes.push(
            "Page cap or deadline reached; remaining queue is unexecuted frontier, not completion."
                .into(),
        );
    }
    Ok(envelope)
}

/// Relevant paths first: legal/company/product/pricing/docs before blog
/// archives and assets. Lower score crawls earlier; ties break by URL.
fn path_priority(url: &str) -> u8 {
    let lower = url.to_ascii_lowercase();
    if [
        "about",
        "company",
        "team",
        "contact",
        "legal",
        "privacy",
        "terms",
        "product",
        "pricing",
        "docs",
        "documentation",
    ]
    .iter()
    .any(|k| lower.contains(k))
    {
        0
    } else if lower.contains("blog") || lower.contains("news") || lower.contains("press") {
        1
    } else {
        2
    }
}

/// `<loc>` URLs from a sitemap or feed body. A tag scan is enough: only
/// absolute HTTP(S) entries are returned, capped for bounded queues.
fn sitemap_urls(text: &str) -> Vec<String> {
    let mut urls = Vec::new();
    for chunk in text.split("<loc>").skip(1) {
        let Some(end) = chunk.find("</loc>") else {
            continue;
        };
        let candidate = chunk[..end].trim();
        if (candidate.starts_with("https://") || candidate.starts_with("http://"))
            && candidate.len() <= 8192
        {
            urls.push(candidate.to_owned());
        }
        if urls.len() >= 500 {
            break;
        }
    }
    urls
}

/// Page text plus resolved same-scheme HTTP(S) links. Mirrors the plugin's
/// `web_extract` boundary: visible text, metadata, links with resolved
/// hrefs; no script/style/noscript content.
struct ExtractedPage {
    text: String,
    links: Vec<String>,
}

fn extract_page(html: &str) -> ExtractedPage {
    let document = scraper::Html::parse_document(html);
    let scope = ["main", "article", "[role=main]", "body"]
        .iter()
        .find_map(|selector| {
            document
                .select(&scraper::Selector::parse(selector).ok()?)
                .next()
        })
        .unwrap_or_else(|| document.root_element());
    let mut chunks = Vec::new();
    for node in scope.descendants() {
        let Some(text) = node.value().as_text() else {
            continue;
        };
        let hidden = node
            .ancestors()
            .filter_map(|n| n.value().as_element())
            .any(|e| {
                matches!(
                    e.name(),
                    "script"
                        | "style"
                        | "noscript"
                        | "template"
                        | "svg"
                        | "nav"
                        | "footer"
                        | "aside"
                        | "head"
                )
            });
        if !hidden {
            chunks.push(text.to_string());
        }
    }
    let text = chunks
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut links = Vec::new();
    if let Ok(selector) = scraper::Selector::parse("a[href]") {
        for element in document.select(&selector) {
            if let Some(href) = element.value().attr("href")
                && !href.trim().is_empty()
                && links.len() < LINK_SLICE
            {
                links.push(href.trim().to_owned());
            }
        }
    }
    ExtractedPage { text, links }
}

/// Wayback CDX lookup behind the public perimeter. Snapshot bodies are
/// retrieved only through `collector_get` on explicit follow-up.
async fn action_wayback(args: &Value) -> anyhow::Result<CollectorEnvelope> {
    let url = args.get("url").and_then(Value::as_str).unwrap_or_default();
    validate_target(url)?;
    let base = provider_base("WAYBACK", "https://web.archive.org");
    let query = format!(
        "{base}/cdx/search/cdx?url={}&output=json&limit=20&filter=statuscode:200",
        enc(url)
    );
    let raw = collector_get(&query, None, 200_000, Duration::from_secs(1)).await?;
    let text = String::from_utf8_lossy(&raw.body).into_owned();
    let parsed = if raw.status < 400 {
        strict_json(&text).unwrap_or(json!({"parse_error": "CDX response was not valid JSON"}))
    } else {
        json!({"body_excerpt": text.chars().take(2000).collect::<String>()})
    };
    let status = if blocked_status(raw.status) {
        CollectorStatus::Blocked
    } else if raw.status >= 400 || parsed.get("parse_error").is_some() {
        CollectorStatus::Error
    } else if parsed.as_array().is_some_and(|a| a.is_empty()) {
        CollectorStatus::Empty
    } else {
        CollectorStatus::Ok
    };
    let mut envelope = envelope("wayback", "Internet Archive CDX", url, &raw, status, parsed);
    envelope.limits = json!({"snapshots": 20});
    Ok(envelope)
}
async fn openfda_action(url: &str) -> anyhow::Result<CollectorEnvelope> {
    let mut envelope = json_action(
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
    args: &Value,
    contact: Option<&str>,
) -> anyhow::Result<CollectorEnvelope> {
    let cik = cik_arg(args.get("cik").and_then(Value::as_str).unwrap_or_default())?;
    let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0);
    anyhow::ensure!(offset <= 1000000, "offset must be from 0 to 1000000");
    let limit = limit_arg(args, "limit", 20, 100)?;
    let base = provider_base("SEC_DATA", "https://data.sec.gov");
    let url = format!("{base}/api/xbrl/companyfacts/CIK{cik}.json");
    let raw = collector_get(&url, contact, 20_000_000, Duration::from_secs(1)).await?;
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

async fn action_usaspending(args: &Value) -> anyhow::Result<CollectorEnvelope> {
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
        pace(&host, Duration::from_secs(1)).await;
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

#[cfg(test)]
mod tests {
    use super::*;

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
        let decimals = financial_table_snapshot(
            "Units USD millions Columns: 2025-12-31 2024-12-31 Revenue .5 .4",
        )
        .unwrap();
        assert_eq!(
            decimals["concepts"][0]["units"]["USD millions"][0]["val"],
            ".5"
        );
        assert!(
            financial_table_snapshot("Unknown units Breakdown TTM 12/31/2025 Revenue 687 624")
                .is_none()
        );
        assert!(financial_table_snapshot("Currency in USD All numbers in thousands Breakdown TTM 12/31/2025 Revenue 687 624 543").is_none(), "An extra cell must not shift the table mapping");
    }
}
