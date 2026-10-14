//! Shared deep-research engine: evidence vocabulary, structural checks, and
//! deterministic arithmetic ported from the company-deep-dive plugin.
//!
//! Both profile adapters (company + person) write into these typed records.
//! The vocabulary is the plugin's `evidence-ledger.schema.json` contract:
//! entities, sources, claims, coverage and frontier with closed value sets.
//! Structural checks here never claim factual support; they only verify that
//! references resolve and recorded invariants hold.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Ledger schema version carried by every persisted research snapshot.
pub const SCHEMA_VERSION: u64 = 1;

/// The 26 plugin collector actions, grouped by owning source family.
pub const COLLECTOR_ACTIONS: [(&str, &str); 26] = [
    ("fetch_url", "web"),
    ("discover_site", "web"),
    ("wayback", "web"),
    ("sec_tickers", "official"),
    ("sec_submissions", "official"),
    ("sec_companyfacts", "official"),
    ("sec_companyconcept", "official"),
    ("gleif_search", "official"),
    ("wikidata_search", "official"),
    ("wikidata_entity", "official"),
    ("rdap", "signals"),
    ("dns", "signals"),
    ("crtsh", "signals"),
    ("github_search", "signals"),
    ("hackernews_search", "signals"),
    ("stackexchange_search", "signals"),
    ("gdelt_news", "signals"),
    ("lever_jobs", "signals"),
    ("greenhouse_jobs", "signals"),
    ("greenhouse_job", "signals"),
    ("crossref_search", "sector"),
    ("europepmc_search", "sector"),
    ("clinicaltrials_search", "sector"),
    ("openfda_search", "sector"),
    ("ror_search", "sector"),
    ("usaspending_search", "official"),
];

/// Collector actions that require a configured operator contact before any
/// network access. Mirrors the plugin's `CONTACT_ACTIONS`.
pub const CONTACT_ACTIONS: [&str; 7] = [
    "sec_tickers",
    "sec_submissions",
    "sec_companyfacts",
    "sec_companyconcept",
    "wikidata_search",
    "wikidata_entity",
    "crossref_search",
];

/// Person research never runs organization-scoped collectors as personal
/// evidence. These stay attributed to their organizations, and may only
/// appear as explicitly linked affiliation context.
pub const PERSON_EXCLUDED_ACTIONS: [&str; 11] = [
    "sec_tickers",
    "sec_submissions",
    "sec_companyfacts",
    "sec_companyconcept",
    "gleif_search",
    "usaspending_search",
    "lever_jobs",
    "greenhouse_jobs",
    "greenhouse_job",
    "openfda_search",
    "rdap",
];

/// How a source was reached. Every value has a writer in `collect.rs`:
/// collectors set these from actual HTTP outcomes, never from plans.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessState {
    Retrieved,
    Empty,
    Blocked,
    Error,
    Partial,
    SnippetOnly,
    NotSearched,
    Skipped,
    NotApplicable,
}

impl AccessState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Retrieved => "retrieved",
            Self::Empty => "empty",
            Self::Blocked => "blocked",
            Self::Error => "error",
            Self::Partial => "partial",
            Self::SnippetOnly => "snippet_only",
            Self::NotSearched => "not_searched",
            Self::Skipped => "skipped",
            Self::NotApplicable => "not_applicable",
        }
    }
}

/// What the host actually inspected, recorded independently of retrieval.
/// A fetched page is not necessarily inspected evidence.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InspectionScope {
    FullReturned,
    SelectedExcerpts,
    MetadataOnly,
    #[default]
    NotInspected,
}

impl InspectionScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FullReturned => "full_returned",
            Self::SelectedExcerpts => "selected_excerpts",
            Self::MetadataOnly => "metadata_only",
            Self::NotInspected => "not_inspected",
        }
    }
}

/// Claim support vocabulary. Uncertainty is never flattened into a score.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaimStatus {
    Supported,
    SelfReported,
    Inference,
    UserContext,
    Unsupported,
    Contradicted,
    Unresolved,
}

impl ClaimStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Supported => "supported",
            Self::SelfReported => "self_reported",
            Self::Inference => "inference",
            Self::UserContext => "user_context",
            Self::Unsupported => "unsupported",
            Self::Contradicted => "contradicted",
            Self::Unresolved => "unresolved",
        }
    }
}

/// Coverage state per family/question row. Derives from actual work and
/// reasoned applicability, not from planned requests.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoverageState {
    Covered,
    BoundedEmpty,
    Partial,
    Blocked,
    Error,
    NotSearched,
    Skipped,
    NotApplicable,
}

impl CoverageState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Covered => "covered",
            Self::BoundedEmpty => "bounded_empty",
            Self::Partial => "partial",
            Self::Blocked => "blocked",
            Self::Error => "error",
            Self::NotSearched => "not_searched",
            Self::Skipped => "skipped",
            Self::NotApplicable => "not_applicable",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceType {
    OfficialDisclosure,
    OfficialRecord,
    IndependentReporting,
    Research,
    Community,
    UserContext,
    Internal,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResearchContext {
    pub subject: String,
    pub subject_kind: String,
    pub research_date: String,
    pub as_of_date: Option<String>,
    #[serde(default = "default_depth")]
    pub depth: String,
    #[serde(default = "default_presentation")]
    pub presentation: String,
    #[serde(default)]
    pub geography: String,
    #[serde(default)]
    pub questions: Vec<String>,
    #[serde(default)]
    pub history: String,
    #[serde(default)]
    pub offering: Option<String>,
    #[serde(default)]
    pub internal_sources: Vec<InternalSourceStatus>,
}

fn default_depth() -> String {
    "deep".into()
}
fn default_presentation() -> String {
    "short".into()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InternalSourceStatus {
    pub name: String,
    pub status: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EntityRelationship {
    pub entity_id: String,
    pub relationship: String,
    #[serde(default)]
    pub effective_date: Option<String>,
    #[serde(default)]
    pub source_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EntityRecord {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default)]
    pub jurisdiction: Option<String>,
    pub identity_status: String,
    #[serde(default)]
    pub identifiers: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default)]
    pub relationships: Vec<EntityRelationship>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SourceExcerpt {
    pub text: String,
    #[serde(default)]
    pub locator: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SourceRecord {
    pub id: String,
    #[serde(default)]
    pub entity_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub request_url: Option<String>,
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub retrieved_at: Option<String>,
    pub access_state: AccessState,
    pub source_type: SourceType,
    #[serde(default)]
    pub origin: String,
    #[serde(default)]
    pub transport_status: Option<String>,
    #[serde(default)]
    pub content_sha256: Option<String>,
    #[serde(default)]
    pub excerpts: Vec<SourceExcerpt>,
    #[serde(default)]
    pub inspection_scope: InspectionScope,
    #[serde(default)]
    pub inspection_details: Option<String>,
    #[serde(default)]
    pub notes: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MetricScope {
    #[serde(default)]
    pub period: Option<String>,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default)]
    pub entity_scope: Option<String>,
    #[serde(default)]
    pub basis: Option<String>,
    #[serde(default)]
    pub formula: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ClaimRecord {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub entity_id: Option<String>,
    #[serde(default)]
    pub topic: String,
    pub status: ClaimStatus,
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default)]
    pub contrary_source_ids: Vec<String>,
    #[serde(default)]
    pub metric_scope: Option<MetricScope>,
    #[serde(default)]
    pub explanation: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CoverageRow {
    pub family: String,
    pub question: String,
    pub state: CoverageState,
    #[serde(default)]
    pub applicability: String,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub boundary: String,
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default)]
    pub claim_ids: Vec<String>,
    #[serde(default)]
    pub retrieved_count: Option<u64>,
    #[serde(default)]
    pub total_count: Option<u64>,
    #[serde(default)]
    pub inspected_count: Option<u64>,
    #[serde(default)]
    pub remaining: Vec<String>,
    #[serde(default)]
    pub stop_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FrontierItem {
    pub question: String,
    pub next_action: String,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EvidenceLedger {
    pub schema_version: u64,
    pub context: ResearchContext,
    #[serde(default)]
    pub entities: Vec<EntityRecord>,
    #[serde(default)]
    pub sources: Vec<SourceRecord>,
    #[serde(default)]
    pub claims: Vec<ClaimRecord>,
    #[serde(default)]
    pub coverage: Vec<CoverageRow>,
    #[serde(default)]
    pub frontier: Vec<FrontierItem>,
}

/// One rubric score: 0–3 or unknown. Unknowns are never converted to zero.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RubricScore {
    Rated(u8),
    Unknown,
}

impl RubricScore {
    pub fn parse(value: &Value) -> Option<Self> {
        match value {
            Value::Number(n) => n.as_u64().and_then(|n| {
                if n <= 3 {
                    Some(Self::Rated(n as u8))
                } else {
                    None
                }
            }),
            Value::String(s) if s == "U" => Some(Self::Unknown),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScorecardTotal {
    pub scores: Vec<Value>,
    pub known_subtotal: u64,
    pub rated_criteria: usize,
    pub criteria_count: usize,
    pub possible_total: (u64, u64),
    pub maximum_total: u64,
}

/// Port of the plugin's `scorecard_math.calculate`: exactly three 0–3/U
/// values yield a known subtotal, rated coverage and possible range out of 9.
/// Deterministic arithmetic; it never chooses scores.
pub fn scorecard_total(scores: &[RubricScore]) -> anyhow::Result<ScorecardTotal> {
    anyhow::ensure!(
        scores.len() == 3,
        "exactly three rubric scores are required"
    );
    let mut known = Vec::new();
    let mut encoded = Vec::new();
    for score in scores {
        match score {
            RubricScore::Rated(n) => {
                anyhow::ensure!(*n <= 3, "each score must be an integer 0–3 or U");
                known.push(u64::from(*n));
                encoded.push(Value::from(u64::from(*n)));
            }
            RubricScore::Unknown => encoded.push(Value::from("U")),
        }
    }
    let subtotal: u64 = known.iter().sum();
    let unknowns = 3 - known.len();
    Ok(ScorecardTotal {
        scores: encoded,
        known_subtotal: subtotal,
        rated_criteria: known.len(),
        criteria_count: 3,
        possible_total: (subtotal, subtotal + 3 * unknowns as u64),
        maximum_total: 9,
    })
}

/// Parse a three-score rubric response with strict finite JSON behavior:
/// non-finite numbers are rejected, exactly three entries required.
pub fn parse_scorecard(text: &str) -> anyhow::Result<ScorecardTotal> {
    let value: Value = serde_json::from_str(text)
        .map_err(|e| anyhow::anyhow!("Rubric response was not valid JSON: {e}"))?;
    reject_nonfinite(&value)?;
    let scores = value
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Rubric response must be a three-entry array"))?;
    anyhow::ensure!(
        scores.len() == 3,
        "exactly three rubric scores are required"
    );
    let parsed = scores
        .iter()
        .map(|v| {
            RubricScore::parse(v)
                .ok_or_else(|| anyhow::anyhow!("each score must be an integer 0–3 or U"))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    scorecard_total(&parsed)
}

fn reject_nonfinite(value: &Value) -> anyhow::Result<()> {
    match value {
        Value::Number(n) => {
            anyhow::ensure!(
                n.as_f64().is_some_and(|f| f.is_finite()),
                "Rubric response contains a non-finite number"
            );
            Ok(())
        }
        Value::Array(items) => items.iter().try_for_each(reject_nonfinite),
        Value::Object(map) => map.values().try_for_each(reject_nonfinite),
        _ => Ok(()),
    }
}

#[derive(Clone, Debug, Default)]
pub struct LedgerCheck {
    pub valid: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

/// Port of the plugin's `ledger_check.check`: ID uniqueness, reference
/// resolution, excerpt-requires-inspection and coverage/count invariants.
/// Structure only; factual support needs source review.
pub fn check_ledger(ledger: &EvidenceLedger) -> LedgerCheck {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let mut entity_ids = std::collections::HashSet::new();
    let mut source_ids = std::collections::HashSet::new();
    let mut claim_ids = std::collections::HashSet::new();
    for collection in ["entities", "sources", "claims"] {
        let ids: &[String] = match collection {
            "entities" => &ledger
                .entities
                .iter()
                .map(|e| &e.id)
                .cloned()
                .collect::<Vec<_>>(),
            "sources" => &ledger
                .sources
                .iter()
                .map(|s| &s.id)
                .cloned()
                .collect::<Vec<_>>(),
            _ => &ledger
                .claims
                .iter()
                .map(|c| &c.id)
                .cloned()
                .collect::<Vec<_>>(),
        };
        let target = match collection {
            "entities" => &mut entity_ids,
            "sources" => &mut source_ids,
            _ => &mut claim_ids,
        };
        for id in ids {
            if id.trim().is_empty() {
                errors.push(format!("{collection}: record ID must be nonempty"));
            } else if !target.insert(id.clone()) {
                errors.push(format!("{collection}: duplicate ID {id:?}"));
            }
        }
    }
    let sources: std::collections::HashMap<&str, &SourceRecord> =
        ledger.sources.iter().map(|s| (s.id.as_str(), s)).collect();
    for (index, entity) in ledger.entities.iter().enumerate() {
        let path = format!("entities[{index}]");
        for id in &entity.source_ids {
            if !source_ids.contains(id) {
                errors.push(format!("{path}.source_ids: unknown sources ID {id:?}"));
            }
        }
        for relation in &entity.relationships {
            if !entity_ids.contains(&relation.entity_id) {
                errors.push(format!(
                    "{path}.relationships.entity_id: unknown entities ID {:?}",
                    relation.entity_id
                ));
            }
            for id in &relation.source_ids {
                if !source_ids.contains(id) {
                    errors.push(format!("{path}.relationships: unknown sources ID {id:?}"));
                }
            }
        }
    }
    for (index, source) in ledger.sources.iter().enumerate() {
        let path = format!("sources[{index}]");
        if let Some(entity) = &source.entity_id
            && !entity_ids.contains(entity)
        {
            errors.push(format!("{path}.entity_id: unknown entities ID {entity:?}"));
        }
        for key in ["source_url", "request_url"] {
            let url = match key {
                "source_url" => &source.source_url,
                _ => &source.request_url,
            };
            if let Some(url) = url
                && !public_citation_url(url)
            {
                errors.push(format!(
                    "{path}.{key}: expected an absolute HTTP(S) URL without credentials"
                ));
            }
        }
        if source.inspection_scope == InspectionScope::SelectedExcerpts
            && source
                .inspection_details
                .as_deref()
                .is_none_or(str::is_empty)
        {
            errors.push(format!(
                "{path}: selected excerpts require inspection_details"
            ));
        }
    }
    for (index, claim) in ledger.claims.iter().enumerate() {
        let path = format!("claims[{index}]");
        if let Some(entity) = &claim.entity_id
            && !entity_ids.contains(entity)
        {
            errors.push(format!("{path}.entity_id: unknown entities ID {entity:?}"));
        }
        for id in claim
            .source_ids
            .iter()
            .chain(claim.contrary_source_ids.iter())
        {
            if !source_ids.contains(id) {
                errors.push(format!("{path}: unknown sources ID {id:?}"));
            }
        }
        if matches!(
            claim.status,
            ClaimStatus::Supported | ClaimStatus::SelfReported
        ) {
            if claim.source_ids.is_empty() {
                errors.push(format!(
                    "{path}: supported/self_reported claim needs sources"
                ));
            }
            for id in &claim.source_ids {
                let Some(source) = sources.get(id.as_str()) else {
                    continue;
                };
                if !matches!(
                    source.access_state,
                    AccessState::Retrieved | AccessState::Partial
                ) {
                    errors.push(format!("{path}: {id} has no retrieved support"));
                }
                if !matches!(
                    source.inspection_scope,
                    InspectionScope::FullReturned | InspectionScope::SelectedExcerpts
                ) {
                    errors.push(format!("{path}: {id} has no inspected support"));
                }
                if source.excerpts.is_empty()
                    || source.excerpts.iter().all(|e| e.text.trim().is_empty())
                {
                    errors.push(format!("{path}: {id} has no support excerpt"));
                }
                if source
                    .source_url
                    .as_deref()
                    .is_none_or(|u| !public_citation_url(u))
                {
                    warnings.push(format!(
                        "{path}: {id} has no public citation URL; disclose the limit"
                    ));
                }
            }
        }
    }
    for (index, row) in ledger.coverage.iter().enumerate() {
        let path = format!("coverage[{index}]");
        for id in &row.source_ids {
            if !source_ids.contains(id) {
                errors.push(format!("{path}.source_ids: unknown sources ID {id:?}"));
            }
        }
        for id in &row.claim_ids {
            if !claim_ids.contains(id) {
                errors.push(format!("{path}.claim_ids: unknown claims ID {id:?}"));
            }
        }
        if let (Some(retrieved), Some(total)) = (row.retrieved_count, row.total_count)
            && retrieved > total
        {
            errors.push(format!("{path}: retrieved_count exceeds total_count"));
        }
        if let (Some(inspected), Some(retrieved)) = (row.inspected_count, row.retrieved_count)
            && inspected > retrieved
        {
            errors.push(format!("{path}: inspected_count exceeds retrieved_count"));
        }
        if matches!(
            row.state,
            CoverageState::Covered | CoverageState::BoundedEmpty
        ) {
            if !row.remaining.is_empty()
                || matches!(
                    (row.retrieved_count, row.total_count),
                    (Some(retrieved), Some(total)) if retrieved < total
                )
            {
                errors.push(format!("{path}: completed boundary has remaining work"));
            }
            if row.boundary.trim().is_empty()
                || row
                    .stop_reason
                    .as_deref()
                    .is_none_or(|s| s.trim().is_empty())
            {
                errors.push(format!(
                    "{path}: completed boundary needs boundary and stop_reason"
                ));
            }
        }
        if row.state == CoverageState::BoundedEmpty
            && (!row.claim_ids.is_empty() || !matches!(row.retrieved_count, None | Some(0)))
        {
            errors.push(format!(
                "{path}: bounded_empty cannot contain claims or retrieved records"
            ));
        }
        if row.state == CoverageState::Covered {
            if row.source_ids.is_empty() {
                errors.push(format!("{path}: covered question needs source evidence"));
            } else {
                let usable = row.source_ids.iter().any(|id| {
                    sources.get(id.as_str()).is_some_and(|s| {
                        matches!(
                            s.access_state,
                            AccessState::Retrieved | AccessState::Partial
                        ) && s.inspection_scope != InspectionScope::NotInspected
                    })
                });
                if !usable || row.inspected_count == Some(0) || row.retrieved_count == Some(0) {
                    errors.push(format!(
                        "{path}: covered question needs retrieved and inspected evidence"
                    ));
                }
            }
        }
    }
    LedgerCheck {
        valid: errors.is_empty(),
        errors,
        warnings,
    }
}

/// Absolute HTTP(S) URL without credentials or whitespace. Used for both
/// stored source URLs and brief citation validation.
pub fn public_citation_url(url: &str) -> bool {
    if url.chars().any(char::is_whitespace) {
        return false;
    }
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    matches!(parsed.scheme(), "http" | "https")
        && parsed.host_str().is_some()
        && parsed.username().is_empty()
        && parsed.password().is_none()
}

/// Required brief headings, in template order.
pub const SHORT_BRIEF_HEADINGS: [&str; 10] = [
    "Research context",
    "What the company sells",
    "Who it sells to",
    "Recent developments",
    "Industry context",
    "Intent assessment and scorecards",
    "Next steps",
    "Reference check",
    "Sources",
    "Evidence and coverage appendix",
];

pub const LONG_BRIEF_HEADINGS: [&str; 14] = [
    "Research context",
    "Executive assessment",
    "Entity, ownership and history",
    "What the company sells",
    "Who it sells to",
    "Financial and operating evidence",
    "Recent developments",
    "Industry context",
    "Intent assessment and scorecards",
    "Risks and evidence gaps",
    "Recommended next steps",
    "Reference check",
    "Sources",
    "Evidence and coverage appendix",
];

pub const PERSON_SHORT_BRIEF_HEADINGS: [&str; 10] = [
    "Research context",
    "Professional profile",
    "Professional timeline",
    "Public work and statements",
    "Affiliations and roles",
    "Industry context",
    "Assessment and open questions",
    "Next steps",
    "Reference check",
    "Sources and evidence appendix",
];

pub const PERSON_LONG_BRIEF_HEADINGS: [&str; 12] = [
    "Research context",
    "Professional profile",
    "Professional timeline",
    "Public work and statements",
    "Affiliations and roles",
    "Scholarly and developer outputs",
    "Industry context",
    "Contradictions and adverse records",
    "Assessment and open questions",
    "Next steps",
    "Reference check",
    "Sources and evidence appendix",
];

#[derive(Clone, Debug, Default)]
pub struct BriefCheck {
    pub valid: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub inline_public_links: usize,
}

/// Port of the plugin's `brief_check.check`: required headings exactly once
/// in order (fenced blocks ignored) plus inline URL syntax. Heading
/// structure only; claim support needs source review.
pub fn check_brief(text: &str, headings: &[&str]) -> BriefCheck {
    let actual = brief_headings(text);
    let mut errors = Vec::new();
    for title in headings {
        let count = actual.iter().filter(|h| h == title).count();
        if count != 1 {
            errors.push(format!("heading {title:?}: expected once, found {count}"));
        }
    }
    if actual
        .iter()
        .filter(|h| headings.contains(&h.as_str()))
        .cloned()
        .collect::<Vec<_>>()
        != headings
    {
        errors.push("required headings must appear in template order".into());
    }
    let mut public = 0;
    for url in inline_link_urls(text) {
        if url.starts_with("http:") || url.starts_with("https:") {
            if public_citation_url(&url) {
                public += 1;
            } else {
                errors.push("citation: malformed URL".into());
            }
        }
    }
    let mut warnings = Vec::new();
    if public == 0 {
        warnings.push(
            "no inline public source links found; check source availability and attribution".into(),
        );
    }
    BriefCheck {
        valid: errors.is_empty(),
        errors,
        warnings,
        inline_public_links: public,
    }
}

fn brief_headings(text: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    for line in text.lines() {
        let trimmed = line.trim_start();
        let marker_len = trimmed
            .chars()
            .take_while(|c| *c == '`' || *c == '~')
            .count();
        if marker_len >= 3
            && trimmed[marker_len..].trim().is_empty()
            && trimmed
                .chars()
                .take(marker_len)
                .all(|c| c == '`' || c == '~')
        {
            let marker = trimmed.chars().next().unwrap_or('`');
            match fence {
                None => fence = Some((marker, marker_len)),
                Some((f, len)) if f == marker && marker_len >= len => fence = None,
                _ => {}
            }
            continue;
        }
        if fence.is_none()
            && let Some(title) = line.strip_prefix("## ")
        {
            result.push(title.trim().to_owned());
        }
    }
    result
}

fn inline_link_urls(text: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'['
            && let Some(close) = text[i..].find(']')
            && text[i + close..].starts_with("](")
            && let Some(end) = text[i + close + 2..].find(')')
        {
            let inside = &text[i + close + 2..i + close + 2 + end];
            if let Some(url) = inside.split_whitespace().next()
                && !url.contains('\n')
            {
                urls.push(url.to_owned());
            }
            i += close + 2 + end + 1;
        } else {
            i += 1;
        }
    }
    urls
}

/// SHA-256 hex digest of envelope bytes. Every collector envelope carries one.
pub fn content_hash(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Hash-guarded continuation: a nonzero slice offset requires the expected
/// content hash, and a mismatch restarts rather than mixing slices.
pub fn check_continuation(
    expected_sha256: Option<&str>,
    actual_sha256: &str,
    offsets: &[u64],
) -> anyhow::Result<()> {
    if offsets.iter().any(|o| *o > 0) {
        let expected = expected_sha256.ok_or_else(|| {
            anyhow::anyhow!(
                "expected_sha256 is required for continuation offsets; fetch the first slice to obtain its hash"
            )
        })?;
        anyhow::ensure!(
            expected == actual_sha256,
            "Source content changed between slices; restart from the first slice"
        );
    }
    Ok(())
}

/// Validate an operator contact the way the plugin's contact policy does:
/// one printable-ASCII email, offline syntax only. Never contacts a server.
pub fn validate_operator_contact(value: &str) -> anyhow::Result<String> {
    let invalid = |reason: &str| {
        anyhow::anyhow!(
            "Contact validation failed: {reason}. Set the research operator contact in Settings. The request was not sent."
        )
    };
    if value.trim().is_empty() {
        return Err(invalid("contact is missing"));
    }
    if value.len() > 254 {
        return Err(invalid("contact exceeds 254 characters"));
    }
    if value.bytes().any(|b| !(32..=126).contains(&b)) {
        return Err(invalid("use printable ASCII without control characters"));
    }
    if value.matches('@').count() != 1 {
        return Err(invalid("expected one email address"));
    }
    let (local, domain) = value.split_once('@').unwrap_or(("", ""));
    if local.is_empty()
        || local.len() > 64
        || local.starts_with('.')
        || local.ends_with('.')
        || local.contains("..")
        || !domain.contains('.')
    {
        return Err(invalid("malformed email address"));
    }
    Ok(value.to_owned())
}

/// Redact raw, singly and doubly URL-encoded contact echoes from retained
/// results and errors. Port of the plugin's contact redaction behavior at
/// the boundary the app needs: exact spans, not fuzzy matching.
pub fn redact_contact(text: &str, contact: &str) -> String {
    if contact.is_empty() || !text.contains(contact) && !text.contains("%40") {
        let encoded_once = url_encode(contact);
        if !text.contains(&encoded_once) {
            let encoded_twice = url_encode(&encoded_once);
            if !text.contains(&encoded_twice) {
                return text.to_owned();
            }
        }
    }
    let mut redacted = text.replace(contact, "[contact redacted]");
    let once = url_encode(contact);
    if once != contact {
        redacted = redacted.replace(&once, "[contact redacted]");
        let twice = url_encode(&once);
        if twice != once {
            redacted = redacted.replace(&twice, "[contact redacted]");
        }
    }
    redacted
}

fn url_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Normalize intake context: quick/deep/exhaustive depth and short/long
/// presentation are independent; deep/short are defaults. Exhaustive never
/// promises complete internet knowledge.
pub fn normalize_depth(depth: &str) -> anyhow::Result<String> {
    match depth {
        "quick" | "deep" | "exhaustive" => Ok(depth.into()),
        _ => Err(anyhow::anyhow!("depth must be quick, deep or exhaustive")),
    }
}

pub fn normalize_presentation(presentation: &str) -> anyhow::Result<String> {
    match presentation {
        "short" | "long" => Ok(presentation.into()),
        _ => Err(anyhow::anyhow!("presentation must be short or long")),
    }
}

/// Derive one coverage row from actual collector outcomes. Covered means the
/// recorded question has usable evidence within its boundary — never a claim
/// of universal completeness.
pub fn coverage_from_outcome(
    family: &str,
    question: &str,
    query: Option<String>,
    boundary: String,
    outcomes: &[(String, AccessState, bool)],
    stop_reason: Option<String>,
) -> CoverageRow {
    let retrieved = outcomes
        .iter()
        .filter(|(_, state, _)| {
            matches!(
                state,
                AccessState::Retrieved | AccessState::Partial | AccessState::SnippetOnly
            )
        })
        .count() as u64;
    let inspected = outcomes
        .iter()
        .filter(|(_, _, inspected)| *inspected)
        .count() as u64;
    let has_usable = outcomes.iter().any(|(_, state, inspected)| {
        matches!(
            state,
            AccessState::Retrieved | AccessState::Partial | AccessState::SnippetOnly
        ) && *inspected
    });
    let state = if has_usable {
        CoverageState::Covered
    } else if outcomes.iter().any(|(_, s, _)| *s == AccessState::Blocked) {
        CoverageState::Blocked
    } else if outcomes.iter().any(|(_, s, _)| *s == AccessState::Error) {
        CoverageState::Error
    } else if outcomes
        .iter()
        .all(|(_, s, _)| *s == AccessState::NotApplicable)
        && !outcomes.is_empty()
    {
        CoverageState::NotApplicable
    } else if outcomes.iter().any(|(_, s, _)| *s == AccessState::Empty)
        && outcomes.iter().all(|(_, s, _)| {
            matches!(
                s,
                AccessState::Empty
                    | AccessState::NotApplicable
                    | AccessState::Skipped
                    | AccessState::NotSearched
            )
        })
    {
        CoverageState::BoundedEmpty
    } else if retrieved > 0 || inspected > 0 {
        CoverageState::Partial
    } else {
        CoverageState::NotSearched
    };
    CoverageRow {
        family: family.into(),
        question: question.into(),
        state,
        applicability: String::new(),
        query,
        boundary,
        source_ids: outcomes.iter().map(|(id, _, _)| id.clone()).collect(),
        claim_ids: Vec::new(),
        retrieved_count: Some(retrieved),
        total_count: None,
        inspected_count: Some(inspected),
        remaining: Vec::new(),
        stop_reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(
        id: &str,
        access: AccessState,
        scope: InspectionScope,
        excerpt: &str,
    ) -> SourceRecord {
        SourceRecord {
            id: id.into(),
            entity_id: Some("entity-1".into()),
            title: format!("Source {id}"),
            request_url: Some("https://example.com/source".into()),
            source_url: Some("https://example.com/source".into()),
            retrieved_at: Some("2026-10-14T00:00:00Z".into()),
            access_state: access,
            source_type: SourceType::IndependentReporting,
            origin: "example.com".into(),
            transport_status: None,
            content_sha256: Some(content_hash(b"bytes")),
            excerpts: if excerpt.is_empty() {
                Vec::new()
            } else {
                vec![SourceExcerpt {
                    text: excerpt.into(),
                    locator: Some("p1".into()),
                }]
            },
            inspection_scope: scope,
            inspection_details: if scope == InspectionScope::SelectedExcerpts {
                Some("first two paragraphs inspected".into())
            } else {
                None
            },
            notes: String::new(),
        }
    }

    fn ledger() -> EvidenceLedger {
        EvidenceLedger {
            schema_version: SCHEMA_VERSION,
            context: ResearchContext {
                subject: "Example Co".into(),
                subject_kind: "company".into(),
                research_date: "2026-10-14".into(),
                as_of_date: None,
                depth: "deep".into(),
                presentation: "short".into(),
                geography: String::new(),
                questions: Vec::new(),
                history: "unknown".into(),
                offering: None,
                internal_sources: Vec::new(),
            },
            entities: vec![EntityRecord {
                id: "entity-1".into(),
                name: "Example Co".into(),
                domain: None,
                jurisdiction: None,
                identity_status: "resolved".into(),
                identifiers: Default::default(),
                aliases: Vec::new(),
                source_ids: vec!["source-1".into()],
                relationships: Vec::new(),
            }],
            sources: vec![source(
                "source-1",
                AccessState::Retrieved,
                InspectionScope::FullReturned,
                "Example Co sells widgets.",
            )],
            claims: vec![ClaimRecord {
                id: "claim-1".into(),
                text: "Example Co sells widgets".into(),
                entity_id: Some("entity-1".into()),
                topic: "offering".into(),
                status: ClaimStatus::Supported,
                source_ids: vec!["source-1".into()],
                contrary_source_ids: Vec::new(),
                metric_scope: None,
                explanation: "Direct excerpt.".into(),
            }],
            coverage: vec![CoverageRow {
                family: "site/offerings".into(),
                question: "What does the company sell?".into(),
                state: CoverageState::Covered,
                applicability: String::new(),
                query: None,
                boundary: "official site, October 2026".into(),
                source_ids: vec!["source-1".into()],
                claim_ids: vec!["claim-1".into()],
                retrieved_count: Some(1),
                total_count: None,
                inspected_count: Some(1),
                remaining: Vec::new(),
                stop_reason: Some("official pages reviewed".into()),
            }],
            frontier: Vec::new(),
        }
    }

    #[test]
    fn scorecard_keeps_unknowns_out_of_the_subtotal() {
        let total = parse_scorecard("[2, \"U\", 1]").unwrap();
        assert_eq!(total.known_subtotal, 3);
        assert_eq!(total.rated_criteria, 2);
        assert_eq!(total.possible_total, (3, 6));
        assert_eq!(total.maximum_total, 9);
    }

    #[test]
    fn scorecard_rejects_scores_above_three_and_missing_entries() {
        assert!(parse_scorecard("[4, 1, 1]").is_err());
        assert!(parse_scorecard("[1, 1]").is_err());
        assert!(parse_scorecard("[1, 1, 0]").unwrap().possible_total == (2, 2));
    }

    #[test]
    fn supported_claim_without_inspected_excerpt_fails_the_ledger_check() {
        let mut valid = ledger();
        assert!(check_ledger(&valid).valid);
        valid.sources[0].inspection_scope = InspectionScope::NotInspected;
        let check = check_ledger(&valid);
        assert!(!check.valid);
        assert!(
            check
                .errors
                .iter()
                .any(|e| e.contains("no inspected support"))
        );
    }
}
