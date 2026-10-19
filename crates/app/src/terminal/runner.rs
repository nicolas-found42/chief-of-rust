//! Shared research runner: the one collector loop and excerpt shaping.
//!
//! Every explicit research Run — person or company, initial or continuation —
//! runs the same loop: gate contact-only collectors, run each planned action,
//! account for it, then synthesize one brief behind the version fence. The
//! loop lives here once; the subject adapters supply their planned actions,
//! their subject-only sources and their synthesis prompt. Collection
//! accounting and excerpt shaping also live here so coverage semantics cannot
//! diverge between the runners.

use crate::terminal::subject::{Brief, FenceStage, Subject, SubjectSpec, SynthesisInputs};
use crate::{App, work::Job};
use serde_json::{Value, json};

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
        && let Some(text) = sec_financial_snapshot(evidence, crate::collect::TEXT_SLICE_CHARS)
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

/// Bound a financial snapshot to the excerpt budget by dropping the oldest
/// entry of the largest unit, then whole concepts; `None` when nothing can be
/// retained within the budget.
pub(crate) fn bound_financial_snapshot(mut snapshot: Value, budget: usize) -> Option<String> {
    let concepts = snapshot.get_mut("concepts")?.as_array_mut()?;
    if concepts.is_empty() {
        return None;
    }
    loop {
        let text = snapshot.to_string();
        if text.chars().count() <= budget {
            return Some(text);
        }
        let concepts = snapshot["concepts"].as_array_mut()?;
        let largest = concepts
            .iter()
            .enumerate()
            .flat_map(|(index, concept)| {
                concept["units"]
                    .as_object()
                    .into_iter()
                    .flat_map(move |units| {
                        units.iter().filter_map(move |(unit, entries)| {
                            let len = entries.as_array()?.len();
                            (len > 2).then_some((index, unit.clone(), len))
                        })
                    })
            })
            .max_by_key(|(_, _, len)| *len);
        if let Some((index, unit, _)) = largest {
            concepts[index]["units"][&unit].as_array_mut()?.pop();
        } else if concepts.len() > 1 {
            concepts.pop();
        } else {
            return None;
        }
    }
}

/// The SEC company-facts excerpt: selected original entries, latest full
/// annual period first when present, then recent distinct periods. Omitted
/// concepts and periods remain gaps in the coverage ledger.
pub(crate) fn sec_financial_snapshot(evidence: &Value, budget: usize) -> Option<String> {
    let facts = evidence["facts"]["us-gaap"].as_object()?;
    let mut concepts = Vec::new();
    let mut malformed = 0usize;
    for name in crate::collect::SEC_FINANCIAL_CONCEPTS {
        let Some(fact) = facts.get(*name) else {
            continue;
        };
        let Some(input_units) = fact["units"].as_object() else {
            malformed += 1;
            continue;
        };
        let mut units = serde_json::Map::new();
        for (unit, values) in input_units {
            let Some(input_entries) = values.as_array() else {
                malformed += 1;
                continue;
            };
            let mut entries = input_entries
                .iter()
                .filter(|entry| {
                    let valid = entry["val"].is_number()
                        && entry["end"].as_str().is_some_and(|end| {
                            chrono::NaiveDate::parse_from_str(end, "%Y-%m-%d").is_ok()
                        });
                    if !valid {
                        malformed += 1;
                    }
                    valid
                })
                .collect::<Vec<_>>();
            if entries.is_empty() {
                continue;
            }
            entries.sort_by_key(|entry| {
                (
                    entry["end"].as_str().unwrap_or_default(),
                    entry["filed"].as_str().unwrap_or_default(),
                    entry["start"].as_str().unwrap_or_default(),
                )
            });
            let annual = entries
                .iter()
                .rev()
                .find(|entry| {
                    entry["form"] == "10-K"
                        && entry["fp"] == "FY"
                        && match (entry["start"].as_str(), entry["end"].as_str()) {
                            (Some(start), Some(end)) => {
                                chrono::NaiveDate::parse_from_str(start, "%Y-%m-%d")
                                    .ok()
                                    .zip(chrono::NaiveDate::parse_from_str(end, "%Y-%m-%d").ok())
                                    .is_some_and(|(start, end)| (end - start).num_days() >= 300)
                            }
                            (None, Some(_)) => true,
                            _ => false,
                        }
                })
                .copied();
            let mut retained = annual.into_iter().collect::<Vec<_>>();
            for entry in entries.into_iter().rev() {
                if !retained
                    .iter()
                    .any(|old| old["end"] == entry["end"] && old["start"] == entry["start"])
                {
                    retained.push(entry);
                }
                if retained.len() >= 5 {
                    break;
                }
            }
            units.insert(unit.clone(), json!(retained));
        }
        if !units.is_empty() {
            concepts.push(json!({"concept":name,"label":fact["label"],"units":units}));
        }
    }
    bound_financial_snapshot(
        json!({"financial_snapshot":true,"cik":evidence["cik"],"entityName":evidence["entityName"],"taxonomy":"us-gaap","concepts":concepts,"omitted_malformed_items":malformed,"selection":"Selected original entries: latest full annual period first when present, then recent distinct periods. Omitted concepts and periods remain gaps."}),
        budget,
    )
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

/// The Run outcome a published brief reports: the ids the operator surfaces
/// link to, and whether the evidence ledger held.
fn brief_summary(spec: &SubjectSpec, brief: &Brief) -> Value {
    let mut output = serde_json::Map::new();
    output.insert("brief_id".to_owned(), json!(brief.id));
    output.insert(spec.id_field.to_owned(), json!(brief.subject_id));
    output.insert("ledger_valid".to_owned(), json!(brief.ledger_check.valid));
    output.insert(
        "url".to_owned(),
        json!(format!(
            "/terminal/{}/{}/briefs/{}",
            spec.profile_path, brief.subject_id, brief.id
        )),
    );
    Value::Object(output)
}

/// One initial research Run: plan, collect, account, synthesize. This is the
/// collector loop, once, for both subjects.
pub async fn run_research<S: Subject>(
    run: &crate::connection::RunScope,
    job: &Job,
    subject: S,
) -> anyhow::Result<Value> {
    let spec = S::KIND.spec();
    // A Run that already published is a no-op: a retry must not collect again
    // or write a second brief. The lookup also finds a brief this Run wrote
    // before the unified record kind existed.
    if let Some(saved) = crate::terminal::subject::brief(run.db(), S::KIND, &job.id).await? {
        let mut summary = serde_json::Map::new();
        summary.insert("brief_id".to_owned(), json!(saved.id));
        summary.insert(spec.id_field.to_owned(), json!(saved.subject_id));
        summary.insert("supported_claims".to_owned(), json!(saved.claims.len()));
        summary.insert("already_saved".to_owned(), json!(true));
        return Ok(Value::Object(summary));
    }
    let current = crate::terminal::subject::load::<S>(run, subject.id())
        .await?
        .ok_or_else(|| anyhow::anyhow!("{} no longer exists", spec.noun))?;
    subject.eligible(&current, None, FenceStage::Research)?;
    let question = subject
        .context()
        .questions
        .first()
        .cloned()
        .unwrap_or_default();
    // Sources only this subject supplies come first: person profile notes are
    // attributed history that must precede everything collected.
    let mut sources = subject.prior_sources();
    let contact = crate::settings::load(run.db())
        .await?
        .research_contact
        .clone();
    let planned = subject.planned_actions(subject.context());
    let mut coverage = Vec::new();
    let mut frontier = Vec::new();
    for (action, args) in &planned {
        if crate::research::CONTACT_ACTIONS.contains(&action.as_str()) && contact.is_none() {
            coverage.push(coverage_row(
                action,
                &question,
                crate::research::CoverageState::Blocked,
                crate::research::action_boundary(action, args),
                None,
                None,
                None,
                Some("operator contact not configured; set it in Settings".into()),
                vec![format!("{action} unattempted without contact")],
            ));
            frontier.push(crate::research::FrontierItem {
                question: question.clone(),
                next_action: format!("set contact, then rerun {action}"),
                reason: format!("{action} blocked: configure the research operator contact"),
            });
            continue;
        }
        run_single(
            run,
            action,
            args,
            &question,
            contact.as_deref(),
            &mut sources,
            &mut coverage,
            &mut frontier,
        )
        .await;
    }
    // Collectors this subject cannot attempt stay visible in coverage so
    // absence cannot hide, but they never run; an excluded collector never
    // becomes evidence. Context sources follow collection, labeled and
    // linked.
    for (action, _) in crate::research::COLLECTOR_ACTIONS
        .iter()
        .filter(|(name, _)| !planned.iter().any(|(a, _)| a == *name))
    {
        coverage.push(coverage_row(
            action,
            &question,
            crate::research::CoverageState::NotApplicable,
            format!("{action} boundary"),
            None,
            None,
            None,
            Some(
                if crate::research::PERSON_EXCLUDED_ACTIONS.contains(action) {
                    spec.excluded_reason.into()
                } else {
                    "no identity anchor resolves parameters for this action".into()
                },
            ),
            Vec::new(),
        ));
    }
    let brief = subject
        .synthesize(
            run,
            SynthesisInputs {
                brief_id: job.id.clone(),
                question,
                sources,
                coverage,
                frontier,
                supersedes: None,
                unproductive_expansions: 0,
                saturated: false,
            },
        )
        .await?;
    Ok(brief_summary(spec, &brief))
}

/// One follow-up continuation Run: resume the recorded provider cursors,
/// merge the new evidence over the retained ledger, and re-synthesize. One
/// bounded batch per Run; saturation is recorded, never claimed as
/// completeness.
pub async fn run_continue<S: Subject>(
    run: &crate::connection::RunScope,
    job: &Job,
    subject: S,
) -> anyhow::Result<Value> {
    let spec = S::KIND.spec();
    let prior: Brief = serde_json::from_value(job.input["prior_brief"].clone())?;
    let resume: Vec<crate::terminal::continuation::ResumeItem> =
        serde_json::from_value(job.input["resume"].clone())?;
    anyhow::ensure!(!resume.is_empty(), "Continuation has no resumable cursors");
    let current = crate::terminal::subject::load::<S>(run, subject.id())
        .await?
        .ok_or_else(|| anyhow::anyhow!("{} no longer exists", spec.noun))?;
    subject.eligible(&current, Some(&prior), FenceStage::Publication)?;
    let stored = crate::terminal::subject::brief(run.db(), S::KIND, &prior.id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("Prior brief no longer exists"))?;
    let context = stored
        .context
        .clone()
        .ok_or_else(|| anyhow::anyhow!("Prior brief predates resumable research"))?;
    let question = stored.question.clone();
    // The superseded brief's context governs the re-synthesis: the Run input
    // captures only the record.
    let subject = subject.with_context(context);
    let contact = crate::settings::load(run.db())
        .await?
        .research_contact
        .clone();
    let mut sources = Vec::new();
    let mut coverage = Vec::new();
    let mut frontier = Vec::new();
    for item in &resume {
        run_single(
            run,
            &item.action,
            &item.args,
            &question,
            contact.as_deref(),
            &mut sources,
            &mut coverage,
            &mut frontier,
        )
        .await;
    }
    let resumed: Vec<&str> = resume.iter().map(|r| r.action.as_str()).collect();
    let (merged_sources, added) =
        crate::terminal::continuation::merge_sources(stored.sources.clone(), sources);
    let mut merged_coverage: Vec<crate::research::CoverageRow> = stored
        .coverage
        .into_iter()
        .filter(|row| !resumed.contains(&row.family.as_str()))
        .collect();
    merged_coverage.extend(coverage);
    let mut merged_frontier: Vec<crate::research::FrontierItem> = stored
        .frontier
        .into_iter()
        .filter(|item| {
            !resumed
                .iter()
                .any(|action| item.next_action.starts_with(&format!("resume {action} ")))
        })
        .collect();
    merged_frontier.extend(frontier);
    let unproductive = if added == 0 {
        stored.unproductive_expansions + 1
    } else {
        0
    };
    let unvisited =
        crate::terminal::continuation::unvisited_saturation_gates(S::KIND, &merged_coverage);
    let saturated = crate::terminal::continuation::saturation_stop(
        added,
        stored.unproductive_expansions,
        &unvisited,
    )
    .is_some();
    let brief = subject
        .synthesize(
            run,
            SynthesisInputs {
                brief_id: job.id.clone(),
                question,
                sources: merged_sources,
                coverage: merged_coverage,
                frontier: merged_frontier,
                supersedes: Some(prior.id.clone()),
                unproductive_expansions: unproductive,
                saturated,
            },
        )
        .await?;
    Ok(brief_summary(spec, &brief))
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

    /// The SEC company-facts excerpt keeps the recent periods it selected and
    /// their original scope; a snapshot that cannot fit the budget yields
    /// nothing rather than an unbounded excerpt.
    #[test]
    fn sec_financial_excerpts_retain_recent_periods_with_original_scope() {
        let entries = (2000..=2026).map(|year| json!({"start":format!("{year}-01-01"),"end":format!("{year}-12-31"),"fy":year,"fp":"FY","form":"10-K","filed":format!("{}-02-01",year+1),"val":year*1000})).collect::<Vec<_>>();
        let evidence = json!({"cik":1517413,"entityName":"Fastly, Inc.","facts":{"us-gaap":{"Revenues":{"label":"Revenues","units":{"USD":entries}}}}});
        let excerpts = crate::terminal::runner::collected_excerpts(
            "sec_companyfacts",
            &evidence,
            Some("https://data.sec.gov/fixture"),
        );
        let recent: Value = serde_json::from_str(&excerpts[0].text).unwrap();
        assert_eq!(recent["concepts"][0]["concept"], "Revenues");
        assert_eq!(recent["entityName"], evidence["entityName"]);
        let values = recent["concepts"][0]["units"]["USD"].as_array().unwrap();
        assert_eq!(values.len(), 5);
        assert_eq!(
            values[0],
            evidence["facts"]["us-gaap"]["Revenues"]["units"]["USD"][26]
        );
        assert_eq!(values[4]["fy"], 2022);
        assert!(
            excerpts
                .iter()
                .all(|excerpt| excerpt.text.chars().count() <= crate::collect::TEXT_SLICE_CHARS)
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
        let run = crate::Installation::for_config(cfg).unwrap().app();
        // `gleif_search` is planned with a required `query`; without one the
        // collector rejects the invocation before any request is sent.
        let action = "gleif_search";
        let args = json!({});
        let question = "Who owns Acme?";
        let direct = crate::collect::run_collector_with(run.pacer(), action, &args, None)
            .await
            .expect_err("a required-argument failure must reach run_single as an error");
        let expected_reason = crate::llm::redact_error(&direct.to_string(), run.cfg());

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
            &run,
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
