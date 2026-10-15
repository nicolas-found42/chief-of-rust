//! Bounded provider clients. Credentials stay outside public Workspace config,
//! responses never leak provider bodies into user-visible failure records.
use crate::{App, web};
use axum::{
    Router,
    extract::{Query, State},
    response::Redirect,
    routing::get,
};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};

static TOKEN_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// A grant generation fences queued work across disconnects and account changes.
/// The provider subject identifies the owner; email alone is not a stable identity.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GoogleBinding {
    pub generation: u64,
    pub subject: Option<String>,
}
impl GoogleBinding {
    pub fn load(conn: &rusqlite::Connection) -> anyhow::Result<Self> {
        Ok(crate::store::get(conn, "google_connection", "current")?.unwrap_or_default())
    }
    pub fn assert_current(&self, conn: &rusqlite::Connection) -> anyhow::Result<()> {
        anyhow::ensure!(
            *self == Self::load(conn)?,
            "Google connection changed; request fresh work for the current account"
        );
        Ok(())
    }
}
tokio::task_local! {
    pub(crate) static GOOGLE_RUN_BINDING: Option<GoogleBinding>;
}
/// Capture this outside a blocking transaction, then fence its product commit
/// with `assert_current` so a disconnected import cannot publish stale records.
pub fn expected_google_binding() -> Option<GoogleBinding> {
    GOOGLE_RUN_BINDING.try_with(Clone::clone).ok().flatten()
}
pub(crate) fn uses_google(kind: &str, input: &Value) -> bool {
    matches!(
        kind,
        "meetings.calendar" | "meetings.drive" | "meetings.gmail"
    ) || (kind == "tasks.sync" && input["provider"] == "google")
        || kind == "content.trends"
}

async fn checked_token(app: &App) -> anyhow::Result<GoogleToken> {
    let expected = expected_google_binding();
    let current = app
        .db
        .transaction(move |tx| {
            if let Some(expected) = expected {
                expected.assert_current(tx)?;
            }
            GoogleBinding::load(tx)
        })
        .await?;
    let token = read_token(app).await?;
    anyhow::ensure!(
        current.subject.is_some() && token.binding == current,
        "Google connection is missing or changed; reconnect in Settings and request fresh work"
    );
    Ok(token)
}

/// Verify credentials before recording an external-write intent. A missing
/// connection cannot have created anything and must remain ordinarily retryable.
pub async fn google_preflight(app: &App) -> anyhow::Result<()> {
    let _guard = TOKEN_LOCK.lock().await;
    google_access_token(app).await?;
    Ok(())
}

fn client() -> anyhow::Result<Client> {
    Ok(Client::builder()
        .timeout(Duration::from_secs(45))
        .redirect(reqwest::redirect::Policy::none())
        .build()?)
}
async fn bounded_bytes(mut response: reqwest::Response, limit: usize) -> anyhow::Result<Vec<u8>> {
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
        anyhow::ensure!(
            bytes.len() + chunk.len() <= limit,
            "Provider response exceeds the size limit"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
async fn json_response(response: reqwest::Response) -> anyhow::Result<Value> {
    let status = response.status();
    anyhow::ensure!(
        status.is_success(),
        "Provider returned HTTP {}. Check connection, permissions, resource ID and quota.",
        status.as_u16()
    );
    let bytes = bounded_bytes(response, 4_000_000).await?;
    if bytes.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("Provider returned an invalid JSON response"))
}
fn provider_url(path: &str, service: &str) -> anyhow::Result<url::Url> {
    let url = url::Url::parse(path)?;
    anyhow::ensure!(
        url.scheme() == "https" && url.username().is_empty() && url.password().is_none(),
        "Provider URL must use HTTPS without embedded credentials"
    );
    let host = url.host_str().unwrap_or("");
    let allowed = match service {
        "google" => host == "www.googleapis.com" || host.ends_with(".googleapis.com"),
        "asana" => host == "app.asana.com",
        _ => false,
    };
    anyhow::ensure!(allowed, "URL does not belong to the selected provider");
    Ok(url)
}
async fn google_request(
    app: &App,
    method: Method,
    path: &str,
    query: &[(&str, &str)],
    body: Option<&Value>,
) -> anyhow::Result<Value> {
    let url = provider_url(path, "google")?;
    // Keep account replacement behind this finite request. The request always
    // uses the token whose owner was checked, even if disconnect is requested.
    let _guard = TOKEN_LOCK.lock().await;
    let token = google_access_token(app).await?;
    let mut request = client()?
        .request(method, url)
        .bearer_auth(token)
        .query(query);
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("Google request failed or timed out"))?;
    if query.iter().any(|(k, v)| *k == "alt" && *v == "media")
        || response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|t| t.starts_with("text/"))
    {
        anyhow::ensure!(
            response.status().is_success(),
            "Google returned HTTP {}",
            response.status().as_u16()
        );
        return Ok(Value::String(
            String::from_utf8(bounded_bytes(response, 1_000_000).await?)
                .map_err(|_| anyhow::anyhow!("Google transcript is not UTF-8 text"))?,
        ));
    }
    json_response(response).await
}
pub async fn google_get(app: &App, path: &str, query: &[(&str, &str)]) -> anyhow::Result<Value> {
    google_request(app, Method::GET, path, query, None).await
}
pub async fn google_post(app: &App, path: &str, body: &Value) -> anyhow::Result<Value> {
    google_request(app, Method::POST, path, &[], Some(body)).await
}
pub async fn google_patch(app: &App, path: &str, body: &Value) -> anyhow::Result<Value> {
    google_request(app, Method::PATCH, path, &[], Some(body)).await
}
pub async fn google_put(app: &App, path: &str, body: &Value) -> anyhow::Result<Value> {
    google_request(app, Method::PUT, path, &[], Some(body)).await
}
pub async fn google_delete(app: &App, path: &str) -> anyhow::Result<Value> {
    google_request(app, Method::DELETE, path, &[], None).await
}
async fn asana_request(
    method: Method,
    path: &str,
    query: &[(&str, &str)],
    body: Option<&Value>,
) -> anyhow::Result<Value> {
    let url = provider_url(path, "asana")?;
    let key = std::env::var("ASANA_ACCESS_TOKEN")
        .ok()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("Set ASANA_ACCESS_TOKEN in the installation environment"))?;
    let mut request = client()?.request(method, url).bearer_auth(key).query(query);
    if let Some(body) = body {
        request = request.json(body);
    }
    json_response(
        request
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Asana request failed or timed out"))?,
    )
    .await
}
pub async fn asana_get(_app: &App, path: &str, query: &[(&str, &str)]) -> anyhow::Result<Value> {
    asana_request(Method::GET, path, query, None).await
}
pub async fn asana_post(_app: &App, path: &str, body: &Value) -> anyhow::Result<Value> {
    asana_request(Method::POST, path, &[], Some(body)).await
}
pub async fn asana_put(_app: &App, path: &str, body: &Value) -> anyhow::Result<Value> {
    asana_request(Method::PUT, path, &[], Some(body)).await
}
pub async fn asana_delete(_app: &App, path: &str) -> anyhow::Result<Value> {
    asana_request(Method::DELETE, path, &[], None).await
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub content: String,
}

/// Collection facts survive model generation so a saved report can expose
/// missing engines and bounded snippets without relying on generated prose.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SearchCoverage {
    pub received: usize,
    pub invalid: usize,
    pub empty: usize,
    pub duplicates: usize,
    pub selected: usize,
    pub omitted: usize,
    pub truncated: usize,
    pub unresponsive_engines: Vec<String>,
}

#[derive(Debug)]
pub struct SearchResults {
    pub hits: Vec<SearchHit>,
    pub coverage: SearchCoverage,
}

pub async fn search(app: &App, query: &str) -> anyhow::Result<SearchResults> {
    anyhow::ensure!(
        !query.trim().is_empty() && query.len() <= 2000,
        "Search query must contain 1–2000 bytes"
    );
    match app.cfg.search_provider.as_str() {
        "searxng" => {}
        "firecrawl" => return firecrawl_search(&app.cfg, query).await,
        _ => anyhow::bail!("Unknown SEARCH_PROVIDER. Use searxng or firecrawl."),
    }
    let base = std::env::var("SEARXNG_BASE_URL").unwrap_or_else(|_| "http://127.0.0.1:8080".into());
    let url = format!("{}/search", base.trim_end_matches('/'));
    let response = client()?
        .get(url)
        .query(&[("q", query), ("format", "json"), ("pageno", "1")])
        .send()
        .await
        .map_err(|_| {
            anyhow::anyhow!("Search service is unavailable. Start SearXNG or set SEARXNG_BASE_URL.")
        })?;
    let result = json_response(response).await?;
    search_results(&result)
}

/// Firecrawl search-only results enter the same bounded evidence policy as SearXNG.
pub async fn firecrawl_search(cfg: &crate::Config, query: &str) -> anyhow::Result<SearchResults> {
    anyhow::ensure!(
        !query.trim().is_empty() && query.chars().count() <= 500,
        "Firecrawl query must contain 1–500 characters"
    );
    let key = cfg
        .firecrawl_api_key
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("Set FIRECRAWL_API_KEY to enable Firecrawl search"))?;
    let base = crate::llm::providers::endpoint(
        cfg.firecrawl_base_url
            .as_deref()
            .unwrap_or("https://api.firecrawl.dev/v2"),
    )?;
    let mut response = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none())
        .build()?
        .post(format!("{base}/search"))
        .bearer_auth(key)
        .json(&json!({"query":query,"limit":8,"sources":["web"],"domainTools":false}))
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("Firecrawl request failed or timed out"))?;
    anyhow::ensure!(
        response.status().is_success(),
        "Firecrawl returned HTTP {}. Check API key and quota.",
        response.status().as_u16()
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow::anyhow!("Firecrawl response could not be read"))?
    {
        anyhow::ensure!(
            bytes.len() + chunk.len() <= 2_000_000,
            "Firecrawl response exceeded the output limit"
        );
        bytes.extend_from_slice(&chunk);
    }
    let result: Value = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("Firecrawl returned invalid JSON"))?;
    anyhow::ensure!(result["success"] == true, "Firecrawl search failed");
    // Do not publish a complete-looking report when the provider reports partial coverage.
    anyhow::ensure!(
        result["warning"]
            .as_str()
            .is_none_or(|s| s.trim().is_empty()),
        "Firecrawl reported partial search coverage; retry before generating a report"
    );
    let web = result
        .pointer("/data/web")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("Firecrawl omitted web results"))?;
    let normalized: Vec<Value> = web
        .iter()
        .map(|hit| json!({"url":hit["url"],"title":hit["title"],"content":hit["description"]}))
        .collect();
    search_results(&json!({"results":normalized}))
}

fn search_results(result: &Value) -> anyhow::Result<SearchResults> {
    let hits = result["results"].as_array().ok_or_else(|| {
        anyhow::anyhow!("Search service returned no result list; enable JSON output in SearXNG")
    })?;
    let mut coverage = SearchCoverage {
        received: hits.len(),
        ..Default::default()
    };
    let mut seen = std::collections::HashSet::new();
    let mut selected = Vec::new();
    for hit in hits {
        let Some(mut parsed) = hit["url"]
            .as_str()
            .and_then(|s| url::Url::parse(s).ok())
            .filter(|u| {
                matches!(u.scheme(), "http" | "https")
                    && u.username().is_empty()
                    && u.password().is_none()
                    && u.host().is_some_and(|h| match h {
                        url::Host::Domain(host) => {
                            host != "localhost"
                                && !host.ends_with(".localhost")
                                && !host.ends_with(".local")
                        }
                        url::Host::Ipv4(ip) => public_ip(IpAddr::V4(ip)),
                        url::Host::Ipv6(ip) => public_ip(IpAddr::V6(ip)),
                    })
            })
        else {
            coverage.invalid += 1;
            continue;
        };
        let content = hit["content"].as_str().unwrap_or("").trim();
        if content.is_empty() {
            coverage.empty += 1;
            continue;
        }
        // Source lineage in #11 depends on distinct documents (teardown F1).
        // Fragment variants identify the same retrieved document. Keep query
        // parameters: dropping them could merge distinct articles or searches.
        parsed.set_fragment(None);
        if !seen.insert(parsed.to_string()) {
            coverage.duplicates += 1;
            continue;
        }
        if selected.len() == 8 {
            coverage.omitted += 1;
            continue;
        }
        coverage.truncated += usize::from(content.chars().count() > 6000);
        selected.push(SearchHit {
            title: hit["title"]
                .as_str()
                .unwrap_or("Source")
                .chars()
                .take(500)
                .collect(),
            url: parsed.to_string(),
            content: content.chars().take(6000).collect(),
        });
    }
    coverage.selected = selected.len();
    // Keep #11's source evidence inspectable without exposing diagnostic bodies
    // (teardown F3); only bounded
    // engine names are useful to explain search coverage to the operator.
    coverage.unresponsive_engines = result["unresponsive_engines"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| e.get(0).and_then(Value::as_str))
        .take(40)
        .map(|s| s.chars().take(100).collect())
        .collect();
    Ok(SearchResults {
        hits: selected,
        coverage,
    })
}

#[cfg(test)]
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
/// DNS answers are checked and pinned for every redirect so a public source
/// cannot use rebinding or an HTTP redirect to reach local services.
pub async fn fetch_public(input: &str) -> anyhow::Result<String> {
    let mut url = url::Url::parse(input).map_err(|_| anyhow::anyhow!("Source URL is invalid"))?;
    for _ in 0..4 {
        anyhow::ensure!(
            matches!(url.scheme(), "https" | "http")
                && url.username().is_empty()
                && url.password().is_none(),
            "Public sources must use HTTP(S) without credentials"
        );
        let host = url
            .host_str()
            .ok_or_else(|| anyhow::anyhow!("Source URL has no host"))?
            .to_owned();
        let port = url.port_or_known_default().unwrap_or(443);
        anyhow::ensure!(
            matches!(port, 80 | 443),
            "Public sources must use port 80 or 443"
        );
        let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
            .await
            .map_err(|_| anyhow::anyhow!("Source DNS lookup failed"))?
            .collect();
        anyhow::ensure!(
            !addresses.is_empty() && addresses.iter().all(|a| public_ip(a.ip())),
            "Local, private and reserved network sources are not allowed"
        );
        let http = Client::builder()
            // #11's bounded public-source path must use the checked address
            // (teardown F4). Proxies resolve the destination themselves, bypassing the
            // checked DNS answers below. Public collection must connect direct.
            .no_proxy()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .resolve_to_addrs(&host, &addresses)
            .build()?;
        let response = http
            .get(url.clone())
            .header("User-Agent", "Found42-Chief-of-Staff/0.1")
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Public source request failed or timed out"))?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| anyhow::anyhow!("Source redirect has no valid location"))?;
            url = url.join(location)?;
            continue;
        }
        anyhow::ensure!(
            response.status().is_success(),
            "Public source returned HTTP {}",
            response.status().as_u16()
        );
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned();
        anyhow::ensure!(
            content_type.contains("text/")
                || content_type.contains("xml")
                || content_type.contains("json"),
            "Source is not readable text. Attach an attributed text excerpt instead."
        );
        let bytes = bounded_bytes(response, 2_000_000).await?;
        let text = String::from_utf8_lossy(&bytes);
        let text = if content_type.contains("html") {
            let document = scraper::Html::parse_document(&text);
            document
                .tree
                .nodes()
                .filter_map(|node| {
                    let text = node.value().as_text()?;
                    let hidden = node
                        .ancestors()
                        .filter_map(|n| n.value().as_element())
                        .any(|e| {
                            matches!(
                                e.name(),
                                "script" | "style" | "noscript" | "template" | "svg"
                            )
                        });
                    (!hidden).then(|| text.to_string())
                })
                .collect::<Vec<_>>()
                .join(" ")
        } else {
            text.into_owned()
        };
        return Ok(text.chars().take(40_000).collect());
    }
    anyhow::bail!("Public source redirected too many times")
}

pub async fn youtube_channel(app: &App, id: &str) -> anyhow::Result<Value> {
    let api_key = std::env::var("YOUTUBE_API_KEY")
        .ok()
        .filter(|k| !k.is_empty());
    async fn get(
        app: &App,
        key: Option<&str>,
        endpoint: &str,
        params: &[(&str, &str)],
    ) -> anyhow::Result<Value> {
        let path = format!("https://www.googleapis.com/youtube/v3/{endpoint}");
        if let Some(key) = key {
            let mut query = params.to_vec();
            query.push(("key", key));
            json_response(
                client()?
                    .get(path)
                    .query(&query)
                    .send()
                    .await
                    .map_err(|_| anyhow::anyhow!("YouTube request failed"))?,
            )
            .await
        } else {
            google_get(app, &path, params).await
        }
    }
    let channel = get(
        app,
        api_key.as_deref(),
        "channels",
        &[("part", "snippet,statistics,contentDetails"), ("id", id)],
    )
    .await?;
    let item = channel["items"]
        .as_array()
        .and_then(|items| items.first())
        .ok_or_else(|| anyhow::anyhow!("YouTube channel not found; use its UC channel ID"))?;
    let playlist = item
        .pointer("/contentDetails/relatedPlaylists/uploads")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("Channel has no uploads playlist"))?;
    let uploads = get(
        app,
        api_key.as_deref(),
        "playlistItems",
        &[
            ("part", "contentDetails"),
            ("playlistId", playlist),
            ("maxResults", "25"),
        ],
    )
    .await?;
    let ids = uploads["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.pointer("/contentDetails/videoId").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(",");
    let mut videos = Vec::new();
    if !ids.is_empty() {
        let stats = get(
            app,
            api_key.as_deref(),
            "videos",
            &[("part", "snippet,statistics"), ("id", &ids)],
        )
        .await?;
        for video in stats["items"].as_array().into_iter().flatten() {
            videos.push(json!({"id":video["id"],"title":video.pointer("/snippet/title"),"views":video.pointer("/statistics/viewCount").and_then(Value::as_str).and_then(|s|s.parse::<u64>().ok()).unwrap_or(0),"published_at":video.pointer("/snippet/publishedAt")}));
        }
    }
    Ok(
        json!({"channel_id":id,"title":item.pointer("/snippet/title"),"video_count":item.pointer("/statistics/videoCount"),"view_count":item.pointer("/statistics/viewCount"),"videos":videos,"coverage":"latest 25 public uploads","failed_ids":[]}),
    )
}

#[derive(Clone, Serialize, Deserialize)]
struct GoogleToken {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: i64,
    email: String,
    #[serde(default)]
    binding: GoogleBinding,
}
#[derive(Serialize, Deserialize)]
struct OAuthState {
    expires_at: i64,
    #[serde(default)]
    binding: GoogleBinding,
}
#[derive(Clone)]
struct GoogleClient {
    id: String,
    secret: String,
}
async fn google_client(app: &App) -> anyhow::Result<GoogleClient> {
    if let (Ok(id), Ok(secret)) = (
        std::env::var("GOOGLE_CLIENT_ID"),
        std::env::var("GOOGLE_CLIENT_SECRET"),
    ) && !id.is_empty()
        && !secret.is_empty()
    {
        return Ok(GoogleClient { id, secret });
    }
    let path = app.cfg.google_secret_path.as_ref().ok_or_else(|| {
        anyhow::anyhow!(
            "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or GOOGLE_CLIENT_SECRET_PATH"
        )
    })?;
    let value: Value = serde_json::from_slice(&tokio::fs::read(path).await?)?;
    let value = value
        .get("web")
        .or_else(|| value.get("installed"))
        .unwrap_or(&value);
    Ok(GoogleClient {
        id: value["client_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Google client ID missing"))?
            .into(),
        secret: value["client_secret"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Google client secret missing"))?
            .into(),
    })
}
async fn read_token(app: &App) -> anyhow::Result<GoogleToken> {
    serde_json::from_slice(
        &tokio::fs::read(&app.cfg.google_token_path)
            .await
            .map_err(|_| anyhow::anyhow!("Google is not connected. Connect in Settings."))?,
    )
    .map_err(|_| anyhow::anyhow!("Google token cache is invalid; reconnect in Settings"))
}
async fn write_token(app: &App, token: &GoogleToken) -> anyhow::Result<()> {
    let path = app.cfg.google_token_path.clone();
    let bytes = serde_json::to_vec(token)?;
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let dir = path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("Token path needs a directory"))?;
        std::fs::create_dir_all(dir)?;
        let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        use std::io::Write;
        file.write_all(&bytes)?;
        file.sync_all()?;
        std::fs::rename(temp, path)?;
        Ok(())
    })
    .await??;
    Ok(())
}
async fn google_access_token(app: &App) -> anyhow::Result<String> {
    let mut token = checked_token(app).await?;
    if token.expires_at > crate::now_ms() + 60_000 {
        return Ok(token.access_token);
    }
    let client_config = google_client(app).await?;
    let refresh = token
        .refresh_token
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("Google connection expired. Reconnect in Settings."))?;
    let value = json_response(
        client()?
            .post("https://oauth2.googleapis.com/token")
            .form(&[
                ("client_id", client_config.id.as_str()),
                ("client_secret", client_config.secret.as_str()),
                ("refresh_token", refresh),
                ("grant_type", "refresh_token"),
            ])
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Google token refresh failed"))?,
    )
    .await?;
    token.access_token = value["access_token"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Google did not return an access token"))?
        .into();
    token.expires_at = crate::now_ms() + value["expires_in"].as_i64().unwrap_or(3600) * 1000;
    let binding = token.binding.clone();
    app.db
        .transaction(move |tx| binding.assert_current(tx))
        .await?;
    write_token(app, &token).await?;
    Ok(token.access_token)
}
pub async fn google_status(app: &App) -> String {
    match checked_token(app).await {
        Ok(t) => format!("Connected as {}", t.email),
        Err(_) => {
            if google_client(app).await.is_ok() {
                "Configured; connect your account".into()
            } else {
                "Not configured".into()
            }
        }
    }
}
pub fn router() -> Router<App> {
    Router::new()
        .route("/google/connect", get(connect))
        .route("/google/callback", get(callback))
        .route("/google/disconnect", axum::routing::post(disconnect))
}
fn redirect_uri(app: &App) -> String {
    format!("http://localhost:{}/google/callback", app.cfg.port)
}
async fn connect(State(app): State<App>) -> web::Result<Redirect> {
    let config = google_client(&app).await?;
    let state = uuid::Uuid::new_v4().to_string();
    let _guard = TOKEN_LOCK.lock().await;
    let state_id = state.clone();
    app.db
        .transaction(move |tx| {
            let record = OAuthState {
                expires_at: crate::now_ms() + 600_000,
                binding: GoogleBinding::load(tx)?,
            };
            crate::store::put(tx, "oauth_state", &state_id, &record)
        })
        .await?;
    let mut url =
        url::Url::parse("https://accounts.google.com/o/oauth2/v2/auth").expect("Google URL");
    url.query_pairs_mut().extend_pairs(&[("client_id",config.id.as_str()),("redirect_uri",redirect_uri(&app).as_str()),("response_type","code"),("access_type","offline"),("prompt","consent"),("state",state.as_str()),("scope","openid email https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/tasks https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/youtube.readonly")]);
    Ok(Redirect::to(url.as_str()))
}
#[derive(Deserialize)]
struct Callback {
    state: Option<String>,
    code: Option<String>,
    error: Option<String>,
}
async fn callback(State(app): State<App>, Query(query): Query<Callback>) -> web::Result<Redirect> {
    let state = query.state.ok_or_else(|| {
        web::Error::bad_request("Google sign-in state is missing. Start again from Settings.")
    })?;
    let binding = app
        .db
        .transaction(move |tx| {
            let state_record = crate::store::get::<OAuthState>(tx, "oauth_state", &state)?;
            crate::store::purge(tx, "oauth_state", &state)?;
            Ok(state_record
                .filter(|s| s.expires_at > crate::now_ms())
                .filter(|s| GoogleBinding::load(tx).is_ok_and(|current| current == s.binding))
                .map(|s| s.binding))
        })
        .await?;
    let binding = binding.ok_or_else(|| {
        web::Error::bad_request(
            "Google sign-in state is expired or already used. Start again from Settings.",
        )
    })?;
    if query.error.is_some() {
        return Err(web::Error::bad_request(
            "Google sign-in was cancelled. No connection was saved.",
        ));
    }
    let code = query
        .code
        .ok_or_else(|| web::Error::bad_request("Google did not return a sign-in code"))?;
    let config = google_client(&app).await?;
    let value = json_response(
        client()?
            .post("https://oauth2.googleapis.com/token")
            .form(&[
                ("client_id", config.id.as_str()),
                ("client_secret", config.secret.as_str()),
                ("code", code.as_str()),
                ("redirect_uri", redirect_uri(&app).as_str()),
                ("grant_type", "authorization_code"),
            ])
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Google authorization exchange failed"))?,
    )
    .await?;
    let access = value["access_token"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Google access token missing"))?;
    let identity = json_response(
        client()?
            .get("https://www.googleapis.com/oauth2/v2/userinfo")
            .bearer_auth(access)
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Google identity lookup failed"))?,
    )
    .await?;
    let next_binding = GoogleBinding {
        generation: binding
            .generation
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("Google connection generation exhausted"))?,
        subject: Some(
            identity["id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| anyhow::anyhow!("Google account subject missing"))?
                .into(),
        ),
    };
    let token = GoogleToken {
        access_token: access.into(),
        refresh_token: value["refresh_token"].as_str().map(ToOwned::to_owned),
        expires_at: crate::now_ms() + value["expires_in"].as_i64().unwrap_or(3600) * 1000,
        email: identity["email"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Google account email missing"))?
            .into(),
        binding: next_binding.clone(),
    };
    install_google_token(&app, binding, token).await?;
    Ok(Redirect::to("/settings"))
}
// An exchange may finish after disconnect or another sign-in. Its saved
// starting generation must still own the connection before any cache is written.
async fn install_google_token(
    app: &App,
    binding: GoogleBinding,
    token: GoogleToken,
) -> anyhow::Result<()> {
    let next_binding = token.binding.clone();
    let _guard = TOKEN_LOCK.lock().await;
    let old_binding = binding.clone();
    app.db
        .transaction(move |tx| old_binding.assert_current(tx))
        .await?;
    write_token(app, &token).await?;
    app.db
        .transaction(move |tx| {
            binding.assert_current(tx)?;
            crate::store::put(tx, "google_connection", "current", &next_binding)?;
            tx.execute("DELETE FROM record WHERE kind='oauth_state'", [])?;
            tx.execute("DELETE FROM revision WHERE kind='oauth_state'", [])?;
            Ok(())
        })
        .await?;
    Ok(())
}
async fn disconnect(State(app): State<App>) -> web::Result<Redirect> {
    let _guard = TOKEN_LOCK.lock().await;
    app.db
        .transaction(move |tx| {
            let current = GoogleBinding::load(tx)?;
            let next = GoogleBinding {
                generation: current
                    .generation
                    .checked_add(1)
                    .ok_or_else(|| anyhow::anyhow!("Google connection generation exhausted"))?,
                subject: None,
            };
            crate::store::put(tx, "google_connection", "current", &next)?;
            tx.execute("DELETE FROM record WHERE kind='oauth_state'", [])?;
            tx.execute("DELETE FROM revision WHERE kind='oauth_state'", [])?;
            Ok(())
        })
        .await?;
    // The user asked to disconnect this one credential cache; avoid traversing
    // or clearing any Workspace path and never revoke someone else's session.
    let path = app.cfg.google_token_path.clone();
    match tokio::fs::remove_file(path).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(anyhow::Error::new(e).into()),
    }
    Ok(Redirect::to("/settings"))
}
/// Creates one draft to the connected owner; there is deliberately no send API.
pub async fn gmail_draft(app: &App, subject: &str, body: &str) -> anyhow::Result<Value> {
    use base64::{
        Engine,
        engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    };
    let owner = checked_token(app).await?.email;
    anyhow::ensure!(
        owner.contains('@') && !owner.contains(['\r', '\n', '<', '>']),
        "Connected Google email is invalid"
    );
    anyhow::ensure!(
        subject.len() <= 1000 && body.len() <= 200_000,
        "Draft exceeds the size limit"
    );
    let mime = format!(
        "To: {owner}\r\nSubject: =?UTF-8?B?{}?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n",
        STANDARD.encode(subject),
        STANDARD.encode(body)
    );
    google_post(
        app,
        "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
        &json!({"message":{"raw":URL_SAFE_NO_PAD.encode(mime)}}),
    )
    .await
}
pub async fn hubspot_contacts(_app: &App, emails: &[String]) -> anyhow::Result<Value> {
    let token = std::env::var("HUBSPOT_ACCESS_TOKEN")
        .ok()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("Set HUBSPOT_ACCESS_TOKEN to enable CRM enrichment"))?;
    anyhow::ensure!(
        !emails.is_empty() && emails.len() <= 50,
        "CRM enrichment requires 1–50 exact email addresses"
    );
    json_response(client()?.post("https://api.hubapi.com/crm/v3/objects/contacts/search").bearer_auth(token).json(&json!({"filterGroups":[{"filters":[{"propertyName":"email","operator":"IN","values":emails}]}],"properties":["email","firstname","lastname","jobtitle","company"],"limit":100})).send().await.map_err(|_|anyhow::anyhow!("HubSpot request failed or timed out"))?).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn late_oauth_exchange_cannot_restore_a_disconnected_token() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = crate::Config::for_workspace(dir.path().to_path_buf());
        let app = App {
            judge: crate::judgments::from_config(&cfg),
            db: crate::db::Db::open(&cfg.db_path()).unwrap(),
            llm: crate::llm::from_config(&cfg),
            cfg,
        };
        let starting = GoogleBinding::default();
        let disconnected = GoogleBinding {
            generation: 1,
            subject: None,
        };
        app.db
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
        assert!(!app.cfg.google_token_path.exists());
        assert_eq!(
            app.db
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
    #[test]
    fn provider_credentials_only_go_to_provider_hosts() {
        assert!(provider_url("https://www.googleapis.com/calendar/v3/calendars", "google").is_ok());
        for url in [
            "https://googleapis.com.evil.test/",
            "http://www.googleapis.com/",
            "https://user:secret@www.googleapis.com/",
        ] {
            assert!(provider_url(url, "google").is_err());
        }
    }
}
