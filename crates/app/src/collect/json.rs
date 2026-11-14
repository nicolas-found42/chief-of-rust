use super::{
    CollectorEnvelope, CollectorStatus, MAX_BYTES, RawResponse, now_iso,
    transport::{Pacer, SYSTEM_PACER, collector_get_with},
};
use crate::research::{content_hash, redact_contact};
use serde_json::{Value, json};
use std::time::Duration;

pub(super) fn envelope(
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
        elapsed_ms: Some(raw.elapsed_ms),
        limits: json!({}),
        notes: Vec::new(),
        contact_redacted: false,
    }
}

pub(super) fn blocked_status(status: u16) -> bool {
    matches!(status, 401 | 403 | 429)
}

pub(super) fn strict_json(text: &str) -> anyhow::Result<Value> {
    let value: Value = serde_json::from_str(text).map_err(|error| {
        anyhow::anyhow!(
            "Provider returned an invalid JSON response: {}",
            crate::llm::error_chain(error)
        )
    })?;
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
    json_action_with(
        &SYSTEM_PACER,
        action,
        source,
        url,
        contact,
        expected_collection,
        delay,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn json_action_with(
    pacer: &Pacer,
    action: &str,
    source: &str,
    url: &str,
    contact: Option<&str>,
    expected_collection: Option<&str>,
    delay: Duration,
) -> anyhow::Result<CollectorEnvelope> {
    let raw = collector_get_with(pacer, url, contact, MAX_BYTES, delay).await?;
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

pub(super) fn apply_contact(envelope: &mut CollectorEnvelope, contact: Option<&str>) {
    let Some(contact) = contact else { return };
    let serialized = serde_json::to_string(&envelope.evidence).unwrap_or_default();
    let redacted = redact_contact(&serialized, contact);
    if redacted != serialized {
        envelope.evidence = serde_json::from_str(&redacted).unwrap_or(Value::Null);
        envelope.contact_redacted = true;
    }
}

pub(super) fn enc(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

pub(super) fn limit_arg(
    args: &Value,
    key: &str,
    default: u64,
    maximum: u64,
) -> anyhow::Result<u64> {
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

pub(super) fn required_str<'a>(args: &'a Value, key: &str) -> anyhow::Result<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty() && s.len() <= 2000)
        .ok_or_else(|| anyhow::anyhow!("{key} must be a nonempty bounded string"))
}
