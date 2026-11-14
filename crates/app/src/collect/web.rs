use super::{
    CollectorEnvelope, CollectorStatus, LINK_SLICE, MAX_BYTES, RawResponse, TEXT_SLICE_CHARS,
    json::{blocked_status, enc, envelope, strict_json},
    transport::{Pacer, collector_get_with, provider_base, validate_target},
};
use crate::research::content_hash;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

/// Parsed `/robots.txt` rules for one crawler identity. Port of the plugin's
/// Protego behavior at the boundary the app needs: per-path allow/disallow
/// longest-prefix match, `*`/`$` wildcards, crawl-delay, sitemap discovery.
/// Anything unparseable or oversized withholds crawling; only a missing
/// file (404/410) means no restrictions.
#[derive(Clone, Debug, Default)]
pub(super) struct RobotsRules {
    pub(super) disallow: Vec<String>,
    pub(super) allow: Vec<String>,
    pub(super) crawl_delay_secs: Option<f64>,
    pub(super) sitemaps: Vec<String>,
}

pub const CRAWLER_IDENTITY: &str = "chief-of-rust-terminal";
const ROBOTS_MAX_BYTES: usize = 100_000;

/// Parse robots.txt for `agent` with `*` fallback. Groups are `user-agent`
/// sections; only the first matching group (exact identity, then wildcard)
/// applies. Returns `None` when no group mentions the agent or `*`.
pub(super) fn parse_robots(text: &str, agent: &str) -> Option<RobotsRules> {
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
pub(super) fn robots_match(pattern: &str, path: &str) -> bool {
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
pub(super) fn robots_allowed(rules: Option<&RobotsRules>, path: &str) -> bool {
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

pub(super) async fn action_fetch(pacer: &Pacer, args: &Value) -> anyhow::Result<CollectorEnvelope> {
    let url = args.get("url").and_then(Value::as_str).unwrap_or_default();
    let limit = args
        .get("max_bytes")
        .and_then(Value::as_u64)
        .map(|kilobytes| (kilobytes as usize).clamp(1, MAX_BYTES / 1024) * 1024)
        .unwrap_or(MAX_BYTES);
    let raw = collector_get_with(pacer, url, None, limit, Duration::from_secs(1)).await?;
    if raw.content_type.contains("pdf") || raw.body.starts_with(b"%PDF-") {
        return action_fetch_pdf(url, args, &raw).await;
    }
    let raw_text = String::from_utf8_lossy(&raw.body).into_owned();
    let mut page_title = None;
    let mut published = None;
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
        let document = scraper::Html::parse_document(&raw_text);
        page_title = scraper::Selector::parse("title")
            .ok()
            .and_then(|s| document.select(&s).next())
            .map(|e| {
                e.text()
                    .collect::<String>()
                    .trim()
                    .chars()
                    .take(250)
                    .collect::<String>()
            });
        published = scraper::Selector::parse(
            "meta[property='article:published_time'], meta[itemprop='datePublished']",
        )
        .ok()
        .and_then(|s| document.select(&s).next())
        .and_then(|e| e.value().attr("content"))
        .and_then(|value| value.get(..10))
        .filter(|date| chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok())
        .map(str::to_owned);
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
        "page_title": page_title,
        "published": published,
        "selected_financial_table":selected_table,
        "links_omitted": true,
        "note": "single-page fetch; use discover_site for multi-page robots-gated crawls",
    });
    let status = if blocked_status(raw.status) {
        CollectorStatus::Blocked
    } else if raw.status >= 400 {
        CollectorStatus::Error
    } else if raw.truncated || selected_table || original_body_chars > TEXT_SLICE_CHARS {
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
pub(super) async fn action_discover(
    pacer: &Pacer,
    args: &Value,
) -> anyhow::Result<CollectorEnvelope> {
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
    let robots_raw = collector_get_with(
        pacer,
        &robots_url,
        None,
        ROBOTS_MAX_BYTES,
        Duration::from_secs(1),
    )
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
            elapsed_ms: 0,
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
        let raw = match collector_get_with(pacer, &next, None, MAX_BYTES, pace_delay).await {
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
        elapsed_ms: 0,
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
pub(super) fn sitemap_urls(text: &str) -> Vec<String> {
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
pub(super) struct ExtractedPage {
    pub(super) text: String,
    pub(super) links: Vec<String>,
}

pub(super) fn extract_page(html: &str) -> ExtractedPage {
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
pub(super) async fn action_wayback(
    pacer: &Pacer,
    args: &Value,
) -> anyhow::Result<CollectorEnvelope> {
    let url = args.get("url").and_then(Value::as_str).unwrap_or_default();
    validate_target(url)?;
    let base = provider_base("WAYBACK", "https://web.archive.org");
    let query = format!(
        "{base}/cdx/search/cdx?url={}&output=json&limit=20&filter=statuscode:200",
        enc(url)
    );
    let raw = collector_get_with(pacer, &query, None, 200_000, Duration::from_secs(1)).await?;
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
