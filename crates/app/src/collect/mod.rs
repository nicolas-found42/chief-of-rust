//! Rust-native public-records collectors behind one evidence envelope.
//!
//! Ports the plugin's 26 collector actions (`research.py` + `extensions.py`)
//! without a subprocess: every action returns a [`CollectorEnvelope`] with
//! request/final URL, retrieval time, HTTP status, content hash, transport
//! status and applicable counts/cursors. Transport honors the public-network
//! perimeter (HTTPS-only, per-request DNS safety, redirect revalidation,
//! credential-bearing URL rejection), per-host pacing and Retry-After.
//!
//! Provider API endpoints are operator-configurable through
//! `CHIEF_COLLECT_<PROVIDER>_BASE` environment overrides (the same seam as
//! `SEARXNG_BASE_URL`): a loopback endpoint is only reachable when it matches
//! a configured provider base, never for arbitrary collected targets.

mod actions;
mod json;
mod transport;
mod web;

#[cfg(test)]
mod tests;

use crate::research::AccessState;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(crate) use actions::{SEC_FINANCIAL_CONCEPTS, normalized_company_name};
pub use actions::{run_collector, run_collector_with};
pub use json::{count_results, json_action, json_action_with};
pub use transport::{
    Clock, Pacer, SystemClock, collector_get, collector_get_with, collector_requirement,
    optional_provider_base, provider_base, validate_target,
};
pub use web::CRAWLER_IDENTITY;
#[allow(unused_imports)]
pub(crate) use web::financial_table_snapshot;

pub const TIMEOUT_SECS: u64 = 18;
pub const MAX_BYTES: usize = 2_000_000;
pub const MAX_REDIRECTS: usize = 5;
pub const TEXT_SLICE_CHARS: usize = 30_000;
pub const LINK_SLICE: usize = 500;
pub const JSON_LD_SLICE: usize = 100;

/// Envelope status. `truncated`/`partial` describe bounded success, never a
/// claim of completeness; `empty` only follows a successful empty response.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CollectorStatus {
    Ok,
    Empty,
    Blocked,
    Error,
    Partial,
    Truncated,
}

impl CollectorStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Empty => "empty",
            Self::Blocked => "blocked",
            Self::Error => "error",
            Self::Partial => "partial",
            Self::Truncated => "truncated",
        }
    }

    pub fn access_state(self) -> AccessState {
        match self {
            Self::Ok => AccessState::Retrieved,
            Self::Empty => AccessState::Empty,
            Self::Blocked => AccessState::Blocked,
            Self::Error => AccessState::Error,
            Self::Partial | Self::Truncated => AccessState::Partial,
        }
    }
}

#[derive(Clone, Debug)]
pub struct RawResponse {
    pub final_url: String,
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
    pub truncated: bool,
    pub retry_after_secs: Option<f64>,
    /// Wall time of the transport itself: pacing waits are recorded
    /// separately by the caller, never folded into this number.
    pub elapsed_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CollectorEnvelope {
    pub action: String,
    pub source: String,
    pub request_url: String,
    pub retrieved_at: String,
    pub http_status: Option<u16>,
    pub final_url: Option<String>,
    pub content_type: Option<String>,
    pub content_sha256: String,
    pub status: CollectorStatus,
    pub truncated: bool,
    pub retry_after_secs: Option<f64>,
    pub evidence: Value,
    #[serde(default)]
    pub result_count: Option<u64>,
    #[serde(default)]
    pub total_result_count: Option<u64>,
    #[serde(default)]
    pub next_cursor: Option<String>,
    /// Transport wall time in milliseconds, measured around the HTTP
    /// request/response. Absent on envelopes built without transport
    /// (synthetic seeds) or read from workspaces written before this field.
    #[serde(default)]
    pub elapsed_ms: Option<u64>,
    #[serde(default)]
    pub limits: Value,
    #[serde(default)]
    pub notes: Vec<String>,
    #[serde(default)]
    pub contact_redacted: bool,
}

pub(super) fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}
