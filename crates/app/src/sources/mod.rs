//! One Source contract and the Registry that is the only entry point for
//! collection. Query Sources run concurrently; the Registry interleaves their
//! ordered candidate lists round-robin, deduplicates by canonical document
//! identity, then applies per-Source and total limits with Coverage
//! accounting. Proven by in-memory fake Sources at this seam (issue #50); no
//! orchestrator rewiring here — SearXNG/Firecrawl (#51) and the 26 collector
//! actions (#52) migrate onto this contract later.
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Instant;

/// Bounded snippets: content beyond this is truncated and counted, never
/// dropped. Mirrors the existing search normalization #51 migrates.
const MAX_CONTENT_CHARS: usize = 6000;
const MAX_TITLE_CHARS: usize = 500;

/// Query-result selection bounds. Spec #30 defaults: 8 minimum, 12 maximum
/// per query Source, 50 selected across one Run. Installation overrides clamp
/// to safe bounds (#53 surfaces them).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SourceLimits {
    pub per_source_min: usize,
    pub per_source_max: usize,
    pub total_max: usize,
}

impl Default for SourceLimits {
    fn default() -> Self {
        Self {
            per_source_min: 8,
            per_source_max: 12,
            total_max: 50,
        }
    }
}

impl SourceLimits {
    /// Installation overrides stay inside safe bounds so a misconfigured
    /// installation cannot request unbounded selection or a zero cap.
    pub fn clamped(per_source_min: usize, per_source_max: usize, total_max: usize) -> Self {
        let per_source_max = per_source_max.clamp(1, 50);
        let per_source_min = per_source_min.clamp(0, per_source_max);
        Self {
            per_source_min,
            per_source_max,
            total_max: total_max.clamp(1, 200),
        }
    }

    /// Environment override keys, in the order deviations are reported.
    pub const ENV_KEYS: [(&str, &str); 3] = [
        ("CHIEF_SOURCE_MIN_PER_SOURCE", "per-source minimum"),
        ("CHIEF_SOURCE_MAX_PER_SOURCE", "per-source maximum"),
        ("CHIEF_SOURCE_MAX_TOTAL", "total maximum"),
    ];

    /// Read the installation overrides from a variable map (the process
    /// environment in production, a fixture map in tests). Unset keys keep
    /// the spec defaults; every deviation from a requested or default value
    /// is returned as a note so Run diagnostics can show the effective
    /// configuration instead of silently applying it.
    pub fn from_env_map(env: &dyn Fn(&str) -> Option<String>) -> (Self, Vec<String>) {
        let defaults = Self::default();
        let mut unparseable = Vec::new();
        let mut per_source_min = defaults.per_source_min;
        let mut per_source_max = defaults.per_source_max;
        let mut total_max = defaults.total_max;
        for (key, field) in Self::ENV_KEYS {
            let Some(raw) = env(key).filter(|v| !v.trim().is_empty()) else {
                continue;
            };
            let (target, default) = match key {
                "CHIEF_SOURCE_MIN_PER_SOURCE" => (&mut per_source_min, defaults.per_source_min),
                "CHIEF_SOURCE_MAX_PER_SOURCE" => (&mut per_source_max, defaults.per_source_max),
                _ => (&mut total_max, defaults.total_max),
            };
            match raw.trim().parse::<usize>() {
                Ok(value) => {
                    if value != default {
                        *target = value;
                    }
                }
                Err(_) => unparseable.push(format!(
                    "{key} ({field}) unparseable, kept default {default}"
                )),
            }
        }
        let limits = Self::clamped(per_source_min, per_source_max, total_max);
        let mut notes = Vec::new();
        // A MAX override below the default minimum lowers the effective
        // minimum as a side effect. MIN unset means the loop below would
        // never name that clamp, so it is recorded here on its own.
        if env("CHIEF_SOURCE_MIN_PER_SOURCE")
            .filter(|v| !v.trim().is_empty())
            .is_none()
            && limits.per_source_min != defaults.per_source_min
        {
            notes.push(format!(
                "CHIEF_SOURCE_MIN_PER_SOURCE (per-source minimum) default {} clamped to {} by CHIEF_SOURCE_MAX_PER_SOURCE",
                defaults.per_source_min, limits.per_source_min
            ));
        }
        for (key, field) in Self::ENV_KEYS {
            let Some(raw) = env(key).filter(|v| !v.trim().is_empty()) else {
                continue;
            };
            let requested = match raw.trim().parse::<usize>() {
                Ok(value) => value,
                Err(_) => continue,
            };
            let effective = match key {
                "CHIEF_SOURCE_MIN_PER_SOURCE" => limits.per_source_min,
                "CHIEF_SOURCE_MAX_PER_SOURCE" => limits.per_source_max,
                _ => limits.total_max,
            };
            if requested != effective {
                notes.push(format!(
                    "{key} ({field}) {requested} clamped to {effective}"
                ));
            }
        }
        notes.extend(unparseable);
        (limits, notes)
    }

    /// Process-environment variant of `from_env_map`.
    pub fn from_env() -> (Self, Vec<String>) {
        Self::from_env_map(&|key| std::env::var(key).ok())
    }
}

/// What a Source can do. Query Sources accept free text; retrieval Sources
/// accept a URL or structured lookup. Structured Sources may expose both. The
/// minimum-selected promise applies to query Sources only: a retrieval Source
/// that returns one envelope is complete, not short.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum SourceCapability {
    Query,
    Retrieval,
}

/// Why a Source did not run as a normal mandatory participant. A missing
/// prerequisite is a Coverage fact, never an optional Source.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum SourceRequirement {
    /// A configured Source participates; its failure fails the Run.
    Mandatory,
    /// No credentials or base URL configured: recorded, never a failure.
    NotConfigured,
    /// The approved Terminal contact rule (#30): a missing operator contact
    /// blocks only collectors that declare the contact requirement.
    BlockedMissingContact,
}

/// The typed request a Source executes. Retrieval invocation by action or
/// lookup is #52's design; the skeleton carries the variant so the trait is
/// not re-broken when collectors migrate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SourceRequest {
    Query(String),
    Retrieve(String),
}

/// One normalized candidate. The Registry owns identity, validation, and
/// limits; Sources return candidates in their own best-first order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceCandidate {
    pub title: String,
    pub url: String,
    pub content: String,
}

/// What one Source returned: its candidates in best-first order, or the
/// reason it did not run. A Failed message MUST have credentials removed by
/// the Source before returning; the Registry records it verbatim and the
/// Source is the only party holding its secrets.
#[derive(Debug)]
pub enum SourceOutcome {
    Candidates(Vec<SourceCandidate>),
    NotConfigured,
    BlockedMissingContact,
    Failed(String),
}
/// What one collector action returned behind the Registry: its evidence
/// envelope, or the reason it did not run. `Ran` keeps every envelope
/// including error/blocked/empty ones, so the runner accounts for each
/// action exactly once and retains stage evidence on failure. A Failed
/// message MUST have credentials removed; `run_collector_with` redacts
/// contact echoes before returning, and the Registry records it verbatim.
#[derive(Debug)]
pub enum RetrievalOutcome {
    Ran(Box<crate::collect::CollectorEnvelope>),
    NotConfigured,
    BlockedMissingContact,
    Failed(String),
}

/// One collector action invocation behind the Registry: the stable action
/// name and its structured arguments. No runner calls an action outside
/// this path; the Registry is the single accounting point for collection.
#[derive(Clone, Debug)]
pub struct RetrievalRequest {
    pub action: String,
    pub args: serde_json::Value,
}

/// One collector action's evidence behind the Registry: the action label
/// stays on the run so every Evidence item keeps its Source label.
#[derive(Debug)]
pub struct RetrievalRun {
    pub action: String,
    pub envelope: crate::collect::CollectorEnvelope,
}

/// The retrieval result: one envelope run per requested action plus one
/// diagnostic row per action in request order. Retrieval has no aggregate
/// coverage: a collector action either yields one envelope (counted on its
/// diagnostic row) or fails the Run, and the runners build the Run's
/// per-action coverage rows from the envelopes themselves.
#[derive(Debug)]
pub struct RetrievalCollection {
    pub diagnostics: Vec<SourceDiagnostic>,
    pub runs: Vec<RetrievalRun>,
}

/// Per-Source accounting. Every attempted Source keeps its measured row
/// before the Run fails, so a failure never suppresses another Source's
/// diagnosis. Serialized for Run records; #51 owns the persistence mapping.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceDiagnostic {
    pub label: String,
    pub status: SourceStatus,
    pub received: usize,
    pub invalid: usize,
    pub empty: usize,
    pub duplicate: usize,
    pub omitted: usize,
    pub truncated: usize,
    pub elapsed_ms: u64,
    pub selected: usize,
    pub error: Option<String>,
}

/// Every variant has a writer in `SourceRegistry::collect` today. There is no
/// partial/warning variant: provider-side warnings (e.g. SearXNG unresponsive
/// engines) travel through a side channel on the `QuerySource` itself and are
/// lifted into the legacy `SearchProviderStatus::Warning` after collection, so
/// a search that ran with warnings still records plain `Succeeded` here.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SourceStatus {
    Succeeded,
    Failed,
    NotConfigured,
    Blocked,
}

impl SourceStatus {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Succeeded => "Succeeded",
            Self::Failed => "Failed",
            Self::NotConfigured => "Not configured",
            Self::Blocked => "Blocked",
        }
    }
}

/// One retrieved item of evidence. The Source label stays on the item so
/// provenance is inspectable after normalization.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SelectedSource {
    pub source: &'static str,
    pub title: String,
    pub url: String,
    pub content: String,
}

/// Why a usable query snippet was excluded, so a missing source is a
/// recorded selection outcome rather than evidence of absence (issue #62).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchDropReason {
    ProviderDuplicate,
    CrossProviderDuplicate,
    Limit,
}

impl SearchDropReason {
    /// Explain the recorded selection outcome without treating dropped text
    /// as inspected evidence (issue #62).
    pub fn label(&self) -> &'static str {
        match self {
            Self::ProviderDuplicate => "Within-provider duplicate",
            Self::CrossProviderDuplicate => "Cross-provider duplicate",
            Self::Limit => "Selection limit",
        }
    }
}

/// Excluded usable snippets retain identity and reason, without promoting
/// their discarded content to evidence (issue #62).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DroppedSearchResult {
    pub provider: String,
    pub url: String,
    pub disposition: SearchDropReason,
}

/// Shared selection facts belong to the search call, never one provider (#62).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchSelection {
    pub cross_provider_duplicates: usize,
    pub dropped: Vec<DroppedSearchResult>,
}

/// The Registry's collection result: selected evidence plus one diagnostic
/// row per Source in Registry order.
#[derive(Debug)]
pub struct SourceCollection {
    pub selection: SearchSelection,
    pub diagnostics: Vec<SourceDiagnostic>,
    pub hits: Vec<SelectedSource>,
    pub coverage: SourceCoverage,
}

/// Coverage accounting across the Run: what was retrieved and what remains,
/// so an absence stays visible instead of silently becoming a negative
/// finding. A gap names a query Source that selected fewer than the minimum;
/// the actual count stands and the Registry never pads or invents results.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct SourceCoverage {
    pub received: usize,
    pub invalid: usize,
    pub empty: usize,
    pub duplicates: usize,
    pub selected: usize,
    pub omitted: usize,
    pub truncated: usize,
    #[serde(default)]
    pub gaps: Vec<String>,
    pub sources: Vec<String>,
}

/// The Source contract: one module plus one Registry entry adds a Source
/// with no orchestrator change.
#[async_trait]
pub trait Source: Send + Sync {
    /// Stable label recorded on every selected item and diagnostic row.
    /// Labels are the audit key: they MUST be unique within a Registry.
    fn label(&self) -> &'static str;
    fn capabilities(&self) -> &'static [SourceCapability];
    /// Prerequisite boundary check before any request runs.
    fn requirement(&self) -> SourceRequirement;
    async fn collect(&self, request: &SourceRequest) -> SourceOutcome;
}

/// The fixed compile-time list of Sources and the only entry point for
/// collection. Owns ordering, concurrency, interleaving, deduplication,
/// limits, and Coverage accounting.
pub struct SourceRegistry {
    sources: Vec<Arc<dyn Source>>,
    limits: SourceLimits,
}

impl SourceRegistry {
    pub fn new(sources: Vec<Arc<dyn Source>>, limits: SourceLimits) -> Self {
        debug_assert!(
            {
                let mut seen = HashSet::new();
                sources.iter().all(|s| seen.insert(s.label()))
            },
            "Source labels are the audit key and must be unique within a Registry"
        );
        Self { sources, limits }
    }

    pub fn labels(&self) -> Vec<&'static str> {
        self.sources.iter().map(|s| s.label()).collect()
    }

    /// Run every Source concurrently, interleave round-robin, deduplicate by
    /// canonical document identity, then apply per-Source and total limits. A
    /// configured Source failure fails the Run, but only after every
    /// attempted Source keeps its measured diagnostic.
    pub async fn collect(&self, request: SourceRequest) -> anyhow::Result<SourceCollection> {
        let mut tasks = tokio::task::JoinSet::new();
        for (index, source) in self.sources.iter().enumerate() {
            let source = Arc::clone(source);
            let request = request.clone();
            tasks.spawn(async move {
                match source.requirement() {
                    SourceRequirement::NotConfigured => {
                        (index, source.label(), SourceOutcome::NotConfigured, 0)
                    }
                    SourceRequirement::BlockedMissingContact => (
                        index,
                        source.label(),
                        SourceOutcome::BlockedMissingContact,
                        0,
                    ),
                    SourceRequirement::Mandatory => {
                        let start = Instant::now();
                        let outcome = source.collect(&request).await;
                        (
                            index,
                            source.label(),
                            outcome,
                            start.elapsed().as_millis() as u64,
                        )
                    }
                }
            });
        }
        // JoinSet finishes in completion order; restoring Registry order here
        // makes selection reproducible for the same inputs.
        let mut completed = Vec::with_capacity(self.sources.len());
        while let Some(finished) = tasks.join_next().await {
            let finished = finished.map_err(|e| anyhow::anyhow!("Source task failed: {e}"))?;
            completed.push(finished);
        }
        completed.sort_by_key(|(index, _, _, _)| *index);

        // One diagnostic per Source in Registry order; candidate rows are
        // validated into `kept` for the shared interleave below.
        let mut diagnostics = Vec::with_capacity(completed.len());
        let mut kept: Vec<(usize, Vec<SelectedSource>)> = Vec::new();
        let mut failures: Vec<String> = Vec::new();
        for (position, (index, label, outcome, elapsed_ms)) in completed.into_iter().enumerate() {
            debug_assert_eq!(
                index, position,
                "completed Sources sort back into Registry order"
            );
            let mut diagnostic = SourceDiagnostic {
                label: label.to_owned(),
                status: SourceStatus::Succeeded,
                received: 0,
                invalid: 0,
                empty: 0,
                duplicate: 0,
                omitted: 0,
                truncated: 0,
                elapsed_ms,
                selected: 0,
                error: None,
            };
            match outcome {
                SourceOutcome::NotConfigured => {
                    diagnostic.status = SourceStatus::NotConfigured;
                }
                SourceOutcome::BlockedMissingContact => {
                    diagnostic.status = SourceStatus::Blocked;
                }
                SourceOutcome::Failed(error) => {
                    diagnostic.status = SourceStatus::Failed;
                    failures.push(format!("{label}: {error}"));
                    diagnostic.error = Some(error);
                }
                SourceOutcome::Candidates(candidates) => {
                    diagnostic.received = candidates.len();
                    let mut rows = Vec::with_capacity(candidates.len());
                    for candidate in candidates {
                        if !public_url(&candidate.url) {
                            diagnostic.invalid += 1;
                            continue;
                        }
                        if candidate.content.trim().is_empty() {
                            diagnostic.empty += 1;
                            continue;
                        }
                        diagnostic.truncated +=
                            usize::from(candidate.content.chars().count() > MAX_CONTENT_CHARS);
                        rows.push(SelectedSource {
                            source: label,
                            title: candidate.title.chars().take(MAX_TITLE_CHARS).collect(),
                            url: canonical_identity(&candidate.url),
                            content: candidate.content.chars().take(MAX_CONTENT_CHARS).collect(),
                        });
                    }
                    kept.push((position, rows));
                }
            }
            diagnostics.push(diagnostic);
        }

        // Round-robin before deduplication and limits, so a full first Source
        // cannot crowd the second Source out of every report.
        let mut interleaved: Vec<(usize, SelectedSource)> = Vec::new();
        let depth = kept.iter().map(|(_, rows)| rows.len()).max().unwrap_or(0);
        for i in 0..depth {
            for (position, rows) in &kept {
                if let Some(hit) = rows.get(i) {
                    interleaved.push((*position, hit.clone()));
                }
            }
        }

        // One pass over interleave order is exactly dedupe-then-limit: the
        // first sight of an identity inserts it, so later sights are dups and
        // caps see the same non-dup sequence in the same order either way.
        // Within-provider repeats belong to that provider; cross-provider
        // collisions belong to the call because both providers produced them (#62).
        let mut seen = HashMap::new();
        let mut selection = SearchSelection::default();
        let mut selected_per_source = vec![0usize; diagnostics.len()];
        let mut hits = Vec::new();
        for (position, hit) in interleaved {
            if let Some(first_provider) = seen.get(&hit.url) {
                let disposition = if *first_provider == position {
                    diagnostics[position].duplicate += 1;
                    SearchDropReason::ProviderDuplicate
                } else {
                    selection.cross_provider_duplicates += 1;
                    SearchDropReason::CrossProviderDuplicate
                };
                selection.dropped.push(DroppedSearchResult {
                    provider: hit.source.into(),
                    url: hit.url,
                    disposition,
                });
                continue;
            }
            seen.insert(hit.url.clone(), position);
            if selected_per_source[position] >= self.limits.per_source_max
                || hits.len() >= self.limits.total_max
            {
                diagnostics[position].omitted += 1;
                selection.dropped.push(DroppedSearchResult {
                    provider: hit.source.into(),
                    url: hit.url,
                    disposition: SearchDropReason::Limit,
                });
                continue;
            }
            selected_per_source[position] += 1;
            hits.push(hit);
        }
        for (position, diagnostic) in diagnostics.iter_mut().enumerate() {
            diagnostic.selected = selected_per_source[position];
        }

        let mut coverage = SourceCoverage {
            sources: self.sources.iter().map(|s| s.label().to_owned()).collect(),
            ..Default::default()
        };
        for diagnostic in &diagnostics {
            coverage.received += diagnostic.received;
            coverage.invalid += diagnostic.invalid;
            coverage.empty += diagnostic.empty;
            coverage.duplicates += diagnostic.duplicate;
            coverage.omitted += diagnostic.omitted;
            coverage.truncated += diagnostic.truncated;
        }
        coverage.duplicates += selection.cross_provider_duplicates;
        coverage.selected = hits.len();
        for (source, diagnostic) in self.sources.iter().zip(diagnostics.iter()) {
            if source.capabilities().contains(&SourceCapability::Query)
                && diagnostic.status == SourceStatus::Succeeded
                && diagnostic.selected < self.limits.per_source_min
            {
                coverage.gaps.push(format!(
                    "{}: {} of {} minimum results",
                    source.label(),
                    diagnostic.selected,
                    self.limits.per_source_min
                ));
            }
        }

        if !failures.is_empty() {
            return Err(SourceFailure {
                diagnostics,
                message: format!("Collection incomplete; {}", failures.join("; ")),
            }
            .into());
        }
        Ok(SourceCollection {
            selection,
            diagnostics,
            hits,
            coverage,
        })
    }

    /// Run collector actions through the Registry: the only entry point
    /// runners use for the 26 actions. Each action runs concurrently;
    /// results restore request order so selection is reproducible for the
    /// same inputs. Per-action diagnostics record received/invalid/empty/
    /// duplicate/omitted/truncated counts beside elapsed time and any
    /// redacted error. A configured action failure fails the Run, but only
    /// after every attempted action keeps its measured row. Unconfigured
    /// actions record `Not configured` and a missing operator contact
    /// blocks only contact-declaring actions; neither fails the Run.
    pub async fn collect_retrieval(
        pacer: &Arc<crate::collect::Pacer>,
        contact: Option<&str>,
        requests: Vec<RetrievalRequest>,
    ) -> anyhow::Result<RetrievalCollection> {
        let contact = contact.map(str::to_owned);
        // The 26 collector action names are the audit key: labels MUST be
        // unique within a Registry, so requests resolve to the fixed
        // vocabulary here. Unknown actions fail like a configured Source
        // failure, never silently.
        fn static_action(action: &str) -> Option<&'static str> {
            crate::research::COLLECTOR_ACTIONS
                .iter()
                .find(|(name, _)| *name == action)
                .map(|(name, _)| *name)
        }
        let mut tasks = tokio::task::JoinSet::new();
        for (index, request) in requests.into_iter().enumerate() {
            let pacer = Arc::clone(pacer);
            let contact = contact.clone();
            tasks.spawn(async move {
                // The label rides as an owned String: a known action borrows
                // the fixed vocabulary, an unknown one (LLM/planner input)
                // fails the Run and is carried without leaking for the
                // process lifetime.
                let label = match static_action(&request.action) {
                    Some(label) => label.to_owned(),
                    None => {
                        return (
                            index,
                            request.action.clone(),
                            RetrievalOutcome::Failed(format!(
                                "unknown collector action: {}",
                                request.action
                            )),
                            0,
                        );
                    }
                };
                match crate::collect::collector_requirement(&label, contact.as_deref()) {
                    SourceRequirement::NotConfigured => {
                        (index, label, RetrievalOutcome::NotConfigured, 0)
                    }
                    SourceRequirement::BlockedMissingContact => {
                        (index, label, RetrievalOutcome::BlockedMissingContact, 0)
                    }
                    SourceRequirement::Mandatory => {
                        let start = Instant::now();
                        let outcome = match crate::collect::run_collector_with(
                            &pacer,
                            &label,
                            &request.args,
                            contact.as_deref(),
                        )
                        .await
                        {
                            Ok(envelope) => RetrievalOutcome::Ran(Box::new(envelope)),
                            Err(error) => RetrievalOutcome::Failed(error.to_string()),
                        };
                        (index, label, outcome, start.elapsed().as_millis() as u64)
                    }
                }
            });
        }
        // JoinSet finishes in completion order; restoring request order
        // here makes selection reproducible for the same inputs.
        let mut completed = Vec::new();
        while let Some(finished) = tasks.join_next().await {
            let finished = finished.map_err(|e| anyhow::anyhow!("Source task failed: {e}"))?;
            completed.push(finished);
        }
        completed.sort_by_key(|(index, _, _, _)| *index);
        let mut diagnostics = Vec::with_capacity(completed.len());
        let mut runs = Vec::new();
        let mut failures = Vec::new();
        for (position, (index, label, outcome, elapsed_ms)) in completed.into_iter().enumerate() {
            debug_assert_eq!(
                index, position,
                "completed retrievals sort back into request order"
            );
            let mut diagnostic = SourceDiagnostic {
                label: label.clone(),
                status: SourceStatus::Succeeded,
                received: 0,
                invalid: 0,
                empty: 0,
                duplicate: 0,
                omitted: 0,
                truncated: 0,
                elapsed_ms,
                selected: 0,
                error: None,
            };
            match outcome {
                RetrievalOutcome::NotConfigured => {
                    diagnostic.status = SourceStatus::NotConfigured;
                }
                RetrievalOutcome::BlockedMissingContact => {
                    diagnostic.status = SourceStatus::Blocked;
                }
                RetrievalOutcome::Failed(error) => {
                    diagnostic.status = SourceStatus::Failed;
                    failures.push(format!("{label}: {error}"));
                    diagnostic.error = Some(error);
                }
                RetrievalOutcome::Ran(envelope) => {
                    let envelope = *envelope;
                    diagnostic.received = 1;
                    diagnostic.selected = 1;
                    if envelope.status == crate::collect::CollectorStatus::Empty {
                        diagnostic.empty = 1;
                        diagnostic.selected = 0;
                    }
                    if envelope.status == crate::collect::CollectorStatus::Error {
                        diagnostic.invalid = 1;
                        diagnostic.selected = 0;
                    }
                    diagnostic.truncated = usize::from(envelope.truncated);
                    runs.push(RetrievalRun {
                        action: label,
                        envelope,
                    });
                }
            }
            diagnostics.push(diagnostic);
        }
        if !failures.is_empty() {
            return Err(SourceFailure {
                diagnostics,
                message: format!("Collection incomplete; {}", failures.join("; ")),
            }
            .into());
        }
        Ok(RetrievalCollection { diagnostics, runs })
    }
}

/// A mandatory failure keeps every attempted Source's measured diagnostic
/// row beside the message; the aggregate coverage lives on the successful
/// collection only, so a failure never reports a half-built count.
#[derive(Debug)]
pub struct SourceFailure {
    pub diagnostics: Vec<SourceDiagnostic>,
    message: String,
}

impl std::fmt::Display for SourceFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SourceFailure {}

/// Canonical document identity: fragment variants identify the same retrieved
/// document. Query parameters stay: dropping them could merge distinct
/// articles or searches.
pub fn canonical_identity(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(mut parsed) => {
            parsed.set_fragment(None);
            parsed.to_string()
        }
        Err(_) => url.to_owned(),
    }
}

/// Public-web policy at the Registry boundary: private addresses, local
/// hosts, non-HTTP schemes, and credential-bearing URLs cannot enter
/// Evidence. Sources enforce it too; the Registry never trusts a Source.
fn public_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return false;
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return false;
    }
    match parsed.host() {
        Some(url::Host::Domain(host)) => {
            !(host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local"))
        }
        // An IP literal cannot rebind, so the literal itself is checked.
        // Names are resolved with DNS pinning by the Source before fetching.
        Some(url::Host::Ipv4(ip)) => public_ip(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => public_ip(IpAddr::V6(ip)),
        None => false,
    }
}

// Mirrors integrations::public_ip; #51 consolidates the two when SearXNG and
// Firecrawl migrate onto this contract.
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

#[cfg(test)]
mod tests;
