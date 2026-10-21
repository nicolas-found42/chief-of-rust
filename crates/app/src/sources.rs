//! One Source contract and the Registry that is the only entry point for
//! collection. Query Sources run concurrently; the Registry interleaves their
//! ordered candidate lists round-robin, deduplicates by canonical document
//! identity, then applies per-Source and total limits with Coverage
//! accounting. Proven by in-memory fake Sources at this seam (issue #50); no
//! orchestrator rewiring here — SearXNG/Firecrawl (#51) and the 26 collector
//! actions (#52) migrate onto this contract later.
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
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

/// The Registry's collection result: selected evidence plus one diagnostic
/// row per Source in Registry order.
#[derive(Debug)]
pub struct SourceCollection {
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
        // Duplicate and omitted counts land on the Source whose row dropped.
        let mut seen = HashSet::new();
        let mut selected_per_source = vec![0usize; diagnostics.len()];
        let mut hits = Vec::new();
        for (position, hit) in interleaved {
            if !seen.insert(hit.url.clone()) {
                diagnostics[position].duplicate += 1;
                continue;
            }
            if selected_per_source[position] >= self.limits.per_source_max
                || hits.len() >= self.limits.total_max
            {
                diagnostics[position].omitted += 1;
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
mod contract_tests {
    use super::*;

    #[derive(Clone)]
    struct FakeSource {
        label: &'static str,
        requirement: SourceRequirement,
        query_capable: bool,
        candidates: Vec<SourceCandidate>,
        error: Option<&'static str>,
    }

    impl FakeSource {
        fn query(label: &'static str, candidates: Vec<SourceCandidate>) -> Self {
            Self {
                label,
                requirement: SourceRequirement::Mandatory,
                query_capable: true,
                candidates,
                error: None,
            }
        }

        fn failing(label: &'static str, error: &'static str) -> Self {
            Self {
                label,
                requirement: SourceRequirement::Mandatory,
                query_capable: true,
                candidates: Vec::new(),
                error: Some(error),
            }
        }

        fn unconfigured(label: &'static str, candidates: Vec<SourceCandidate>) -> Self {
            Self {
                label,
                requirement: SourceRequirement::NotConfigured,
                query_capable: true,
                candidates,
                error: None,
            }
        }

        fn blocked(label: &'static str) -> Self {
            Self {
                label,
                requirement: SourceRequirement::BlockedMissingContact,
                query_capable: true,
                candidates: Vec::new(),
                error: None,
            }
        }

        fn retrieval(label: &'static str, candidates: Vec<SourceCandidate>) -> Self {
            Self {
                label,
                requirement: SourceRequirement::Mandatory,
                query_capable: false,
                candidates,
                error: None,
            }
        }
    }

    #[async_trait]
    impl Source for FakeSource {
        fn label(&self) -> &'static str {
            self.label
        }

        fn capabilities(&self) -> &'static [SourceCapability] {
            if self.query_capable {
                &[SourceCapability::Query]
            } else {
                &[SourceCapability::Retrieval]
            }
        }

        fn requirement(&self) -> SourceRequirement {
            self.requirement
        }

        async fn collect(&self, _request: &SourceRequest) -> SourceOutcome {
            if let Some(error) = self.error {
                return SourceOutcome::Failed(error.to_owned());
            }
            SourceOutcome::Candidates(self.candidates.clone())
        }
    }

    fn candidate(url: &str, title: &str, content: &str) -> SourceCandidate {
        SourceCandidate {
            title: title.to_owned(),
            url: url.to_owned(),
            content: content.to_owned(),
        }
    }

    fn query_hit(source: &str, n: usize) -> SourceCandidate {
        candidate(
            &format!("https://example.com/{source}/{n}"),
            &format!("{source} {n}"),
            &format!("Snippet {n} from {source}"),
        )
    }

    fn registry_with(sources: Vec<FakeSource>, limits: SourceLimits) -> SourceRegistry {
        SourceRegistry::new(
            sources
                .into_iter()
                .map(|s| Arc::new(s) as Arc<dyn Source>)
                .collect(),
            limits,
        )
    }

    fn registry(sources: Vec<FakeSource>) -> SourceRegistry {
        registry_with(sources, SourceLimits::default())
    }

    fn query() -> SourceRequest {
        SourceRequest::Query("rust".into())
    }
    fn retrieval_request(action: &str, args: serde_json::Value) -> RetrievalRequest {
        RetrievalRequest {
            action: action.to_owned(),
            args,
        }
    }

    /// Collector bases resolve through process-global env, so the tests
    /// that repoint them at wiremock serialize on this lock. The guard
    /// spans `.await`, so this is an async lock.
    static COLLECTOR_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    fn retrieval_pacer() -> Arc<crate::collect::Pacer> {
        Arc::new(crate::collect::Pacer::system())
    }

    /// One hermetic provider: collectors resolve their base through the
    /// same `CHIEF_COLLECT_*_BASE` seam the integration tests use. The
    /// caller sets the override to the mock URI and removes it afterwards;
    /// no other lib test reads these variables.
    async fn mock_base(env_key: &str) -> wiremock::MockServer {
        let provider = wiremock::MockServer::start().await;
        unsafe { std::env::set_var(format!("CHIEF_COLLECT_{env_key}_BASE"), provider.uri()) };
        provider
    }

    fn unmock_base(env_key: &str) {
        unsafe { std::env::remove_var(format!("CHIEF_COLLECT_{env_key}_BASE")) };
    }

    #[tokio::test]
    async fn retrieval_runs_each_action_once_with_source_labels() {
        let _guard = COLLECTOR_ENV_LOCK.lock().await;
        let provider = mock_base("DNS").await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(
                serde_json::json!({"Status": 0, "Answer": [{"name": "example.com.", "type": 1, "data": "93.184.216.34"}]}),
            ))
            .mount(&provider)
            .await;
        let collection = SourceRegistry::collect_retrieval(
            &retrieval_pacer(),
            None,
            vec![retrieval_request(
                "dns",
                serde_json::json!({"domain": "example.com", "record_type": "A"}),
            )],
        )
        .await
        .expect("retrieval runs the action");
        unmock_base("DNS");
        assert_eq!(collection.runs.len(), 1);
        assert_eq!(collection.runs[0].action, "dns");
        assert_eq!(collection.runs[0].envelope.action, "dns");
        assert_eq!(collection.diagnostics.len(), 1);
        assert_eq!(collection.diagnostics[0].label, "dns");
        assert_eq!(collection.diagnostics[0].status, SourceStatus::Succeeded);
        assert_eq!(collection.diagnostics[0].received, 1);
        assert_eq!(collection.diagnostics[0].invalid, 0);
        assert_eq!(collection.diagnostics[0].empty, 0);
        assert_eq!(collection.diagnostics[0].selected, 1);
    }

    #[tokio::test]
    async fn retrieval_failure_keeps_diagnostics_and_fails() {
        let _guard = COLLECTOR_ENV_LOCK.lock().await;
        let error = SourceRegistry::collect_retrieval(
            &retrieval_pacer(),
            None,
            vec![retrieval_request("gleif_search", serde_json::json!({}))],
        )
        .await
        .expect_err("a missing required argument fails the retrieval");
        let failure = error
            .downcast_ref::<SourceFailure>()
            .expect("failure carries diagnostics");
        assert_eq!(failure.diagnostics.len(), 1);
        assert_eq!(failure.diagnostics[0].label, "gleif_search");
        assert_eq!(failure.diagnostics[0].status, SourceStatus::Failed);
        assert!(failure.diagnostics[0].error.is_some());
        assert!(failure.to_string().contains("gleif_search"));
    }

    #[tokio::test]
    async fn retrieval_blocked_contact_does_not_fail() {
        let collection = SourceRegistry::collect_retrieval(
            &retrieval_pacer(),
            None,
            vec![retrieval_request("sec_tickers", serde_json::json!({}))],
        )
        .await
        .expect("a blocked prerequisite is not a failure");
        assert!(collection.runs.is_empty());
        assert_eq!(collection.diagnostics.len(), 1);
        assert_eq!(collection.diagnostics[0].label, "sec_tickers");
        assert_eq!(collection.diagnostics[0].status, SourceStatus::Blocked);
    }

    #[tokio::test]
    async fn retrieval_not_configured_does_not_fail() {
        let _guard = COLLECTOR_ENV_LOCK.lock().await;
        unsafe { std::env::set_var("CHIEF_COLLECT_GLEIF_BASE", "") };
        let collection = SourceRegistry::collect_retrieval(
            &retrieval_pacer(),
            None,
            vec![retrieval_request(
                "gleif_search",
                serde_json::json!({"query": "Acme", "limit": 1}),
            )],
        )
        .await
        .expect("an unconfigured Source is not a failure");
        unmock_base("GLEIF");
        assert!(collection.runs.is_empty());
        assert_eq!(collection.diagnostics.len(), 1);
        assert_eq!(
            collection.diagnostics[0].status,
            SourceStatus::NotConfigured
        );
    }

    #[tokio::test]
    async fn retrieval_empty_envelope_counts_empty_not_selected() {
        let _guard = COLLECTOR_ENV_LOCK.lock().await;
        let provider = mock_base("GLEIF").await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(
                serde_json::json!({"data": [], "meta": {"pagination": {"total": 0}}}),
            ))
            .mount(&provider)
            .await;
        let collection = SourceRegistry::collect_retrieval(
            &retrieval_pacer(),
            None,
            vec![retrieval_request(
                "gleif_search",
                serde_json::json!({"query": "Acme", "limit": 1}),
            )],
        )
        .await
        .expect("an empty provider response still succeeds");
        unmock_base("GLEIF");
        assert_eq!(collection.runs.len(), 1);
        assert_eq!(collection.diagnostics[0].received, 1);
        assert_eq!(collection.diagnostics[0].empty, 1);
        assert_eq!(collection.diagnostics[0].selected, 0);
    }

    #[tokio::test]
    async fn ordering_and_round_robin_interleave() {
        let collection = registry(vec![
            FakeSource::query(
                "alpha",
                vec![
                    query_hit("alpha", 1),
                    query_hit("alpha", 2),
                    query_hit("alpha", 3),
                ],
            ),
            FakeSource::query("beta", vec![query_hit("beta", 1), query_hit("beta", 2)]),
        ])
        .collect(query())
        .await
        .expect("fakes succeed");
        let urls: Vec<&str> = collection.hits.iter().map(|h| h.url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "https://example.com/alpha/1",
                "https://example.com/beta/1",
                "https://example.com/alpha/2",
                "https://example.com/beta/2",
                "https://example.com/alpha/3",
            ]
        );
        assert_eq!(collection.hits[0].source, "alpha");
        assert_eq!(collection.hits[1].source, "beta");
        let labels: Vec<&str> = collection
            .diagnostics
            .iter()
            .map(|d| d.label.as_str())
            .collect();
        assert_eq!(labels, vec!["alpha", "beta"]);
    }

    #[tokio::test]
    async fn dedupe_strips_fragments_and_keeps_first() {
        let collection = registry(vec![
            FakeSource::query(
                "alpha",
                vec![
                    candidate("https://example.com/x#f1", "X", "Shared snippet"),
                    query_hit("alpha", 2),
                ],
            ),
            FakeSource::query(
                "beta",
                vec![
                    candidate("https://example.com/x#f2", "X copy", "Shared snippet"),
                    query_hit("beta", 2),
                ],
            ),
        ])
        .collect(query())
        .await
        .expect("fakes succeed");
        let urls: Vec<&str> = collection.hits.iter().map(|h| h.url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "https://example.com/x",
                "https://example.com/alpha/2",
                "https://example.com/beta/2",
            ]
        );
        assert_eq!(collection.hits[0].source, "alpha");
        assert_eq!(collection.coverage.duplicates, 1);
        assert_eq!(collection.diagnostics[0].duplicate, 0);
        assert_eq!(collection.diagnostics[1].duplicate, 1);
    }

    #[tokio::test]
    async fn per_source_max_caps_with_omitted() {
        let collection = registry_with(
            vec![FakeSource::query(
                "alpha",
                (1..=5).map(|n| query_hit("alpha", n)).collect(),
            )],
            SourceLimits::clamped(0, 3, 50),
        )
        .collect(query())
        .await
        .expect("fakes succeed");
        assert_eq!(collection.hits.len(), 3);
        assert_eq!(collection.diagnostics[0].selected, 3);
        assert_eq!(collection.diagnostics[0].omitted, 2);
        assert_eq!(collection.coverage.omitted, 2);
    }

    #[tokio::test]
    async fn total_max_caps_across_sources() {
        let collection = registry_with(
            vec![
                FakeSource::query("alpha", (1..=3).map(|n| query_hit("alpha", n)).collect()),
                FakeSource::query("beta", (1..=3).map(|n| query_hit("beta", n)).collect()),
            ],
            SourceLimits::clamped(0, 12, 4),
        )
        .collect(query())
        .await
        .expect("fakes succeed");
        let urls: Vec<&str> = collection.hits.iter().map(|h| h.url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "https://example.com/alpha/1",
                "https://example.com/beta/1",
                "https://example.com/alpha/2",
                "https://example.com/beta/2",
            ]
        );
        assert_eq!(collection.coverage.omitted, 2);
        assert_eq!(collection.diagnostics[0].selected, 2);
        assert_eq!(collection.diagnostics[1].selected, 2);
    }

    #[tokio::test]
    async fn short_count_is_honest_with_gap() {
        let collection = registry(vec![FakeSource::query(
            "alpha",
            (1..=3).map(|n| query_hit("alpha", n)).collect(),
        )])
        .collect(query())
        .await
        .expect("a short Source still succeeds");
        assert_eq!(collection.hits.len(), 3);
        assert_eq!(collection.diagnostics[0].received, 3);
        assert_eq!(collection.diagnostics[0].selected, 3);
        assert_eq!(collection.coverage.selected, 3);
        assert_eq!(
            collection.coverage.gaps,
            vec!["alpha: 3 of 8 minimum results"]
        );
    }

    #[tokio::test]
    async fn empty_source_records_zero_with_gap() {
        let collection = registry(vec![FakeSource::query("alpha", Vec::new())])
            .collect(query())
            .await
            .expect("an empty Source still succeeds");
        assert!(collection.hits.is_empty());
        assert_eq!(collection.diagnostics[0].selected, 0);
        assert_eq!(
            collection.coverage.gaps,
            vec!["alpha: 0 of 8 minimum results"]
        );
    }

    #[tokio::test]
    async fn selection_is_deterministic() {
        let registry = registry(vec![
            FakeSource::query("alpha", (1..=4).map(|n| query_hit("alpha", n)).collect()),
            FakeSource::query("beta", (1..=4).map(|n| query_hit("beta", n)).collect()),
        ]);
        let first = registry.collect(query()).await.expect("fakes succeed");
        let second = registry.collect(query()).await.expect("fakes succeed");
        assert_eq!(first.hits, second.hits);
        let summary = |collection: &SourceCollection| {
            collection
                .diagnostics
                .iter()
                .map(|d| {
                    (
                        d.label.clone(),
                        d.status,
                        d.received,
                        d.invalid,
                        d.empty,
                        d.duplicate,
                        d.omitted,
                        d.truncated,
                        d.selected,
                        d.error.clone(),
                    )
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(summary(&first), summary(&second));
    }

    #[tokio::test]
    async fn diagnostic_accounting() {
        let collection = registry(vec![FakeSource::query(
            "alpha",
            vec![
                candidate("https://example.com/good1", "Good one", "Snippet one"),
                candidate("https://example.com/good2", "Good two", "Snippet two"),
                candidate("javascript:alert(1)", "Bad", "x"),
                candidate("https://example.com/empty", "Empty", "   "),
                candidate("ftp://example.com/file", "Ftp", "x"),
                candidate(
                    "https://example.com/long",
                    &"t".repeat(600),
                    &"y".repeat(7000),
                ),
            ],
        )])
        .collect(query())
        .await
        .expect("fakes succeed");
        let diagnostic = &collection.diagnostics[0];
        assert_eq!(diagnostic.received, 6);
        assert_eq!(diagnostic.invalid, 2);
        assert_eq!(diagnostic.empty, 1);
        assert_eq!(diagnostic.truncated, 1);
        assert_eq!(diagnostic.selected, 3);
        let long = collection
            .hits
            .iter()
            .find(|h| h.url == "https://example.com/long")
            .expect("long row is kept truncated, not dropped");
        assert_eq!(long.title.chars().count(), 500);
        assert_eq!(long.content.chars().count(), 6000);
    }

    #[tokio::test]
    async fn public_web_policy_at_registry_boundary() {
        let collection = registry(vec![FakeSource::query(
            "alpha",
            vec![
                candidate("https://example.com/ok", "Ok", "Snippet"),
                candidate("http://localhost/x", "Local", "Snippet"),
                candidate("http://app.localhost/x", "Local", "Snippet"),
                candidate("http://intranet.local/y", "Local", "Snippet"),
                candidate("https://user@example.com/", "Creds", "Snippet"),
                candidate("https://user:pass@example.com/", "Creds", "Snippet"),
                candidate("ftp://example.com/file", "Ftp", "Snippet"),
                candidate("http://93.184.216.34/", "Public literal", "Snippet"),
                candidate("http://10.0.0.1/", "Private", "Snippet"),
                candidate("http://169.254.169.254/", "Link-local", "Snippet"),
            ],
        )])
        .collect(query())
        .await
        .expect("policy rejects rows, not the Run");
        let urls: Vec<&str> = collection.hits.iter().map(|h| h.url.as_str()).collect();
        assert_eq!(
            urls,
            vec!["https://example.com/ok", "http://93.184.216.34/"]
        );
        assert_eq!(collection.diagnostics[0].received, 10);
        assert_eq!(collection.diagnostics[0].invalid, 8);
        assert_eq!(collection.diagnostics[0].selected, 2);
    }

    #[tokio::test]
    async fn failure_keeps_every_diagnostic_and_fails() {
        let error = registry(vec![
            FakeSource::query("alpha", (1..=3).map(|n| query_hit("alpha", n)).collect()),
            FakeSource::failing("beta", "connection refused"),
        ])
        .collect(query())
        .await
        .expect_err("a mandatory failure fails the Run");
        let failure = error
            .downcast_ref::<SourceFailure>()
            .expect("failure carries diagnostics");
        assert!(failure.to_string().contains("beta: connection refused"));
        assert_eq!(failure.diagnostics.len(), 2);
        assert_eq!(failure.diagnostics[0].status, SourceStatus::Succeeded);
        assert_eq!(failure.diagnostics[0].selected, 3);
        assert_eq!(failure.diagnostics[1].status, SourceStatus::Failed);
        assert_eq!(
            failure.diagnostics[1].error.as_deref(),
            Some("connection refused")
        );
    }

    #[tokio::test]
    async fn not_configured_does_not_fail() {
        let collection = registry(vec![
            FakeSource::query("alpha", (1..=8).map(|n| query_hit("alpha", n)).collect()),
            FakeSource::unconfigured("beta", (1..=3).map(|n| query_hit("beta", n)).collect()),
        ])
        .collect(query())
        .await
        .expect("unconfigured is not a failure");
        assert_eq!(collection.hits.len(), 8);
        assert!(collection.hits.iter().all(|h| h.source == "alpha"));
        assert_eq!(
            collection.diagnostics[1].status,
            SourceStatus::NotConfigured
        );
        assert_eq!(collection.diagnostics[1].error, None);
        assert!(collection.coverage.gaps.is_empty());
    }

    #[tokio::test]
    async fn blocked_contact_does_not_fail() {
        let collection = registry(vec![
            FakeSource::query("alpha", (1..=8).map(|n| query_hit("alpha", n)).collect()),
            FakeSource::blocked("beta"),
        ])
        .collect(query())
        .await
        .expect("a blocked prerequisite is not a failure");
        assert_eq!(collection.hits.len(), 8);
        assert_eq!(collection.diagnostics[1].status, SourceStatus::Blocked);
        assert!(collection.coverage.gaps.is_empty());
    }

    #[tokio::test]
    async fn retrieval_source_below_minimum_has_no_gap() {
        let collection = registry(vec![FakeSource::retrieval(
            "alpha",
            (1..=2).map(|n| query_hit("alpha", n)).collect(),
        )])
        .collect(query())
        .await
        .expect("retrieval Sources succeed short");
        assert_eq!(collection.hits.len(), 2);
        assert!(collection.coverage.gaps.is_empty());
    }

    #[test]
    fn limits_clamp_to_safe_bounds() {
        assert_eq!(
            SourceLimits::clamped(8, 12, 50),
            SourceLimits {
                per_source_min: 8,
                per_source_max: 12,
                total_max: 50,
            }
        );
        assert_eq!(
            SourceLimits::clamped(100, 5, 5000),
            SourceLimits {
                per_source_min: 5,
                per_source_max: 5,
                total_max: 200,
            }
        );
        assert_eq!(
            SourceLimits::clamped(0, 0, 0),
            SourceLimits {
                per_source_min: 0,
                per_source_max: 1,
                total_max: 1,
            }
        );
    }

    /// Overrides enter through the environment (issue #53): unset keeps the
    /// defaults, values outside safe bounds clamp, and every deviation from
    /// a default or requested value is recorded for Run diagnostics.
    #[test]
    fn env_overrides_keep_defaults_clamp_and_record_deviations() {
        let defaults = SourceLimits::default();
        let mut env = std::collections::BTreeMap::new();
        let lookup = |key: &str| env.get(key).map(|v: &&str| (*v).to_string());
        let (limits, notes) = SourceLimits::from_env_map(&lookup);
        assert_eq!(limits, defaults);
        assert!(
            notes.is_empty(),
            "unset overrides record nothing: {notes:?}"
        );

        env.insert("CHIEF_SOURCE_MIN_PER_SOURCE", "10");
        env.insert("CHIEF_SOURCE_MAX_PER_SOURCE", "20");
        env.insert("CHIEF_SOURCE_MAX_TOTAL", "80");
        let lookup = |key: &str| env.get(key).map(|v: &&str| (*v).to_string());
        let (limits, notes) = SourceLimits::from_env_map(&lookup);
        assert_eq!(
            limits,
            SourceLimits {
                per_source_min: 10,
                per_source_max: 20,
                total_max: 80,
            }
        );
        assert!(
            notes.is_empty(),
            "in-bounds overrides record nothing: {notes:?}"
        );

        // Unsafe and unparseable values clamp into bounds; each deviation is
        // named so Run diagnostics can show the effective configuration.
        env.insert("CHIEF_SOURCE_MIN_PER_SOURCE", "0");
        env.insert("CHIEF_SOURCE_MAX_PER_SOURCE", "500");
        env.insert("CHIEF_SOURCE_MAX_TOTAL", "bogus");
        let lookup = |key: &str| env.get(key).map(|v: &&str| (*v).to_string());
        let (limits, notes) = SourceLimits::from_env_map(&lookup);
        assert_eq!(
            limits,
            SourceLimits {
                per_source_min: 0,
                per_source_max: 50,
                total_max: 50,
            }
        );
        assert_eq!(
            notes,
            vec![
                "CHIEF_SOURCE_MAX_PER_SOURCE (per-source maximum) 500 clamped to 50",
                "CHIEF_SOURCE_MAX_TOTAL (total maximum) unparseable, kept default 50",
            ],
            "deviations recorded: {notes:?}"
        );

        // The minimum can never exceed the (clamped) maximum.
        env.insert("CHIEF_SOURCE_MIN_PER_SOURCE", "60");
        env.insert("CHIEF_SOURCE_MAX_TOTAL", "80");
        let lookup = |key: &str| env.get(key).map(|v: &&str| (*v).to_string());
        let (limits, notes) = SourceLimits::from_env_map(&lookup);
        assert_eq!(
            limits,
            SourceLimits {
                per_source_min: 50,
                per_source_max: 50,
                total_max: 80,
            }
        );
        assert!(notes.iter().any(|n| n.contains("clamped to 50")));
    }

    #[test]
    fn canonical_identity_keeps_query_drops_fragment() {
        assert_eq!(
            canonical_identity("https://example.com/a?q=1#frag"),
            "https://example.com/a?q=1"
        );
        assert_eq!(canonical_identity("not a url"), "not a url");
    }
}
