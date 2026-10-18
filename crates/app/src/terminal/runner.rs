//! Shared research runner primitives.
//!
//! The company, person, and automatic research runners keep their
//! subject-specific planned actions, brief types, and synthesis prompts.
//! Collection accounting and excerpt shaping live here so coverage semantics
//! cannot diverge between them: every collector invocation records its source
//! record and coverage row through the same path.

use crate::App;
use serde_json::Value;

#[allow(clippy::too_many_arguments)]
pub(crate) fn coverage_row(
    family: &str,
    question: &str,
    state: crate::research::CoverageState,
    boundary: String,
    query: Option<String>,
    retrieved_count: Option<u64>,
    total_count: Option<u64>,
    stop_reason: Option<String>,
    remaining: Vec<String>,
) -> crate::research::CoverageRow {
    crate::research::CoverageRow {
        family: family.into(),
        question: question.into(),
        state,
        applicability: String::new(),
        query,
        boundary,
        source_ids: Vec::new(),
        claim_ids: Vec::new(),
        retrieved_count,
        total_count,
        inspected_count: retrieved_count,
        remaining,
        stop_reason,
    }
}

pub(crate) fn collected_excerpts(
    action: &str,
    evidence: &Value,
    final_url: Option<&str>,
) -> Vec<crate::research::SourceExcerpt> {
    let mut excerpts = Vec::new();
    if action == "sec_submissions"
        && let Some(fields) = evidence.as_object()
    {
        // Filing arrays can sort before name/ticker/website. Preserve original
        // identity fields separately, before any bounded filing excerpt.
        let metadata = [
            "cik",
            "name",
            "tickers",
            "exchanges",
            "lei",
            "website",
            "investorWebsite",
            "stateOfIncorporation",
            "stateOfIncorporationDescription",
            "addresses",
            "phone",
            "category",
            "fiscalYearEnd",
        ]
        .into_iter()
        .filter_map(|key| fields.get(key).map(|value| (key.to_owned(), value.clone())))
        .collect::<serde_json::Map<_, _>>();
        if !metadata.is_empty() {
            excerpts.push(crate::research::SourceExcerpt {
                text: Value::Object(metadata).to_string(),
                locator: final_url.map(str::to_owned),
            });
        }
    }
    if action == "sec_companyfacts"
        && let Some(text) = crate::terminal::execution::sec_financial_snapshot(
            evidence,
            crate::collect::TEXT_SLICE_CHARS,
        )
    {
        return vec![crate::research::SourceExcerpt {
            text,
            locator: final_url.map(str::to_owned),
        }];
    }
    excerpts.push(crate::research::SourceExcerpt {
        text: evidence["text_excerpt"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| evidence.to_string())
            .chars()
            .take(crate::collect::TEXT_SLICE_CHARS)
            .collect(),
        locator: final_url.map(str::to_owned),
    });
    excerpts
}

/// One collector invocation with ledger accounting. Shared by the initial
/// Run, follow-up continuations, and automatic research so coverage
/// semantics never diverge.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_single(
    app: &App,
    action: &str,
    args: &Value,
    question: &str,
    contact: Option<&str>,
    sources: &mut Vec<crate::research::SourceRecord>,
    coverage: &mut Vec<crate::research::CoverageRow>,
    frontier: &mut Vec<crate::research::FrontierItem>,
) {
    match crate::collect::run_collector_with(app.pacer(), action, args, contact).await {
        Ok(envelope) => {
            let inspected = if envelope.truncated || action == "sec_companyfacts" {
                crate::research::InspectionScope::SelectedExcerpts
            } else {
                crate::research::InspectionScope::FullReturned
            };
            let source_id = format!("{}:{action}", sources.len());
            let stype = crate::research::action_source_type(action);
            let excerpts =
                collected_excerpts(action, &envelope.evidence, envelope.final_url.as_deref());
            sources.push(crate::research::SourceRecord {
                id: source_id.clone(),
                entity_id: None,
                title: format!("{action} evidence"),
                request_url: Some(envelope.request_url.clone()),
                source_url: envelope.final_url.clone(),
                retrieved_at: Some(envelope.retrieved_at.clone()),
                access_state: envelope.status.access_state(),
                source_type: stype,
                origin: envelope.source.clone(),
                transport_status: envelope.http_status.map(|s| s.to_string()),
                content_sha256: Some(envelope.content_sha256.clone()),
                excerpts,
                inspection_scope: inspected,
                inspection_details: None,
                notes: envelope.notes.join("; "),
            });
            let state = match envelope.status {
                crate::collect::CollectorStatus::Ok => crate::research::CoverageState::Covered,
                crate::collect::CollectorStatus::Empty => {
                    crate::research::CoverageState::BoundedEmpty
                }
                crate::collect::CollectorStatus::Blocked => crate::research::CoverageState::Blocked,
                crate::collect::CollectorStatus::Error => crate::research::CoverageState::Error,
                crate::collect::CollectorStatus::Partial
                | crate::collect::CollectorStatus::Truncated => {
                    crate::research::CoverageState::Partial
                }
            };
            let covered = matches!(
                state,
                crate::research::CoverageState::Covered
                    | crate::research::CoverageState::BoundedEmpty
            );
            let boundary = crate::research::action_boundary(action, args);
            let query_str = args
                .get("query")
                .or_else(|| args.get("url"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            let retrieved = envelope.result_count;
            coverage.push(coverage_row(
                action,
                question,
                state,
                boundary,
                query_str,
                retrieved,
                None,
                envelope
                    .next_cursor
                    .clone()
                    .or_else(|| covered.then(|| "boundary exhausted within depth cap".into())),
                envelope
                    .next_cursor
                    .clone()
                    .map(|cursor| vec![format!("cursor: {cursor}")])
                    .unwrap_or_default(),
            ));
            if let Some(cursor) = envelope.next_cursor {
                frontier.push(crate::research::FrontierItem {
                    question: question.to_owned(),
                    next_action: format!("resume {action} from cursor {cursor}"),
                    reason: format!("{action} has a provider cursor"),
                });
            }
        }
        Err(error) => {
            let error = crate::llm::redact_error(&error.to_string(), app.cfg());
            let boundary = crate::research::action_boundary(action, args);
            coverage.push(coverage_row(
                action,
                question,
                crate::research::CoverageState::Error,
                boundary,
                None,
                None,
                None,
                Some(error.clone()),
                vec![format!("{action} failed: {error}")],
            ));
            frontier.push(crate::research::FrontierItem {
                question: question.to_owned(),
                next_action: format!("retry {action}"),
                reason: format!("{action} failed: {error}"),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sec_identity_survives_a_large_filing_array_before_name_and_website() {
        let evidence = json!({"cik":"0001517413","filings":{"recent":{"accessionNumber":vec!["large filing history";5000]}},"name":"Fastly, Inc.","tickers":["FSLY"],"website":"https://www.fastly.com","addresses":{"business":{"street1":"475 BRANNAN"}}});
        let excerpts = crate::terminal::runner::collected_excerpts(
            "sec_submissions",
            &evidence,
            Some("https://data.sec.gov/submissions/CIK0001517413.json"),
        );
        assert_eq!(excerpts.len(), 2);
        assert!(!excerpts[1].text.contains("www.fastly.com"));
        assert!(excerpts[1].text.chars().count() <= crate::collect::TEXT_SLICE_CHARS);
        let metadata: Value = serde_json::from_str(&excerpts[0].text).unwrap();
        for key in ["cik", "name", "tickers", "website", "addresses"] {
            assert_eq!(metadata[key], evidence[key]);
        }
        assert!(metadata.get("filings").is_none());
        assert!(excerpts[0].text.len() < 6000);
        assert_eq!(excerpts[0].locator, excerpts[1].locator);
        assert_eq!(
            crate::terminal::runner::collected_excerpts("other", &evidence, None).len(),
            1
        );
    }

    /// A failed collector may never read as evidence: a brief that cites a
    /// retrieval that never happened turns an absence into a false claim, so
    /// `run_single` owns one rule on the failure path -- an error coverage row
    /// plus a retry frontier item, and no source record.
    #[tokio::test]
    async fn a_failed_collector_is_an_error_row_and_a_retry_without_evidence() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = crate::Config::for_workspace(dir.path().to_owned());
        let app = crate::Installation::for_config(cfg).unwrap().app();
        // `gleif_search` is planned with a required `query`; without one the
        // collector rejects the invocation before any request is sent.
        let action = "gleif_search";
        let args = json!({});
        let question = "Who owns Acme?";
        let direct = crate::collect::run_collector_with(app.pacer(), action, &args, None)
            .await
            .expect_err("a required-argument failure must reach run_single as an error");
        let expected_reason = crate::llm::redact_error(&direct.to_string(), app.cfg());

        // Seeded ledgers show failure appends instead of replacing the
        // accounting a Run already recorded.
        let mut sources: Vec<crate::research::SourceRecord> = vec![
            serde_json::from_value(json!({"id":"s0","title":"Seeded evidence","access_state":"retrieved","source_type":"official_record","excerpts":[{"text":"Seeded evidence."}],"notes":""}))
                .unwrap(),
        ];
        let mut coverage = vec![coverage_row(
            action,
            question,
            crate::research::CoverageState::Covered,
            "seeded boundary".into(),
            None,
            Some(1),
            None,
            None,
            vec![],
        )];
        let mut frontier = vec![crate::research::FrontierItem {
            question: question.into(),
            next_action: format!("resume {action}"),
            reason: "seeded".into(),
        }];

        run_single(
            &app,
            action,
            &args,
            question,
            None,
            &mut sources,
            &mut coverage,
            &mut frontier,
        )
        .await;

        assert_eq!(
            coverage.len(),
            2,
            "a failed collector must append exactly one coverage row, leaving the seeded row in place"
        );
        assert_eq!(
            coverage[0].state,
            crate::research::CoverageState::Covered,
            "the seeded coverage row must survive a later failure unchanged"
        );
        assert_eq!(
            coverage[1].family, action,
            "the failure row must stay attributed to the action that failed"
        );
        assert_eq!(
            coverage[1].state,
            crate::research::CoverageState::Error,
            "a failed collector must be recorded as an error, never as a covered retrieval"
        );
        assert_eq!(
            coverage[1].stop_reason.as_deref(),
            Some(expected_reason.as_str()),
            "the failure row must carry the redacted collector error as its stop reason"
        );
        assert_eq!(
            frontier.len(),
            2,
            "a failed collector must append exactly one retry item, leaving the seeded item in place"
        );
        assert_eq!(
            frontier[1].next_action,
            format!("retry {action}"),
            "the frontier item must instruct the Run to retry the failed action"
        );
        assert_eq!(
            frontier[1].reason,
            format!("{action} failed: {expected_reason}"),
            "the retry item must carry the same failure reason as the coverage row"
        );
        assert_eq!(
            sources.len(),
            1,
            "a failed collector must not become evidence: no source record may be pushed"
        );
        assert_eq!(
            sources[0].id, "s0",
            "the seeded source must survive a failed collection unchanged"
        );
    }
}
