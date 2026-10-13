//! Meeting Wizard keeps source evidence, drafts and reviewed decisions separately.
use crate::{
    App,
    db::Db,
    store,
    web::{self, Error, escape},
    work,
};
use axum::{
    Router,
    extract::{Form, Path, State},
    response::{Redirect, Response},
    routing::{get, post},
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

const MEETING: &str = "meeting";
const TRANSCRIPT: &str = "transcript";
const ARTIFACT: &str = "meeting_artifact";
const WEEKLY: &str = "meeting_weekly";
const TOMBSTONE: &str = "transcript_tombstone";
#[derive(Clone, Serialize, Deserialize)]
struct TranscriptTombstone {
    source_id: String,
    title: String,
    deleted_at: i64,
}

mod debrief;
mod generation;
mod intake;
mod records;
mod sources;
pub use debrief::{Citation, Debrief, DebriefItem};
pub use generation::execute;
use generation::*;
use intake::*;
pub use intake::{create_record, upload_record};
pub use records::*;
use sources::*;
pub use sources::{enqueue_scheduled, import_calendar_records};

#[derive(Deserialize)]
struct TranscriptInput {
    title: String,
    text: String,
    #[serde(default)]
    meeting_id: String,
}
#[derive(Deserialize)]
struct RevisionInput {
    revision: u64,
}
#[derive(Deserialize)]
struct AssociationInput {
    meeting_id: String,
    revision: u64,
}
#[derive(Deserialize)]
struct StateInput {
    state: String,
    revision: u64,
}
#[derive(Deserialize)]
struct ImportInput {
    #[serde(default)]
    calendar_id: String,
}
#[derive(Deserialize)]
struct DriveImportInput {
    #[serde(default)]
    consent: String,
}
#[derive(Deserialize)]
struct WeeklyInput {
    from: String,
    to: String,
}
#[derive(Deserialize)]
struct ActionReviewInput {
    #[serde(default)]
    selected: String,
}
#[derive(Deserialize)]
struct ReimportInput {
    source_id: String,
}
#[derive(Deserialize)]
struct DeliveryResolutionInput {
    note: String,
    #[serde(default)]
    confirmed: String,
}

pub fn router() -> Router<App> {
    Router::new()
        .route("/meetings", get(index).post(create))
        .route("/meetings/history", get(history))
        .route("/meetings/calendar", post(calendar_import))
        .route("/meetings/weekly", get(weekly).post(generate_weekly))
        .route("/meetings/weekly/{id}", get(weekly_detail))
        .route("/meetings/{id}", get(detail).post(edit))
        .route("/meetings/{id}/state", post(change_state))
        .route("/meetings/{id}/delete", post(delete_meeting))
        .route("/meetings/{id}/brief", post(generate_brief))
        .route("/meetings/{id}/debrief", post(generate_debrief))
        .route(
            "/meetings/{id}/artifacts/{artifact_id}",
            get(artifact_detail),
        )
        .route(
            "/meetings/{id}/artifacts/{artifact_id}/review",
            post(review_artifact),
        )
        .route(
            "/meetings/{id}/artifacts/{artifact_id}/gmail",
            post(draft_gmail),
        )
        .route(
            "/meetings/{id}/artifacts/{artifact_id}/gmail/resolve-absent",
            post(resolve_gmail_absent),
        )
        .route("/transcripts", get(catalog).post(upload))
        .route("/transcripts/drive", post(drive_import))
        .route("/transcripts/allow-reimport", post(allow_reimport))
        .route("/transcripts/{id}", get(transcript_detail))
        .route("/transcripts/{id}/associate", post(associate))
        .route("/transcripts/{id}/delete", post(delete_transcript))
}
