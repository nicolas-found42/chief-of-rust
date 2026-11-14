use super::{MAX_REDIRECTS, RawResponse, TIMEOUT_SECS};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::{Duration, Instant},
};

/// Operator-configured provider base URL, when set. `None` means the caller's
/// production default applies.
pub fn optional_provider_base(env_key: &str) -> Option<String> {
    let name = format!("CHIEF_COLLECT_{env_key}_BASE");
    std::env::var(&name)
        .ok()
        .map(|v| v.trim().trim_end_matches('/').to_owned())
        .filter(|v| !v.is_empty())
}

/// Operator-configured provider base URL, or the production default. The same
/// seam as `SEARXNG_BASE_URL`: tests point providers at wiremock.
pub fn provider_base(env_key: &str, default: &str) -> String {
    optional_provider_base(env_key).unwrap_or_else(|| default.to_owned())
}

/// The provider endpoint override key behind one collector action, when the
/// action talks to a fixed provider base. Actions that crawl caller-supplied
/// URLs (`fetch_url`, `discover_site`) have no provider base and are never
/// unconfigured: they run wherever the URL validates.
pub(super) fn collector_env_key(action: &str) -> Option<&'static str> {
    match action {
        "sec_tickers" => Some("SEC_WWW"),
        "sec_submissions" | "sec_companyfacts" | "sec_companyconcept" => Some("SEC_DATA"),
        "gleif_search" => Some("GLEIF"),
        "wikidata_search" | "wikidata_entity" => Some("WIKIDATA"),
        "rdap" => Some("RDAP"),
        "dns" => Some("DNS"),
        "crtsh" => Some("CRTSH"),
        "github_search" => Some("GITHUB"),
        "hackernews_search" => Some("HACKERNEWS"),
        "stackexchange_search" => Some("STACKEXCHANGE"),
        "gdelt_news" => Some("GDELT"),
        "lever_jobs" => Some("LEVER"),
        "greenhouse_jobs" | "greenhouse_job" => Some("GREENHOUSE"),
        "crossref_search" => Some("CROSSREF"),
        "europepmc_search" => Some("EUROPEPMC"),
        "clinicaltrials_search" => Some("CLINICALTRIALS"),
        "openfda_search" => Some("OPENFDA"),
        "ror_search" => Some("ROR"),
        "usaspending_search" => Some("USASPENDING"),
        "wayback" => Some("WAYBACK"),
        _ => None,
    }
}

/// The prerequisite boundary for one collector action before any request
/// runs. The approved Terminal contact rule (#30): a missing operator
/// contact blocks only collectors that declare the contact requirement, and
/// unrelated collection proceeds. An explicitly blanked provider base
/// disables that Source without failing the Run. Everything else is
/// mandatory: its failure fails the Run.
pub fn collector_requirement(
    action: &str,
    contact: Option<&str>,
) -> crate::sources::SourceRequirement {
    use crate::sources::SourceRequirement;
    if crate::research::CONTACT_ACTIONS.contains(&action) && contact.is_none() {
        return SourceRequirement::BlockedMissingContact;
    }
    if let Some(key) = collector_env_key(action)
        && std::env::var(format!("CHIEF_COLLECT_{key}_BASE")).is_ok_and(|v| v.trim().is_empty())
    {
        return SourceRequirement::NotConfigured;
    }
    SourceRequirement::Mandatory
}

fn configured_bases() -> Vec<String> {
    std::env::vars()
        .filter(|(k, _)| k.starts_with("CHIEF_COLLECT_") && k.ends_with("_BASE"))
        .map(|(_, v)| v.trim_end_matches('/').to_owned())
        .collect()
}

pub(super) fn is_loopback_host(host: &str) -> bool {
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

pub(super) async fn pinned_addresses(host: &str, port: u16) -> anyhow::Result<Vec<SocketAddr>> {
    let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| {
            anyhow::anyhow!(
                "Source DNS lookup failed; no unchecked address was used: {}",
                crate::llm::error_chain(error)
            )
        })?
        .collect();
    anyhow::ensure!(
        !addresses.is_empty() && addresses.iter().all(|a| public_ip(a.ip())),
        "Local, private and reserved network sources are not allowed"
    );
    Ok(addresses)
}

/// Time source used by [`Pacer`]. Production uses wall time; tests inject a
/// clock that records the requested waits and returns immediately, so a
/// rate-limit test asserts the pacing decision without spending the delay.
#[async_trait::async_trait]
pub trait Clock: Send + Sync {
    fn now(&self) -> Instant;
    async fn sleep(&self, wait: Duration);
}

/// Wall-clock time and real sleeps. The only implementation used in product
/// paths.
pub struct SystemClock;

#[async_trait::async_trait]
impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
    async fn sleep(&self, wait: Duration) {
        tokio::time::sleep(wait).await;
    }
}

/// Per-host request pacing and explicit retry waits. Owned per caller rather
/// than process-global so tests never share a rate-limit gate, and keyed by
/// origin (scheme, host and port) so two loopback mock servers on different
/// ports do not block each other.
pub struct Pacer {
    clock: Arc<dyn Clock>,
    last: tokio::sync::Mutex<HashMap<String, Instant>>,
}

impl Pacer {
    /// The pacer every product request path uses, on the wall clock.
    pub fn system() -> Self {
        Self::with_clock(Arc::new(SystemClock))
    }

    /// A pacer on a caller-supplied clock: the seam a test uses to record the
    /// waits a rate-limited path asks for, without spending them.
    pub fn with_clock(clock: Arc<dyn Clock>) -> Self {
        Self {
            clock,
            last: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    /// Wait out the remaining `delay` for `origin`. The deadline advances
    /// under the lock before any sleeping, so a caller that arrives while
    /// another caller waits still waits instead of slipping through unspaced.
    /// A burst therefore wakes together: this spaces requests from the gate's
    /// start, it does not queue callers a full delay apart.
    pub async fn pace(&self, origin: &str, delay: Duration) {
        let wait = {
            let mut pacing = self.last.lock().await;
            let now = self.clock.now();
            let wait = pacing
                .get(origin)
                .and_then(|last| delay.checked_sub(now.duration_since(*last)))
                .unwrap_or_default();
            pacing.insert(origin.to_owned(), now + wait);
            wait
        };
        if !wait.is_zero() {
            self.clock.sleep(wait).await;
        }
    }

    /// Honour an explicit provider retry delay. Zero is a real instruction
    /// ("retry now") and is still recorded by a test clock.
    pub async fn sleep(&self, wait: Duration) {
        self.clock.sleep(wait).await;
    }
}

/// Process-wide pacing for product requests. One map per process matches one
/// set of provider credentials per process.
pub(super) static SYSTEM_PACER: std::sync::LazyLock<Pacer> =
    std::sync::LazyLock::new(Pacer::system);

/// Origin key for pacing: two mock servers on `127.0.0.1` with different ports
/// are different providers and must not share a gate.
pub(super) fn pace_key(url: &url::Url) -> String {
    format!(
        "{}://{}:{}",
        url.scheme(),
        url.host_str().unwrap_or_default(),
        url.port_or_known_default().unwrap_or(443)
    )
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

pub(super) async fn bounded_body(
    mut response: reqwest::Response,
    limit: usize,
) -> anyhow::Result<(Vec<u8>, bool)> {
    anyhow::ensure!(
        response.content_length().is_none_or(|n| n <= limit as u64),
        "Provider response exceeds the size limit"
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        anyhow::anyhow!(
            "Provider response interrupted: {}",
            crate::llm::error_chain(error)
        )
    })? {
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
    collector_get_with(&SYSTEM_PACER, url, contact, limit, delay).await
}

/// Pacing-injectable form of [`collector_get`]. Tests pass their own [`Pacer`]
/// so rate-limit gates stay in the test rather than in a shared process map.
pub async fn collector_get_with(
    pacer: &Pacer,
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
        pacer.pace(&pace_key(&parsed), delay).await;
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
        let started = std::time::Instant::now();
        let response = request.send().await.map_err(|error| {
            anyhow::anyhow!(
                "Provider request failed or timed out: {}",
                crate::llm::error_chain(error)
            )
        })?;
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
        let elapsed_ms = started.elapsed().as_millis() as u64;
        return Ok(RawResponse {
            final_url: current,
            status,
            content_type,
            body,
            truncated,
            retry_after_secs,
            elapsed_ms,
        });
    }
    anyhow::bail!("Source redirected too many times")
}
