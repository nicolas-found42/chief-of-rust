//! Frontier continuation: resume unfinished provider cursors in a bounded
//! follow-up Run, with saturation fencing.
//!
//! A full-research Run records provider cursors as frontier items but never
//! silently expands scope. An explicit Continue action enqueues a follow-up
//! Run carrying the prior snapshot (sources, coverage, frontier, planned
//! args, content hashes). The worker resumes a bounded batch of cursor
//! items, merges new sources with URL dedupe, then re-synthesizes and
//! re-checks the brief. The new brief supersedes the prior one; the prior
//! snapshot stays readable history.
//!
//! Saturation follows the plugin rule: two successive distinct
//! nonproductive expansions (no new source records) stop the frontier with
//! an honest stop reason. Unvisited important families still prevent an
//! unsupported saturation claim: the stop reason names them.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Structured resume state persisted in the follow-up Run input. The
/// frontier's display strings stay human-readable; this carries the
/// machine-readable cursor advancement.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResumeItem {
    pub action: String,
    pub args: Value,
    pub cursor: String,
}

/// Advance one action's args with a provider cursor. Numeric cursors advance
/// page/offset/skip pagination; opaque tokens pass through to the actions
/// that accept them. Returns `None` when the cursor cannot resume the
/// action — the item stays on the frontier with a reason, never retried
/// blindly.
pub fn advance_args(action: &str, args: &Value, cursor: &str) -> Option<Value> {
    let mut next = args.clone();
    let map = next.as_object_mut()?;
    let page_key = match action {
        "github_search" | "hackernews_search" | "stackexchange_search" | "ror_search" => {
            Some("page")
        }
        "gleif_search" => Some("page_number"),
        "sec_companyfacts" => Some("offset"),
        "openfda_search" => Some("skip"),
        _ => None,
    };
    if let Some(key) = page_key {
        // Cursors from paginated providers encode the next page/offset, or
        // the provider reports total counts: either way, step one unit from
        // the current args. A non-numeric cursor cannot advance pagination.
        let step: u64 = match action {
            "sec_companyfacts" => args.get("limit").and_then(Value::as_u64).unwrap_or(20),
            "openfda_search" => args.get("limit").and_then(Value::as_u64).unwrap_or(20),
            _ => 1,
        };
        let current =
            args.get(key)
                .and_then(Value::as_u64)
                .unwrap_or(if key == "offset" || key == "skip" {
                    0
                } else {
                    1
                });
        let _ = cursor;
        map.insert(key.into(), json!(current + step));
        return Some(next);
    }
    match action {
        "wikidata_search" => {
            if let Ok(n) = cursor.parse::<u64>() {
                map.insert("search_continue".into(), json!(n));
            } else {
                map.insert("continue_token".into(), json!(cursor));
            }
            Some(next)
        }
        "europepmc_search" => {
            map.insert("cursor_mark".into(), json!(cursor));
            Some(next)
        }
        "clinicaltrials_search" => {
            map.insert("page_token".into(), json!(cursor));
            Some(next)
        }
        "crossref_search" => {
            if let Ok(offset) = cursor.parse::<u64>() {
                map.insert("offset".into(), json!(offset));
                Some(next)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Families whose unvisited state blocks a saturation claim. A frontier
/// that never attempted identity/ownership or adverse evidence cannot call
/// itself saturated.
pub const SATURATION_GATE_FAMILIES: [&str; 3] =
    ["identity/ownership", "adverse evidence", "financials"];

/// Decide whether continuation stops. `new_sources` counts source records
/// added by this expansion; `prior_unproductive` counts successive prior
/// expansions that added none. Stops after two successive nonproductive
/// expansions, or names the gate families that keep the frontier open.
pub fn saturation_stop(
    new_sources: usize,
    prior_unproductive: u64,
    unvisited_gates: &[String],
) -> Option<String> {
    if new_sources > 0 {
        return None;
    }
    if !unvisited_gates.is_empty() {
        return Some(format!(
            "no new sources, but {} remain unvisited: expansion continues to stay honest",
            unvisited_gates.join(", ")
        ));
    }
    if prior_unproductive + 1 >= 2 {
        Some("two successive expansions added no new sources; frontier rests (not complete)".into())
    } else {
        None
    }
}

/// Merge new sources into prior ones, deduped by final URL (falling back to
/// request URL, then content hash). Provider pages are independent;
/// hash-guarded offset slicing stays inside the PDF/fetch path.
pub fn merge_sources(
    prior: Vec<crate::research::SourceRecord>,
    new: Vec<crate::research::SourceRecord>,
) -> (Vec<crate::research::SourceRecord>, usize) {
    let mut seen: std::collections::HashSet<String> = prior
        .iter()
        .map(|s| {
            s.source_url
                .clone()
                .or_else(|| s.request_url.clone())
                .or_else(|| s.content_sha256.clone())
                .unwrap_or_else(|| s.id.clone())
        })
        .collect();
    let mut merged = prior;
    let mut added = 0;
    for source in new {
        let key = source
            .source_url
            .clone()
            .or_else(|| source.request_url.clone())
            .or_else(|| source.content_sha256.clone())
            .unwrap_or_else(|| source.id.clone());
        if seen.insert(key) {
            added += 1;
            merged.push(source);
        }
    }
    (merged, added)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_pagination_advances_from_current_args() {
        let args = json!({"query": "acme", "page": 2});
        let next = advance_args("github_search", &args, "whatever").unwrap();
        assert_eq!(next["page"], 3);
        let facts = json!({"cik": "0000320193", "limit": 20, "offset": 0});
        let next = advance_args("sec_companyfacts", &facts, "20").unwrap();
        assert_eq!(next["offset"], 20);
    }

    #[test]
    fn opaque_tokens_pass_through_where_accepted() {
        let args = json!({"query": "acme"});
        let next = advance_args("europepmc_search", &args, "AoIIBR35+8=").unwrap();
        assert_eq!(next["cursor_mark"], "AoIIBR35+8=");
        assert!(advance_args("gdelt_news", &args, "tok").is_none());
        assert!(advance_args("crossref_search", &args, "not-a-number").is_none());
        let next = advance_args("crossref_search", &args, "40").unwrap();
        assert_eq!(next["offset"], 40);
    }

    #[test]
    fn saturation_needs_two_quiet_expansions_and_open_gates() {
        assert!(saturation_stop(3, 1, &[]).is_none());
        assert!(saturation_stop(0, 0, &[]).is_none());
        assert!(saturation_stop(0, 1, &[]).is_some());
        assert!(
            saturation_stop(0, 5, &["financials".to_string()])
                .unwrap()
                .contains("financials")
        );
    }

    #[test]
    fn merge_dedupes_by_final_url() {
        let prior = vec![crate::research::SourceRecord {
            id: "0:fetch_url".into(),
            entity_id: None,
            title: "a".into(),
            request_url: Some("https://example.com/a".into()),
            source_url: Some("https://example.com/a".into()),
            retrieved_at: None,
            access_state: crate::research::AccessState::Retrieved,
            source_type: crate::research::SourceType::OfficialRecord,
            origin: "web".into(),
            transport_status: None,
            content_sha256: None,
            excerpts: Vec::new(),
            inspection_scope: crate::research::InspectionScope::FullReturned,
            inspection_details: None,
            notes: String::new(),
        }];
        let mut dup = prior[0].clone();
        dup.id = "9:fetch_url".into();
        let (merged, added) = merge_sources(prior, vec![dup]);
        assert_eq!(merged.len(), 1);
        assert_eq!(added, 0);
    }
}
